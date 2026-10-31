'use strict';

/* Pacote offline da região: ruas (para rotear), endereços e bairros (para localizar) e blocos do mapa.
   Baixado uma vez com internet (OpenStreetMap via Overpass) e guardado no aparelho. */

const OFF = { pack: null, grid: null };

/* ---------- Normalização de nomes ---------- */
const TOK = {
  r: 'rua', av: 'avenida', tv: 'travessa', al: 'alameda', pc: 'praca', pca: 'praca', rod: 'rodovia', est: 'estrada',
  dr: 'doutor', dra: 'doutora', prof: 'professor', profa: 'professora', cel: 'coronel', pres: 'presidente',
  eng: 'engenheiro', gov: 'governador', dep: 'deputado', ver: 'vereador', sta: 'santa', sto: 'santo',
  cap: 'capitao', gen: 'general', mal: 'marechal', jd: 'jardim', vl: 'vila', res: 'residencial', pq: 'parque',
};
const TYPE_WORDS = new Set(['rua', 'avenida', 'travessa', 'alameda', 'praca', 'rodovia', 'estrada', 'de', 'da', 'do', 'das', 'dos', 'e']);
const COMPL = /\b(apto?|apt|ap|apartamento|bloco|bl|casa|sala|cj|conjunto|torre)\.?\s*\d+\w*|\bfundos\b/gi;

const norm = s => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
  .replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
const normName = s => norm(s).split(' ').map(t => TOK[t] || t).join(' ');
const distM = (la1, lo1, la2, lo2) => {
  const k = Math.PI / 180, x = (lo2 - lo1) * k * Math.cos((la1 + la2) / 2 * k), y = (la2 - la1) * k;
  return 6371000 * Math.sqrt(x * x + y * y);
};

/* ---------- Download (Overpass) e montagem do pacote ---------- */
const OVERPASS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];

async function overpass(query) {
  let err;
  for (const url of OVERPASS) {
    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 240000);
      const r = await fetch(url, {
        method: 'POST', signal: ctl.signal,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'data=' + encodeURIComponent(query),
      });
      clearTimeout(timer);
      if (!r.ok) throw new Error('Overpass ' + r.status);
      return await r.json();
    } catch (e) { err = e; }
  }
  throw err;
}

const ROAD_SPEED = {
  motorway: 80, trunk: 70, primary: 50, secondary: 45, tertiary: 40, unclassified: 35, residential: 30,
  living_street: 15, service: 20, road: 30,
};
function speedOf(t) {
  const ms = parseInt(t.maxspeed, 10);
  if (ms > 0 && ms <= 120) return ms;
  return ROAD_SPEED[String(t.highway).replace('_link', '')] || 30;
}
function onewayOf(t) {            // 1 = só ida, -1 = só volta, 0 = mão dupla
  if (t.oneway === '-1') return -1;
  if (['yes', '1', 'true'].includes(t.oneway)) return 1;
  if (t.oneway === 'no') return 0;
  if (t.junction === 'roundabout' || String(t.highway).startsWith('motorway')) return 1;
  return 0;
}

