'use strict';

/* Acompanhamento em tempo real: posição na rota, recálculo automático e aprendizado de trechos lentos.
   - Aprende com o seu GPS onde você anda devagar ou para (buraco, lombada, semáforo, trânsito).
   - Você também pode marcar problemas na hora (⚠). Esses trechos "custam mais" nas próximas rotas.
   Usa as globais de app.js e offline.js (carregados no mesmo documento). */

const LC = 0.0003;                                   // célula de ~33 m
const lcKey = (la, lo) => Math.floor(la / LC) + '_' + Math.floor(lo / LC);

let learned = {};                                    // célula -> [amostras, soma das velocidades (m/s), paradas, segundos parado]
let hazards = [];                                    // { id, lat, lon, type, ts }
let learnOn = true;                                  // usar o aprendizado nas rotas
let learnDirty = false;
let lastFix = null, offSince = 0, lastReroute = 0;
const arrived = new Set();

const HAZARD = {
  buraco: { icon: '🕳️', label: 'Rua esburacada', add: 4, mult: 1.8 },
  lombada: { icon: '🚧', label: 'Lombada', add: 6, mult: 1 },
  semaforo: { icon: '🚦', label: 'Semáforo', add: 25, mult: 1 },
  transito: { icon: '🚗', label: 'Trânsito / muito carro', add: 0, mult: 2.5 },
};

/* ---------- Persistência ---------- */
async function liveInit() {
  learned = (await DB.get('speedmap')) || {};
  hazards = (await DB.get('hazards')) || [];
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
function hazardCells() {
  const m = new Map();
  for (const h of hazards) {
    const spec = HAZARD[h.type];
    if (!spec) continue;
    const dLat = 1 / 111320, dLon = 1 / (111320 * Math.cos(h.lat * Math.PI / 180));
    const keys = new Set([lcKey(h.lat, h.lon)]);
    for (let a = 0; a < 8; a++) {                    // cobre ~25 m em volta do ponto marcado
      const ang = a * Math.PI / 4;
      keys.add(lcKey(h.lat + Math.sin(ang) * 25 * dLat, h.lon + Math.cos(ang) * 25 * dLon));
    }
    for (const k of keys) {
      const cur = m.get(k) || { add: 0, mult: 1 };
      m.set(k, { add: cur.add + spec.add, mult: Math.max(cur.mult, spec.mult) });
    }
  }
  return m;
}

const hasLearning = () => learnOn && (hazards.length > 0 || Object.values(learned).some(c => c[0] >= 3 || c[2] >= 2));

// Calcula, para cada trecho de rua, o quanto ele é mais lento que o normal e quanto tempo se perde nele.
function prepareCosts(P) {
  if (!hasLearning()) { P.cm = null; P.ca = null; return false; }
  const cm = new Float32Array(P.m).fill(1), ca = new Float32Array(P.m);
  const hz = hazardCells();
  for (let u = 0; u < P.n; u++) {
    for (let e = P.off[u]; e < P.off[u + 1]; e++) {
      const v = P.to[e], len = P.len[e];
      const steps = Math.max(1, Math.ceil(len / 15));     // olha o trecho de ~15 em ~15 m (trechos longos passam por várias células)
      const seen = new Set();
      let multSum = 0, add = 0;
      for (let i = 0; i < steps; i++) {
        const f = (i + 0.5) / steps;
        const k = lcKey(P.lat[u] + (P.lat[v] - P.lat[u]) * f, P.lon[u] + (P.lon[v] - P.lon[u]) * f);
        const c = learned[k], h = hz.get(k);
        let mult = 1;
        if (c && c[0] >= 3) mult = Math.min(3, Math.max(1, (P.spd[e] / 3.6) / Math.max(c[1] / c[0], 0.8)));
        if (h) mult = Math.max(mult, h.mult);
        multSum += mult;                                  // lentidão média ao longo do trecho
        if (!seen.has(k)) {                               // atraso fixo: uma vez por célula atravessada
          seen.add(k);
          if (c && c[2] >= 2) add += Math.min(60, c[3] / c[2]);   // tempo médio parado por vez (semáforo, lombada, fila)
          if (h) add += h.add;
        }
      }
      cm[e] = multSum / steps;
      ca[e] = add;
    }
  }
  P.cm = cm; P.ca = ca;
  return true;
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

  // quanto falta (distância e tempo) pelo caminho planejado
  const cum = cumulative(geo.coords), total = cum[cum.length - 1];
  if (total > 0 && near.d < 150) {
    const segLen = cum[near.i + 1] - cum[near.i];
    const left = Math.max(0, total - (cum[near.i] + near.t * segLen));
    const eta = geo.duration * (left / total);
    $('rbEta').textContent = `restam ${fmtDist(left)} · ${fmtDur(eta)} · chega ${fmtTime(Date.now() + eta * 1000)}`;
  } else $('rbEta').textContent = '';

  // saiu do caminho por mais de 8 s: recalcula a partir de onde está
  if (near.d > 70) {
    if (!offSince) offSince = Date.now();
    else if (Date.now() - offSince > 8000 && Date.now() - lastReroute > 25000 && !busy) {
      lastReroute = Date.now(); offSince = 0;
      setStatus('↻ Você saiu da rota: recalculando…');
      buildRoute(false);
    }
  } else offSince = 0;
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
  learned = {}; hazards = []; learnDirty = false;
  await DB.set('speedmap', learned);
  await DB.set('hazards', hazards);
  drawLearned();
}

function learnInfo() {
  const slow = Object.values(learned).filter(c => (c[0] >= 3 && c[1] / c[0] < 3.5) || c[2] >= 2).length;
  return `${slow} trecho(s) lento(s) aprendido(s) · ${hazards.length} marcação(ões) sua(s).`;
}

function liveBind() {
  const dlg = $('hzDlg');
  $('btnHaz').onclick = () => dlg.showModal();
  $('hzCancel').onclick = () => dlg.close();
  dlg.querySelectorAll('[data-hz]').forEach(b => { b.onclick = () => { dlg.close(); addHazard(b.dataset.hz); }; });
}
