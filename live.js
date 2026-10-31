'use strict';

/* Acompanhamento em tempo real: posição na rota, recálculo automático e aprendizado de trechos lentos.
   - Aprende com o seu GPS onde você anda devagar ou para (buraco, lombada, semáforo, trânsito).
   - Você também pode marcar problemas na hora (⚠). Esses trechos "custam mais" nas próximas rotas.
   Usa as globais de app.js e offline.js (carregados no mesmo documento). */

const LC = 0.0003;                                   // célula de ~33 m
const lcKey = (la, lo) => Math.floor(la / LC) + '_' + Math.floor(lo / LC);

let learned = {};                                    // célula -> [amostras, soma das velocidades (m/s), paradas, segundos parado]
let devZones = [];                                   // { id, lat, lon, n, routes, path }: onde a rota sugerida foi ignorada e por onde você foi
let curDev = null;                                   // desvio em andamento
let hazards = [];                                    // { id, lat, lon, type, ts }
let learnOn = true;                                  // usar o aprendizado nas rotas
let learnDirty = false;
let lastFix = null, offSince = 0, lastReroute = 0;
const arrived = new Set();

// Prioridade para evitar (do pior ao menos pior): buraco > semáforo (~60 s parado) > trânsito > depressão/lombada/redutor.
// add = segundos perdidos uma vez no ponto marcado; mult = quanto o trecho de HAZ_SPAN m da mesma via fica mais lento.
const HAZ_SPAN = 200;                                // o problema vale para ~200 m da mesma via, não só para o ponto
const HAZARD = {
  buraco: { icon: '🕳️', label: 'Rua esburacada', add: 90, mult: 5 },
  semaforo: { icon: '🚦', label: 'Semáforo', add: 60, mult: 1 },
  transito: { icon: '🚗', label: 'Trânsito / muito carro', add: 0, mult: 3 },
  depressao: { icon: '〰️', label: 'Depressão transversal / drenagem', add: 12, mult: 1.5 },
  lombada: { icon: '🚧', label: 'Lombada', add: 8, mult: 1.2 },
  redutor: { icon: '🐢', label: 'Redutor de velocidade', add: 8, mult: 1.3 },
};

/* ---------- Persistência ---------- */
async function liveInit() {
  learned = (await DB.get('speedmap')) || {};
  hazards = (await DB.get('hazards')) || [];
  devZones = (await DB.get('devzones')) || [];
  const on = await DB.get('learnOn');
  learnOn = on == null ? true : !!on;
}

async function saveLearned() {
  if (!learnDirty) return;
  learnDirty = false;
  const keys = Object.keys(learned);
  if (keys.length > 30000) for (const k of keys.slice(0, keys.length - 30000)) delete learned[k];   // limita o tamanho
  await DB.set('speedmap', learned);
}

/* ---------- Aprendizado a partir do GPS ---------- */
function nearAnyStop(pt) {
  return session ? routeStops(session.id).some(s => s.lat != null && haversine(pt, s) < 40) : false;
}

function learnFix(p) {
  if (p.coords.accuracy > 40) return;                // GPS ruim: ignora
  const t = p.timestamp || Date.now();
  const pt = { lat: p.coords.latitude, lon: p.coords.longitude, t, stopped: false };
  if (lastFix) {
    const dt = (t - lastFix.t) / 1000;
    if (dt >= 1 && dt <= 20) {
      const v = haversine(lastFix, pt) / dt;
      if (v < 80 / 3.6) {                            // descarta saltos de GPS
        const c = (learned[lcKey(pt.lat, pt.lon)] ||= [0, 0, 0, 0]);
        if (v < 1.4) {                               // parado (< 5 km/h)
          pt.stopped = true;
          if (!nearAnyStop(pt)) {                    // parar para entregar não conta como problema da rua
            if (!lastFix.stopped) c[2]++;
            c[3] += dt;
          }
        } else { c[0]++; c[1] += v; }
        learnDirty = true;
      }
    }
  }
  lastFix = pt;
}