function buildPack(roads, extra, bbox) {
  const nodes = new Map(), ways = [];
  for (const el of roads.elements) {
    if (el.type === 'node') nodes.set(el.id, [el.lat, el.lon]);
    else if (el.type === 'way') ways.push(el);
  }
  const idx = new Map(), lat = [], lon = [];
  const getIdx = id => {
    let i = idx.get(id);
    if (i == null) {
      const c = nodes.get(id);
      if (!c) return -1;
      i = lat.length; lat.push(c[0]); lon.push(c[1]); idx.set(id, i);
    }
    return i;
  };

  const eFrom = [], eTo = [], eLen = [], eSpd = [], streets = {};
  for (const w of ways) {
    const t = w.tags || {};
    const spd = speedOf(t), ow = onewayOf(t);
    const ids = w.nodes.map(getIdx).filter(i => i >= 0);
    for (let k = 0; k + 1 < ids.length; k++) {
      const a = ids[k], b = ids[k + 1];
      const len = distM(lat[a], lon[a], lat[b], lon[b]);
      if (ow >= 0) { eFrom.push(a); eTo.push(b); eLen.push(len); eSpd.push(spd); }
      if (ow <= 0) { eFrom.push(b); eTo.push(a); eLen.push(len); eSpd.push(spd); }
    }
    if (t.name && ids.length) {
      const key = normName(t.name), m = ids[ids.length >> 1];
      (streets[key] ||= { name: t.name, pts: [] }).pts.push([lat[m], lon[m]]);
    }
  }

  // grafo em formato CSR (compacto)
  const n = lat.length, m = eFrom.length;
  const off = new Int32Array(n + 1);
  for (const a of eFrom) off[a + 1]++;
  for (let i = 0; i < n; i++) off[i + 1] += off[i];
  const fill = off.slice(0, n), to = new Int32Array(m), len = new Float32Array(m), spd = new Uint8Array(m);
  for (let e = 0; e < m; e++) {
    const p = fill[eFrom[e]]++;
    to[p] = eTo[e]; len[p] = eLen[e]; spd[p] = eSpd[e];
  }

  const addrs = {}, places = [];
  for (const el of extra.elements) {
    const t = el.tags || {};
    const c = el.type === 'node' ? el : el.center;
    if (!c) continue;
    if (t['addr:housenumber'] && t['addr:street']) {
      const num = parseInt(t['addr:housenumber'], 10);
      if (!isNaN(num)) (addrs[normName(t['addr:street'])] ||= []).push([num, c.lat, c.lon]);
    } else if (t.place && t.name) {
      places.push({ name: t.name, norm: normName(t.name), lat: c.lat, lon: c.lon });
    }
  }
  for (const k in addrs) addrs[k].sort((a, b) => a[0] - b[0]);

  return {
    bbox, savedAt: Date.now(), n, m,
    lat: Float64Array.from(lat), lon: Float64Array.from(lon), off, to, len, spd,
    streets, addrs, places,
  };
}

async function downloadPack(bbox, say) {
  const { s, w, n, e } = bbox;
  const bb = `[bbox:${s},${w},${n},${e}]`;
  say('Baixando ruas da região… (pode levar alguns minutos)');
  const roads = await overpass(
    `[out:json][timeout:240]${bb};
     way["highway"~"^(motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street|service|road|motorway_link|trunk_link|primary_link|secondary_link|tertiary_link)$"]["service"!~"driveway|parking_aisle"]["access"!~"private|no"];
     out body; >; out skel qt;`);
  say('Baixando endereços e bairros…');
  const extra = await overpass(
    `[out:json][timeout:180]${bb};
     (nwr["addr:housenumber"]["addr:street"]; nwr["place"~"^(suburb|neighbourhood|quarter)$"]["name"];);
     out center tags;`);
  say('Processando o pacote…');
  await sleep(50);
  const pack = buildPack(roads, extra, bbox);
  if (!pack.n) throw new Error('nenhuma rua encontrada nesta área');
  await DB.set('pack', pack);
  loadPack(pack);
  return pack;
}

/* ---------- Carregamento e índice espacial ---------- */
const CELL = 0.005;       // ~500 m
const cellKey = (la, lo) => Math.floor(la / CELL) + '_' + Math.floor(lo / CELL);

function loadPack(p) {
  OFF.pack = p || null;
  OFF.grid = null;
  if (!p) return;
  // maior componente conectada: evita "ilhas" de ruas isoladas
  const par = new Int32Array(p.n).map((_, i) => i);
  const find = x => { while (par[x] !== x) { par[x] = par[par[x]]; x = par[x]; } return x; };
  for (let u = 0; u < p.n; u++) for (let e = p.off[u]; e < p.off[u + 1]; e++) par[find(u)] = find(p.to[e]);
  const size = new Map();
  for (let u = 0; u < p.n; u++) if (p.off[u + 1] > p.off[u]) { const r = find(u); size.set(r, (size.get(r) || 0) + 1); }
  let main = -1, best = 0;
  for (const [r, c] of size) if (c > best) { best = c; main = r; }
  const grid = new Map();
  for (let u = 0; u < p.n; u++) {
    if (p.off[u + 1] === p.off[u] || find(u) !== main) continue;
    const k = cellKey(p.lat[u], p.lon[u]);
    (grid.get(k) || grid.set(k, []).get(k)).push(u);
  }
  OFF.grid = grid;
}

const packReady = () => !!(OFF.pack && OFF.grid);
const inPack = (la, lo) => packReady() && la >= OFF.pack.bbox.s && la <= OFF.pack.bbox.n && lo >= OFF.pack.bbox.w && lo <= OFF.pack.bbox.e;

