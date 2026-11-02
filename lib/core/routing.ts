import { haversine } from './format';
import { osrmSteps, placeSteps } from './nav';
import type { LatLon, RouteGeo } from './types';

/* Otimização da rota: OSRM /table (tempos reais) + melhor ordem (exata até 13 paradas), traçado pelo OSRM /route.
   Planos B: OSRM /trip e, sem internet, vizinho mais próximo + 2-opt em linha reta. */

export interface RouteResult extends RouteGeo {
  position: number[];                              // posição (0..n) de cada ponto de entrada na ordem de visita
  legs: { distance: number; duration: number }[];
}

export type Penalty = (coords: number[][], planV: number) => number;   // segundos extras de uma alternativa (trechos lentos aprendidos)
const OSRM = 'https://router.project-osrm.org';

// Internet que oscila conta como queda: passou de 8 s, desiste.
async function fetchJson(url: string, ms = 8000): Promise<any> {
  const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), ms);
  try { return await (await fetch(url, { signal: ctl.signal })).json(); } finally { clearTimeout(t); }
}

// Melhor ordem de visita: exata (Held-Karp) até 13 paradas, heurística acima disso.
// T[0] é a partida; 1..m são as paradas.
function solveOrder(T: number[][], m: number): number[] {
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
    const order: number[] = [];
    for (let mask = full - 1, j = bj; j >= 0;) { order.push(j + 1); const pj = par[mask * m + j]; mask ^= 1 << j; j = pj; }
    return [0, ...order.reverse()];
  }
  const cost = (o: number[]) => { let c = 0; for (let i = 0; i + 1 < o.length; i++) c += T[o[i]][o[i + 1]]; return c; };
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
function planOrder(T: number[][], k: number, start: boolean) {
  const m = start ? k - 1 : k;
  const M = start ? T : [[0, ...Array(k).fill(0)], ...T.map(row => [0, ...row])];
  const ord = solveOrder(M, m);
  const order = start ? ord : ord.slice(1).map(i => i - 1);
  const position: number[] = Array(k);
  order.forEach((idx, p) => { position[idx] = p; });
  return { order, position };
}

// Custo (tempo e distância) de seguir os pontos na ordem em que foram colados.
function baselineCost(T: number[][], D: number[][]) {
  let duration = 0, distance = 0;
  for (let i = 0; i + 1 < T.length; i++) { duration += T[i][i + 1]; distance += D[i][i + 1]; }
  return { duration, distance };
}

const cs = (a: LatLon[]) => a.map(p => `${p.lon},${p.lat}`).join(';');
const flip = (c: [number, number][]): [number, number][] => c.map(([lon, lat]) => [lat, lon]);

async function osrmBest(pts: LatLon[], start: boolean, pen?: Penalty): Promise<RouteResult> {
  const tj = await fetchJson(`${OSRM}/table/v1/driving/${cs(pts)}?annotations=duration,distance`);
  if (tj.code !== 'Ok') throw new Error(tj.message || tj.code);
  const fix = (m: (number | null)[][]) => m.map(row => row.map(v => (v == null ? 1e9 : v)));
  const T = fix(tj.durations), D = fix(tj.distances);
  const { order, position } = planOrder(T, pts.length, start);
  const ordered = order.map(i => pts[i]);
  if (pen && ordered.length <= 26) {                       // escolhe, trecho a trecho, a alternativa melhor pelo seu histórico
    const lr = await osrmLegsLearned(ordered, pen);
    return { position, legs: lr.legs, distance: lr.distance, duration: lr.duration, approx: false, coords: lr.coords, baseline: baselineCost(T, D), learned: lr.learned, steps: placeSteps(osrmSteps(lr.legs), lr.coords) };
  }
  const rj = await fetchJson(`${OSRM}/route/v1/driving/${cs(ordered)}?overview=full&geometries=geojson&steps=true`);
  if (rj.code !== 'Ok') throw new Error(rj.message || rj.code);
  const r0 = rj.routes[0], coords = flip(r0.geometry.coordinates);
  return { position, legs: r0.legs, distance: r0.distance, duration: r0.duration, approx: false, coords, baseline: baselineCost(T, D), steps: placeSteps(osrmSteps(r0.legs), coords) };
}