/* ---------- Custos extras nas ruas (usados pelo cálculo de rota do aparelho) ---------- */
const ang = (la1, lo1, la2, lo2) => Math.atan2((lo2 - lo1) * Math.cos(la1 * Math.PI / 180), la2 - la1);
const angDiff = (x, y) => { let d = Math.abs(x - y) % (2 * Math.PI); if (d > Math.PI) d = 2 * Math.PI - d; return d * 180 / Math.PI; };

// Índice de arestas que chegam em cada nó (o grafo só guarda as que saem), para andar na via nos dois sentidos.
function reverseIndex(P) {
  if (P._inOff) return;
  const from = new Int32Array(P.m), cnt = new Int32Array(P.n + 1);
  for (let u = 0; u < P.n; u++) for (let e = P.off[u]; e < P.off[u + 1]; e++) { from[e] = u; cnt[P.to[e] + 1]++; }
  for (let i = 0; i < P.n; i++) cnt[i + 1] += cnt[i];
  const fill = cnt.slice(0, P.n), ins = new Int32Array(P.m);
  for (let e = 0; e < P.m; e++) ins[fill[P.to[e]]++] = e;
  P._eFrom = from; P._inOff = cnt; P._inE = ins;
}

// Vizinhos de um nó, nos dois sentidos: { v, f: aresta x→v (ou -1), b: aresta v→x (ou -1) }.
function neighbours(P, x) {
  const res = new Map();
  for (let e = P.off[x]; e < P.off[x + 1]; e++) res.set(P.to[e], { v: P.to[e], f: e, b: -1 });
  for (let i = P._inOff[x]; i < P._inOff[x + 1]; i++) {
    const e = P._inE[i], w = P._eFrom[e], c = res.get(w);
    if (c) c.b = e; else res.set(w, { v: w, f: -1, b: e });
  }
  return [...res.values()];
}

function nearestEdge(P, la, lo, maxD = 40) {
  const cx = Math.floor(la / CELL), cy = Math.floor(lo / CELL), p = { lat: la, lon: lo };
  let best = null;
  for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
    const list = OFF.grid.get((cx + dx) + '_' + (cy + dy));
    if (!list) continue;
    for (const u of list) for (let e = P.off[u]; e < P.off[u + 1]; e++) {
      const v = P.to[e], s = segDist(p, [P.lat[u], P.lon[u]], [P.lat[v], P.lon[v]]);
      if (s.d < maxD && (!best || s.d < best.d)) best = { d: s.d, e, u, v, t: s.t };
    }
  }
  return best;
}

// Trecho de ~HAZ_SPAN m da MESMA via em volta do ponto marcado: segue pelas arestas que continuam em linha
// reta (curva suave), nos dois sentidos. Devolve aresta -> fração da aresta coberta (as de mão dupla entram nos dois sentidos).
function hazardStretch(P, h) {
  reverseIndex(P);
  const ne = nearestEdge(P, h.lat, h.lon);
  if (!ne) return null;
  const cover = new Map();
  const mark = (c, frac) => { for (const e of [c.f, c.b]) if (e >= 0) cover.set(e, Math.max(cover.get(e) || 0, frac)); };
  const len0 = P.len[ne.e], half = HAZ_SPAN / 2;
  const walk = (from, prev, remain) => {
    for (let guard = 0; remain > 0 && guard < 60; guard++) {
      const inB = ang(P.lat[prev], P.lon[prev], P.lat[from], P.lon[from]);
      let best = null, bd = 40;                                     // só segue se a curva for menor que 40°
      for (const c of neighbours(P, from)) {
        if (c.v === prev) continue;
        const d = angDiff(ang(P.lat[from], P.lon[from], P.lat[c.v], P.lon[c.v]), inB);
        if (d < bd) { bd = d; best = c; }
      }
      if (!best) break;
      const len = distM(P.lat[from], P.lon[from], P.lat[best.v], P.lon[best.v]);
      mark(best, Math.min(1, remain / Math.max(len, 1)));
      remain -= len; prev = from; from = best.v;
    }
  };
  mark({ f: ne.e, b: neighbours(P, ne.u).find(c => c.v === ne.v).b }, Math.min(1, HAZ_SPAN / len0));
  walk(ne.v, ne.u, half - (1 - ne.t) * len0);
  walk(ne.u, ne.v, half - ne.t * len0);
  return { main: ne, cover };
}