function packInfo() {
  const p = OFF.pack;
  if (!p) return 'Nenhum pacote offline salvo.';
  const d = new Date(p.savedAt).toLocaleDateString('pt-BR');
  return `Salvo em ${d}: ${p.n.toLocaleString('pt-BR')} pontos de rua, ${Object.keys(p.streets).length.toLocaleString('pt-BR')} ruas, ` +
    `${Object.values(p.addrs).reduce((a, l) => a + l.length, 0).toLocaleString('pt-BR')} endereços com número, ${p.places.length} bairros.`;
}

/* ---------- Localizar endereço offline ---------- */
function splitAddr(raw) {
  const t = raw.replace(/\bN[º°]\.?\s*/gi, '').replace(COMPL, ' ').replace(/\s+-\s+/g, ', ');
  const parts = t.split(',').map(x => x.trim()).filter(Boolean);
  let street = parts[0] || '', num = null;
  const rest = [];
  for (const p of parts.slice(1)) {
    const m = num == null && /^(\d{1,5})\b\s*(.*)$/.exec(p);
    if (m) { num = parseInt(m[1], 10); if (m[2]) rest.push(m[2]); } else rest.push(p);
  }
  if (num == null) {                                  // "Rua Piauí 218 c sao genaro": número no meio, sem vírgulas
    const m = /^(.*?\D)\s+(\d{1,5})(?:\s+(.*))?$/.exec(street);
    if (m && m[1].trim().split(/\s+/).length >= 2) {   // "Rua 7 de Setembro" não conta
      street = m[1].trim(); num = parseInt(m[2], 10);
      if (m[3]) rest.unshift(m[3]);
    }
  }
  return { street, num, rest: rest.join(' ') };
}

function findStreet(P, q) {
  if (!P._keys) P._keys = [...new Set([...Object.keys(P.streets), ...Object.keys(P.addrs)])];
  if (P.streets[q] || P.addrs[q]) return q;
  const qt = new Set(q.split(' ').filter(t => !TYPE_WORDS.has(t)));
  if (!qt.size) return null;
  let best = null, bs = 0;
  for (const key of P._keys) {
    const kt = new Set(key.split(' ').filter(t => !TYPE_WORDS.has(t)));
    let inter = 0;
    for (const t of qt) if (kt.has(t)) inter++;
    const score = inter / (qt.size + kt.size - inter);
    if (score > bs) { bs = score; best = key; }
  }
  return bs >= 0.6 ? best : null;
}

// Ponto de referência para escolher entre ruas de mesmo nome: bairro citado > sua posição > centro da área.
function refPoint(P, restText) {
  const r = normName(restText);
  let best = null;
  for (const pl of P.places) if (pl.norm && r.includes(pl.norm) && (!best || pl.norm.length > best.norm.length)) best = pl;
  if (best) return [best.lat, best.lon];
  if (me && inPack(me.lat, me.lon)) return [me.lat, me.lon];
  const b = P.bbox;
  return [(b.s + b.n) / 2, (b.w + b.e) / 2];
}

function offlineGeocode(s) {
  const P = OFF.pack;
  if (!packReady()) return null;
  const a = splitAddr(s.raw);
  const key = findStreet(P, normName(a.street));
  if (!key) return null;

  const addrs = P.addrs[key] || [];
  const cand = P.streets[key] ? P.streets[key].pts : addrs.map(x => [x[1], x[2]]);
  if (!cand.length) return null;
  const ref = refPoint(P, a.rest);
  const c = cand.reduce((b, p) => (distM(p[0], p[1], ref[0], ref[1]) < distM(b[0], b[1], ref[0], ref[1]) ? p : b));

  let pt = c;
  const near = addrs.filter(x => distM(x[1], x[2], c[0], c[1]) < 2500);
  if (a.num != null && near.length) {
    const exact = near.find(x => x[0] === a.num);
    const lo = [...near].reverse().find(x => x[0] < a.num), hi = near.find(x => x[0] > a.num);
    if (exact) pt = [exact[1], exact[2]];
    else if (lo && hi) {                                 // interpola entre os números vizinhos
      const f = (a.num - lo[0]) / (hi[0] - lo[0]);
      pt = [lo[1] + (hi[1] - lo[1]) * f, lo[2] + (hi[2] - lo[2]) * f];
    } else {
      const n = near.reduce((b, x) => (Math.abs(x[0] - a.num) < Math.abs(b[0] - a.num) ? x : b));
      pt = [n[1], n[2]];
    }
  }
  const name = P.streets[key] ? P.streets[key].name : key;
  return { lat: pt[0], lon: pt[1], label: `${name}${a.num != null ? ', ' + a.num : ''} (offline)`, approx: true, src: 'offline', precision: 'street' };
}