// Com histórico (trechos lentos, buracos, favoritas...): pede alternativas do OSRM para cada trecho entre paradas
// e fica com a de menor tempo + penalidades. O OSRM só dá alternativas para 2 pontos.
async function osrmLegsLearned(ordered: LatLon[], pen: Penalty) {
  const jobs: (() => Promise<any>)[] = [];
  for (let i = 0; i + 1 < ordered.length; i++) {
    const a = ordered[i], b = ordered[i + 1];
    jobs.push(() => fetchJson(`${OSRM}/route/v1/driving/${a.lon},${a.lat};${b.lon},${b.lat}?alternatives=3&overview=full&geometries=geojson&steps=true`));
  }
  const res: any[] = [];
  for (let i = 0; i < jobs.length; i += 4) res.push(...await Promise.all(jobs.slice(i, i + 4).map(f => f())));   // 4 por vez
  const coords: [number, number][] = [], legs: any[] = [];
  let distance = 0, duration = 0, learned = false;
  for (const j of res) {
    if (j.code !== 'Ok' || !j.routes.length) throw new Error(j.message || j.code);
    const scored = j.routes.map((r: any) => { const c = flip(r.geometry.coordinates); return { r, c, cost: r.duration + pen(c, r.distance / Math.max(r.duration, 1)) }; });
    const best = scored.reduce((x: any, y: any) => (y.cost < x.cost ? y : x));
    if (best !== scored[0]) learned = true;
    coords.push(...(coords.length ? best.c.slice(1) : best.c));
    legs.push(best.r.legs[0]);
    distance += best.r.distance; duration += best.r.duration;
  }
  return { coords, legs, distance, duration, learned };
}

// Plano B online: ordem escolhida pelo próprio OSRM (aproximada).
async function osrmTrip(pts: LatLon[], start: boolean): Promise<RouteResult> {
  const j = await fetchJson(`${OSRM}/trip/v1/driving/${cs(pts)}?roundtrip=false&source=${start ? 'first' : 'any'}&destination=any&geometries=geojson&overview=full&steps=true`);
  if (j.code !== 'Ok') throw new Error(j.message || j.code);
  const trip = j.trips[0];
  return {
    position: j.waypoints.map((w: any) => w.waypoint_index), legs: trip.legs,
    coords: flip(trip.geometry.coordinates), distance: trip.distance, duration: trip.duration, approx: false, baseline: null,
    steps: placeSteps(osrmSteps(trip.legs), flip(trip.geometry.coordinates)),
  };
}

// Plano B sem internet: vizinho mais próximo + 2-opt, distâncias em linha reta (x1,3 para aproximar as ruas).
function localTrip(pts: LatLon[]): RouteResult {
  const n = pts.length;
  const d = (i: number, j: number) => haversine(pts[i], pts[j]);
  const order = [0], used = Array<boolean>(n).fill(false);
  used[0] = true;
  while (order.length < n) {
    const last = order[order.length - 1];
    let best = -1, bd = Infinity;
    for (let i = 0; i < n; i++) if (!used[i] && d(last, i) < bd) { bd = d(last, i); best = i; }
    order.push(best); used[best] = true;
  }
  for (let improved = true, guard = 0; improved && guard < 50; guard++) {
    improved = false;
    for (let i = 1; i < n - 1; i++) {
      for (let j = i + 1; j < n; j++) {
        const a = order[i - 1], b = order[i], c = order[j], e = order[j + 1];
        const delta = d(a, c) + (e != null ? d(b, e) : 0) - d(a, b) - (e != null ? d(c, e) : 0);
        if (delta < -1) { order.splice(i, j - i + 1, ...order.slice(i, j + 1).reverse()); improved = true; }
      }
    }
  }
  const FATOR = 1.3, MS = 25 / 3.6;                // 25 km/h médios na cidade
  const position: number[] = Array(n);
  order.forEach((idx, p) => { position[idx] = p; });
  const legs: { distance: number; duration: number }[] = [];
  for (let p = 0; p < n - 1; p++) {
    const dist = d(order[p], order[p + 1]) * FATOR;
    legs.push({ distance: dist, duration: dist / MS });
  }
  const distance = legs.reduce((a, l) => a + l.distance, 0);
  return { position, legs, distance, duration: distance / MS, approx: true, baseline: null, coords: order.map(i => [pts[i].lat, pts[i].lon] as [number, number]) };
}

export interface OptimizeOut { result: RouteResult; warn: string }

// pts: [partida (se start), ...paradas]. Tenta o OSRM; sem internet, cai para o cálculo em linha reta.
export async function optimizeRoute(pts: LatLon[], start: boolean, pen?: Penalty): Promise<OptimizeOut> {
  try {
    if (!navigator.onLine) throw new Error('offline');
    try { return { result: await osrmBest(pts, start, pen), warn: '' }; }
    catch (e) { if ((e as Error).name === 'AbortError') throw e; return { result: await osrmTrip(pts, start), warn: '' }; }
  } catch {
    return { result: localTrip(pts), warn: 'Sem internet: rota em linha reta (aproximada). Toque em Recalcular quando a conexão voltar.' };
  }
}