// Custo extra por aresta: o multiplicador vale para todo o trecho e a perda fixa (add) só onde foi marcado.
function hazardEdgeCosts(P) {
  const out = new Map();
  const put = (e, mult, add) => { const c = out.get(e) || { mult: 1, add: 0 }; c.mult = Math.max(c.mult, mult); c.add += add; out.set(e, c); };
  for (const h of hazards) {
    const spec = HAZARD[h.type], st = spec && hazardStretch(P, h);
    if (!st) continue;
    for (const [e, frac] of st.cover) put(e, 1 + (spec.mult - 1) * frac, 0);
    const at = neighbours(P, st.main.u).find(c => c.v === st.main.v);      // a perda fixa vale uma vez, em cada sentido
    for (const e of [at.f, at.b]) if (e >= 0) put(e, 1, spec.add);
  }
  return out;
}

/* ---------- Vias favoritas: a sugestão foi ignorada mais de 2 vezes no mesmo ponto ---------- */
const FAV_MIN = 3;                                   // 3 rotas em que você saiu da sugestão no mesmo lugar
const FAV_MULT = 0.7;                                // a via favorita "custa" 30% menos nas próximas rotas
const favZones = () => devZones.filter(z => z.n >= FAV_MIN && z.path && z.path.length > 1);

function devLength() {
  if (!curDev) return 0;
  let d = 0;
  for (let i = curDev.idx + 1; i < track.length; i++) d += haversine({ lat: track[i - 1][0], lon: track[i - 1][1] }, { lat: track[i][0], lon: track[i][1] });
  return d;
}

// Chamado quando a rota sugerida foi deixada por mais de 8 s: guarda de onde saiu e o trecho da sugestão que vinha pela frente.
function startDev(geo, since) {
  if (curDev || !session || !track.length) return;
  let idx = track.findIndex(q => q[2] >= since - 3000);
  if (idx < 0) idx = track.length - 1;
  const nr = nearestOnRoute({ lat: track[idx][0], lon: track[idx][1] }, geo.coords);
  const cum = cumulative(geo.coords), lim = cum[nr.i] + 1500, ahead = [];
  for (let k = nr.i; k < geo.coords.length && cum[k] <= lim; k++) ahead.push(geo.coords[k]);
  curDev = { routeId: session.id, idx, lat: geo.coords[nr.i][0], lon: geo.coords[nr.i][1], ahead };
}

// O desvio termina quando você volta para a rota sugerida (ou depois de 1,5 km, entrega feita ou fim da rota).
function checkDev() {
  if (!curDev) return;
  const len = devLength();
  if (len < 80) return;
  const back = curDev.ahead.length > 1 && me && nearestOnRoute(me, curDev.ahead).d < 40;
  if (back || len > 1500) finishDev();
}

async function finishDev() {
  const d = curDev;
  curDev = null;
  if (!d) return;
  const path = [];
  let len = 0;
  for (const q of track.slice(d.idx)) {
    const last = path[path.length - 1];
    if (last) {
      const step = haversine({ lat: last[0], lon: last[1] }, { lat: q[0], lon: q[1] });
      if (step < 15) continue;
      len += step;
    }
    path.push([q[0], q[1]]);
    if (len > 1500) break;
  }
  if (len < 80) return;                                // movimento curto demais: ruído de GPS
  let z = devZones.find(x => haversine(x, d) < 150);
  if (!z) devZones.push(z = { id: newId(), lat: d.lat, lon: d.lon, n: 0, routes: [], path: null });
  if (!z.routes.includes(d.routeId)) { z.routes.push(d.routeId); z.n++; }
  z.path = path;                                       // vale o caminho mais recente
  await DB.set('devzones', devZones);
  drawLearned();
  if (z.n === FAV_MIN) setStatus('⭐ Você ignorou a sugestão aqui 3 vezes: o seu caminho virou via favorita.', 6000);
}