/* ---------- Rota offline (Dijkstra no mapa salvo + melhor ordem) ---------- */
class Heap {
  constructor() { this.k = []; this.v = []; }
  get size() { return this.k.length; }
  push(key, val) {
    let i = this.k.length;
    this.k.push(key); this.v.push(val);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.k[p] <= key) break;
      this.k[i] = this.k[p]; this.v[i] = this.v[p]; i = p;
    }
    this.k[i] = key; this.v[i] = val;
  }
  pop() {
    this.topK = this.k[0]; this.topV = this.v[0];
    const lk = this.k.pop(), lv = this.v.pop(), n = this.k.length;
    if (n) {
      let i = 0;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= n) break;
        if (c + 1 < n && this.k[c + 1] < this.k[c]) c++;
        if (this.k[c] >= lk) break;
        this.k[i] = this.k[c]; this.v[i] = this.v[c]; i = c;
      }
      this.k[i] = lk; this.v[i] = lv;
    }
  }
}

function snapNode(P, la, lo) {
  const cx = Math.floor(la / CELL), cy = Math.floor(lo / CELL);
  let best = -1, bd = Infinity, found = false;
  for (let r = 0; r <= 6; r++) {
    for (let dx = -r; dx <= r; dx++) {
      for (let dy = -r; dy <= r; dy++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const list = OFF.grid.get((cx + dx) + '_' + (cy + dy));
        if (!list) continue;
        for (const u of list) {
          const d = distM(la, lo, P.lat[u], P.lon[u]);
          if (d < bd) { bd = d; best = u; }
        }
      }
    }
    if (found) break;
    if (best >= 0) found = true;       // acha um, olha mais um anel e para
  }
  return best >= 0 && bd <= 800 ? best : -1;
}

function dijkstra(P, src, targets) {
  const time = new Float64Array(P.n).fill(Infinity), dist = new Float64Array(P.n), prev = new Int32Array(P.n).fill(-1);
  const left = new Set(targets), h = new Heap();
  time[src] = 0; h.push(0, src);
  while (h.size) {
    h.pop();
    const t = h.topK, u = h.topV;
    if (t > time[u]) continue;
    if (left.delete(u) && !left.size) break;
    for (let e = P.off[u]; e < P.off[u + 1]; e++) {
      const base = P.len[e] / (P.spd[e] / 3.6);
      // P.cm / P.ca: trechos lentos aprendidos e problemas marcados (ver live.js)
      const v = P.to[e], nt = t + (P.cm ? base * P.cm[e] + P.ca[e] : base);
      if (nt < time[v]) { time[v] = nt; dist[v] = dist[u] + P.len[e]; prev[v] = u; h.push(nt, v); }
    }
  }
  return { time, dist, prev };
}

