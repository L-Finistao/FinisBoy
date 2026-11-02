import { haversine } from './format';
import type { LatLon } from './types';

// Distância (m) de um ponto a um segmento e a posição t (0..1) mais próxima dele.
export function segDist(p: LatLon, a: number[], b: number[]) {
  const k = Math.cos(p.lat * Math.PI / 180), M = 111320;
  const ax = (a[1] - p.lon) * k * M, ay = (a[0] - p.lat) * M, bx = (b[1] - p.lon) * k * M, by = (b[0] - p.lat) * M;
  const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
  const t = L2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / L2)) : 0;
  return { d: Math.hypot(ax + t * dx, ay + t * dy), t };
}

export interface Near { d: number; i: number; t: number }
export function nearestOnRoute(p: LatLon, coords: number[][]): Near {
  let best: Near = { d: Infinity, i: 0, t: 0 };
  for (let i = 0; i + 1 < coords.length; i++) {
    const s = segDist(p, coords[i], coords[i + 1]);
    if (s.d < best.d) best = { d: s.d, i, t: s.t };
  }
  return best;
}

const cumCache = new WeakMap<number[][], number[]>();
// Distância acumulada (m) ao longo da linha.
export function cumulative(coords: number[][]) {
  let c = cumCache.get(coords);
  if (!c) {
    c = [0];
    for (let i = 1; i < coords.length; i++) c.push(c[i - 1] + haversine({ lat: coords[i - 1][0], lon: coords[i - 1][1] }, { lat: coords[i][0], lon: coords[i][1] }));
    cumCache.set(coords, c);
  }
  return c;
}

// Posição (m) de um ponto já projetado na linha.
export const posOnRoute = (coords: number[][], n: Near) => { const c = cumulative(coords); return c[n.i] + n.t * (c[n.i + 1] - c[n.i]); };