function favCells() {
  const set = new Set();
  for (const z of favZones()) {
    for (let i = 1; i < z.path.length; i++) {
      const a = z.path[i - 1], b = z.path[i], steps = Math.max(1, Math.ceil(haversine({ lat: a[0], lon: a[1] }, { lat: b[0], lon: b[1] }) / 10));
      for (let k = 0; k <= steps; k++) set.add(lcKey(a[0] + (b[0] - a[0]) * k / steps, a[1] + (b[1] - a[1]) * k / steps));
    }
  }
  return set;
}

const hasLearning = () => learnOn && (hazards.length > 0 || favZones().length > 0 || Object.values(learned).some(c => c[0] >= 3 || c[2] >= 2));

// Calcula, para cada trecho de rua, o quanto ele é mais lento que o normal e quanto tempo se perde nele.
function prepareCosts(P) {
  if (!hasLearning()) { P.cm = null; P.ca = null; return false; }
  const cm = new Float32Array(P.m).fill(1), ca = new Float32Array(P.m);
  const hz = hazardEdgeCosts(P), fav = favCells(), ex = deliveryPoints();
  for (let u = 0; u < P.n; u++) {
    for (let e = P.off[u]; e < P.off[u + 1]; e++) {
      const v = P.to[e], len = P.len[e];
      if (ex.length && nearDelivery(ex, (P.lat[u] + P.lat[v]) / 2, (P.lon[u] + P.lon[v]) / 2)) continue;   // entrega nesta via: não adianta evitar
      const steps = Math.max(1, Math.ceil(len / 15));     // olha o trecho de ~15 em ~15 m (trechos longos passam por várias células)
      const seen = new Set();
      let multSum = 0, add = 0, favHits = 0;
      for (let i = 0; i < steps; i++) {
        const f = (i + 0.5) / steps;
        const k = lcKey(P.lat[u] + (P.lat[v] - P.lat[u]) * f, P.lon[u] + (P.lon[v] - P.lon[u]) * f);
        const c = learned[k];
        if (fav.has(k)) favHits++;
        let mult = 1;
        if (c && c[0] >= 3) mult = Math.min(3, Math.max(1, (P.spd[e] / 3.6) / Math.max(c[1] / c[0], 0.8)));
        multSum += mult;                                  // lentidão média ao longo do trecho
        if (!seen.has(k)) {                               // atraso fixo: uma vez por célula atravessada
          seen.add(k);
          if (c && c[2] >= 2) add += Math.min(60, c[3] / c[2]);   // tempo médio parado por vez (semáforo, lombada, fila)
        }
      }
      const h = hz.get(e);
      cm[e] = Math.max(multSum / steps, h ? h.mult : 1) * (favHits * 2 >= steps ? FAV_MULT : 1);
      ca[e] = add + (h ? h.add : 0);
    }
  }
  P.cm = cm; P.ca = ca;
  return true;
}

/* ---------- Penalidade de uma rota inteira (para escolher entre alternativas do OSRM online) ---------- */
// Segundos a somar à duração prevista: trechos lentos já registrados, problemas marcados a menos de 40 m do caminho
// e desconto nas vias favoritas. Trechos perto de uma entrega não contam (não adianta evitar).
function routePenalty(coords, planV) {
  const ex = deliveryPoints(), fav = favCells(), seenCell = new Set(), seenHaz = new Set();
  let extra = 0;
  for (let k = 0; k + 1 < coords.length; k++) {
    const a = coords[k], b = coords[k + 1], len = haversine({ lat: a[0], lon: a[1] }, { lat: b[0], lon: b[1] });
    const steps = Math.max(1, Math.ceil(len / 20)), seg = len / steps;
    for (let i = 0; i < steps; i++) {
      const f = (i + 0.5) / steps, la = a[0] + (b[0] - a[0]) * f, lo = a[1] + (b[1] - a[1]) * f;
      if (ex.length && nearDelivery(ex, la, lo)) continue;
      const key = lcKey(la, lo), c = learned[key], base = seg / planV;
      if (c && c[0] >= 3) extra += base * (Math.min(3, Math.max(1, planV / Math.max(c[1] / c[0], 0.8))) - 1);
      if (c && c[2] >= 2 && !seenCell.has(key)) extra += Math.min(60, c[3] / c[2]);
      seenCell.add(key);
      if (fav.has(key)) extra -= base * (1 - FAV_MULT);
      hazards.forEach((h, n) => {
        const spec = HAZARD[h.type];
        if (!spec || seenHaz.has(n) || Math.abs(h.lat - la) > 0.0004 || Math.abs(h.lon - lo) > 0.0005 || haversine({ lat: la, lon: lo }, h) > 40) return;
        seenHaz.add(n);
        extra += spec.add + (spec.mult - 1) * HAZ_SPAN / planV;
      });
    }
  }
  return extra;
}