// Melhor ordem de visita: exata (Held-Karp) até 13 paradas, heurística acima disso.
// T[0] é a partida; 1..m são as paradas.
function solveOrder(T, m) {
  if (m <= 13) {
    const full = 1 << m, INF = 1e18;
    const dp = new Float64Array(full * m).fill(INF), par = new Int8Array(full * m).fill(-1);
    for (let j = 0; j < m; j++) dp[(1 << j) * m + j] = T[0][j + 1];
    for (let mask = 1; mask < full; mask++) {
      for (let j = 0; j < m; j++) {
        if (!(mask & (1 << j))) continue;
        const cur = dp[mask * m + j];
        if (cur >= INF) continue;
        for (let k = 0; k < m; k++) {
          if (mask & (1 << k)) continue;
          const nm = mask | (1 << k), c = cur + T[j + 1][k + 1];
          if (c < dp[nm * m + k]) { dp[nm * m + k] = c; par[nm * m + k] = j; }
        }
      }
    }
    let bj = 0;
    for (let j = 1; j < m; j++) if (dp[(full - 1) * m + j] < dp[(full - 1) * m + bj]) bj = j;
    const order = [];
    for (let mask = full - 1, j = bj; j >= 0;) { order.push(j + 1); const pj = par[mask * m + j]; mask ^= 1 << j; j = pj; }
    return [0, ...order.reverse()];
  }
  const cost = o => { let c = 0; for (let i = 0; i + 1 < o.length; i++) c += T[o[i]][o[i + 1]]; return c; };
  const order = [0], used = new Set([0]);
  while (order.length <= m) {
    const last = order[order.length - 1];
    let b = -1;
    for (let j = 1; j <= m; j++) if (!used.has(j) && (b < 0 || T[last][j] < T[last][b])) b = j;
    order.push(b); used.add(b);
  }
  let best = cost(order);
  for (let improved = true, g = 0; improved && g < 30; g++) {
    improved = false;
    for (let i = 1; i < order.length - 1; i++) {
      for (let j = i + 1; j < order.length; j++) {
        const cand = [...order.slice(0, i), ...order.slice(i, j + 1).reverse(), ...order.slice(j + 1)];
        const c = cost(cand);
        if (c < best - 1e-6) { best = c; order.splice(0, order.length, ...cand); improved = true; }
      }
    }
    for (let i = 1; i < order.length; i++) {          // or-opt: tenta mover uma parada para outro lugar
      for (let j = 1; j <= order.length; j++) {
        if (j === i || j === i + 1) continue;
        const cand = order.slice();
        const [x] = cand.splice(i, 1);
        cand.splice(j > i ? j - 1 : j, 0, x);
        const c = cost(cand);
        if (c < best - 1e-6) { best = c; order.splice(0, order.length, ...cand); improved = true; }
      }
    }
  }
  return order;
}

// Dada a matriz de tempos T entre os k pontos (com start, o ponto 0 é a partida), devolve a ordem de visita
// e a posição de cada ponto nessa ordem. Sem partida (sem GPS), cria uma partida fictícia de custo zero.
function planOrder(T, k, start) {
  const m = start ? k - 1 : k;
  const M = start ? T : [[0, ...Array(k).fill(0)], ...T.map(row => [0, ...row])];
  const ord = solveOrder(M, m);
  const order = start ? ord : ord.slice(1).map(i => i - 1);
  const position = Array(k);
  order.forEach((idx, p) => { position[idx] = p; });
  return { order, position };
}

// Custo (tempo e distância) de seguir os pontos na ordem em que foram colados.
function baselineCost(T, D) {
  let duration = 0, distance = 0;
  for (let i = 0; i + 1 < T.length; i++) { duration += T[i][i + 1]; distance += D[i][i + 1]; }
  return { duration, distance };
}

async function offlineTrip(pts, start) {
  const P = OFF.pack;
  if (!packReady()) throw new Error('sem pacote offline');
  if (typeof prepareCosts === 'function') prepareCosts(P);      // aplica os trechos lentos aprendidos
  const nodes =pts.map(p => (inPack(p.lat, p.lon) ? snapNode(P, p.lat, p.lon) : -1));
  if (nodes.some(u => u < 0)) throw new Error('ponto fora do pacote offline');

  const k = pts.length, tset = new Set(nodes);
  const T = [], D = [];
  for (let i = 0; i < k; i++) {
    const r = dijkstra(P, nodes[i], tset);
    T.push(nodes.map(u => r.time[u])); D.push(nodes.map(u => r.dist[u]));
    await sleep(0);
  }
  if (T.some((row, i) => row.some((t, j) => i !== j && !isFinite(t) && !(start && j === 0)))) throw new Error('trecho sem caminho nas ruas salvas');

  const { order, position } = planOrder(T, k, start);
  const legs = [], coords = [];
  let distance = 0, duration = 0;
  for (let p = 0; p + 1 < order.length; p++) {
    const a = order[p], b = order[p + 1];
    legs.push({ distance: D[a][b], duration: T[a][b] });
    distance += D[a][b]; duration += T[a][b];
    const r = dijkstra(P, nodes[a], new Set([nodes[b]]));
    const path = [];
    for (let u = nodes[b]; u >= 0; u = r.prev[u]) path.push([P.lat[u], P.lon[u]]);
    path.reverse();
    if (!p) coords.push([pts[a].lat, pts[a].lon]);
    coords.push(...path);
    coords.push([pts[b].lat, pts[b].lon]);
    await sleep(0);
  }
  return { position, legs, coords, distance, duration, approx: false, offline: true, baseline: baselineCost(T, D) };
}