/* ---------- Entrega na via: não se evita uma via onde há entrega ---------- */
const DELIVERY_NEAR = 80;                            // m
const deliveryPoints = () => stops.filter(s => s.routeId === curId && !s.done && s.lat != null);
function nearDelivery(list, la, lo) {
  const dLa = DELIVERY_NEAR / 111320, dLo = DELIVERY_NEAR / (111320 * Math.cos(la * Math.PI / 180));
  for (const s of list) if (Math.abs(s.lat - la) < dLa && Math.abs(s.lon - lo) < dLo) return true;
  return false;
}

/* ---------- Análise em tempo real: via à frente vs tempo médio registrado ---------- */
const AHEAD_M = 1500;                                // quanto da rota à frente é analisado
const SLOW_EXTRA = 60;                               // s a mais que o previsto para considerar a via lenta
const SLOW_RATIO = 1.5;                              // ... e pelo menos 50% mais lenta
let slowNote = '', slowSig = null, lastSlowCheck = 0, lastSlowReroute = 0;

// Soma, ao longo do trecho à frente, o tempo previsto no plano e o tempo médio que você registrou nessas ruas.
function analyzeAhead(geo, near) {
  const cum = cumulative(geo.coords), ex = deliveryPoints();
  const planV = Math.max(geo.distance / Math.max(geo.duration, 1), 1);           // m/s previsto no plano
  const from = cum[near.i], seen = new Set();
  let plan = 0, real = 0, firstKey = null;
  for (let k = near.i; k + 1 < geo.coords.length && cum[k] - from < AHEAD_M; k++) {
    const a = geo.coords[k], b = geo.coords[k + 1], len = cum[k + 1] - cum[k];
    const steps = Math.max(1, Math.ceil(len / 20));
    for (let i = 0; i < steps; i++) {
      const f = (i + 0.5) / steps, la = a[0] + (b[0] - a[0]) * f, lo = a[1] + (b[1] - a[1]) * f;
      if (ex.length && nearDelivery(ex, la, lo)) continue;                         // entrega nesta via: ignora
      const key = lcKey(la, lo), c = learned[key], seg = len / steps;
      plan += seg / planV;
      if (!c || c[0] < 3) { real += seg / planV; continue; }                       // sem histórico: assume o previsto
      real += seg / Math.max(c[1] / c[0], 0.8);
      if (!seen.has(key)) { seen.add(key); if (c[2] >= 2) real += Math.min(60, c[3] / c[2]); }
      if (!firstKey && real - plan > 5) firstKey = key;
    }
  }
  return { plan, real, extra: real - plan, sig: firstKey, slow: real - plan >= SLOW_EXTRA && real >= plan * SLOW_RATIO };
}

function checkAhead(geo, near) {
  if (!learnOn || Date.now() - lastSlowCheck < 10000) return;
  lastSlowCheck = Date.now();
  const a = analyzeAhead(geo, near);
  if (!a.slow) { slowNote = ''; slowSig = null; return; }
  slowNote = ` · ⚠ via lenta à frente: média registrada ${fmtDur(a.real)} (previsto ${fmtDur(a.plan)})`;
  if (a.sig === slowSig || busy || Date.now() - lastSlowReroute < 60000) return;   // já tentou desviar desta; não fica recalculando à toa
  slowSig = a.sig; lastSlowReroute = Date.now();
  setStatus('🐢 Via lenta à frente (+' + fmtDur(a.extra) + ' pela média registrada): procurando alternativa…');
  buildRoute(false);
}

/* ---------- Posição na rota, chegada e recálculo automático ---------- */
function segDist(p, a, b) {
  const k = Math.cos(p.lat * Math.PI / 180), M = 111320;
  const ax = (a[1] - p.lon) * k * M, ay = (a[0] - p.lat) * M, bx = (b[1] - p.lon) * k * M, by = (b[0] - p.lat) * M;
  const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
  const t = L2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / L2)) : 0;
  return { d: Math.hypot(ax + t * dx, ay + t * dy), t };
}

function nearestOnRoute(p, coords) {
  let best = { d: Infinity, i: 0, t: 0 };
  for (let i = 0; i + 1 < coords.length; i++) {
    const s = segDist(p, coords[i], coords[i + 1]);
    if (s.d < best.d) best = { d: s.d, i, t: s.t };
  }
  return best;
}

const cumCache = new WeakMap();
function cumulative(coords) {
  let c = cumCache.get(coords);
  if (!c) {
    c = [0];
    for (let i = 1; i < coords.length; i++) c.push(c[i - 1] + haversine({ lat: coords[i - 1][0], lon: coords[i - 1][1] }, { lat: coords[i][0], lon: coords[i][1] }));
    cumCache.set(coords, c);
  }
  return c;
}

/* ---------- Linha da rota acompanha o trajeto ---------- */
// O que já foi percorrido fica cinza e fino; só o que falta continua laranja, começando na sua posição.
let doneLine = null, lastNear = null;

function clearRouteLine() {
  if (routeLine) { map.removeLayer(routeLine); routeLine = null; }
  if (doneLine) { map.removeLayer(doneLine); doneLine = null; }
}

function trimRouteLine(coords) {
  if (!routeLine || !session || !lastNear || lastNear.coords !== coords || lastNear.d > 70) return;
  const { i, t } = lastNear, a = coords[i], b = coords[i + 1];
  const at = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];       // sua posição projetada na linha
  routeLine.setLatLngs([at, ...coords.slice(i + 1)]);
  const past = [...coords.slice(0, i + 1), at];
  if (!doneLine) doneLine = L.polyline(past, { color: '#98A2B3', weight: 4, opacity: .7, interactive: false }).addTo(map);
  else doneLine.setLatLngs(past);
}

function liveProgress(p) {
  const r = session;
  if (!r || !me) return;

  const kmh = p.coords.speed != null && p.coords.speed >= 0 ? Math.round(p.coords.speed * 3.6) : null;
  $('rbSpeed').textContent = kmh != null ? kmh + ' km/h' : '';

  const nxt = pending().find(s => s.lat != null);
  if (nxt && curId === r.id && haversine(me, nxt) < 35 && !arrived.has(nxt.id)) {
    arrived.add(nxt.id);
    setStatus('📍 Você chegou: toque em ✓ Entregue quando entregar.', 6000);
    if (navigator.vibrate) navigator.vibrate(200);
  }

  const geo = r.geo;
  if (!geo || !geo.coords || geo.coords.length < 2 || curId !== r.id) { $('rbEta').textContent = ''; return; }
  const near = nearestOnRoute(me, geo.coords);
  lastNear = { ...near, coords: geo.coords };
  trimRouteLine(geo.coords);

  // quanto falta (distância e tempo) pelo caminho planejado
  const cum = cumulative(geo.coords), total = cum[cum.length - 1];
  if (total > 0 && near.d < 150) {
    const segLen = cum[near.i + 1] - cum[near.i];
    const left = Math.max(0, total - (cum[near.i] + near.t * segLen));
    const eta = geo.duration * (left / total);
    $('rbEta').textContent = `restam ${fmtDist(left)} · ${fmtDur(eta)} · chega ${fmtTime(Date.now() + eta * 1000)}${slowNote}`;
  } else $('rbEta').textContent = '';

  if (near.d < 70) checkAhead(geo, near);                         // compara a via à frente com o tempo médio registrado

  // saiu do caminho por mais de 8 s: recalcula a partir de onde está
  if (near.d > 70) {
    if (!offSince) offSince = Date.now();
    else {
      if (Date.now() - offSince > 8000) startDev(geo, offSince);      // sugestão ignorada: aprende o caminho que você escolheu
      if (Date.now() - offSince > 8000 && Date.now() - lastReroute > 25000 && !busy) {
        lastReroute = Date.now(); offSince = 0;
        setStatus('↻ Você saiu da rota: recalculando…');
        buildRoute(false);
      }
    }
  } else offSince = 0;
  checkDev();
}

/* ---------- Pontos de atenção no mapa ---------- */
let hazLayer, slowLayer;

function drawLearned() {
  if (!map) return;
  if (!hazLayer) { hazLayer = L.layerGroup().addTo(map); slowLayer = L.layerGroup().addTo(map); }
  hazLayer.clearLayers(); slowLayer.clearLayers();
  for (const h of hazards) {
    const spec = HAZARD[h.type];
    if (!spec) continue;
    L.marker([h.lat, h.lon], { icon: L.divIcon({ className: '', html: `<div class="hz">${spec.icon}</div>`, iconSize: [26, 26], iconAnchor: [13, 13] }) })
      .bindPopup(`<b>${spec.label}</b><br><button data-act="hzdel" data-id="${h.id}">Remover marcação</button>`)
      .addTo(hazLayer);
    const st = packReady() ? hazardStretch(OFF.pack, h) : null;          // mostra os ~200 m da via que o problema afeta
    if (st) for (const e of st.cover.keys()) {
      const P = OFF.pack, u = P._eFrom[e], v = P.to[e];
      L.polyline([[P.lat[u], P.lon[u]], [P.lat[v], P.lon[v]]], { color: '#dc2626', weight: 7, opacity: 0.35, interactive: false }).addTo(hazLayer);
    }
  }
  for (const z of favZones()) {                       // vias favoritas (sugestão ignorada 3 vezes ou mais)
    L.polyline(z.path, { color: '#16a34a', weight: 6, opacity: 0.6 })
      .bindPopup(`<b>⭐ Via favorita</b><br>Você ignorou a sugestão aqui ${z.n} vezes.<br><button data-act="favdel" data-id="${z.id}">Remover favorita</button>`)
      .addTo(hazLayer);
  }
  if (!learnOn) return;
  for (const k in learned) {                          // trechos em que você costuma andar devagar
    const c = learned[k];
    const slow = (c[0] >= 3 && c[1] / c[0] < 3.5) || c[2] >= 2;
    if (!slow) continue;
    const [i, j] = k.split('_').map(Number);
    L.rectangle([[i * LC, j * LC], [(i + 1) * LC, (j + 1) * LC]], { color: '#dc2626', weight: 0, fillOpacity: 0.28, interactive: false }).addTo(slowLayer);
  }
}

async function addHazard(type) {
  const at = me || (map ? { lat: map.getCenter().lat, lon: map.getCenter().lng } : null);
  if (!at) return;
  hazards.push({ id: newId(), lat: at.lat, lon: at.lon, type, ts: Date.now() });
  await DB.set('hazards', hazards);
  drawLearned();
  setStatus(`${HAZARD[type].icon} ${HAZARD[type].label} marcado: as próximas rotas evitam este trecho.`, 5000);
}

async function removeHazard(id) {
  hazards = hazards.filter(h => h.id !== id);
  await DB.set('hazards', hazards);
  map.closePopup();
  drawLearned();
}

async function clearLearned() {
  learned = {}; hazards = []; devZones = []; curDev = null; learnDirty = false;
  await DB.set('speedmap', learned);
  await DB.set('hazards', hazards);
  await DB.set('devzones', devZones);
  drawLearned();
}

async function removeFav(id) {
  devZones = devZones.filter(z => z.id !== id);
  await DB.set('devzones', devZones);
  map.closePopup();
  drawLearned();
}

function learnInfo() {
  const slow = Object.values(learned).filter(c => (c[0] >= 3 && c[1] / c[0] < 3.5) || c[2] >= 2).length;
  return `${slow} trecho(s) lento(s) aprendido(s) · ${hazards.length} marcação(ões) sua(s) · ${favZones().length} via(s) favorita(s).`;
}

function liveBind() {
  const dlg = $('hzDlg');
  $('btnHaz').onclick = () => dlg.showModal();
  $('hzCancel').onclick = () => dlg.close();
  dlg.querySelectorAll('[data-hz]').forEach(b => { b.onclick = () => { dlg.close(); addHazard(b.dataset.hz); }; });
}
