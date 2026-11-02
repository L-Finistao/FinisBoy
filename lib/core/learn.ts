import { haversine } from './format';
import { cumulative } from './geo';
import type { LatLon, RouteGeo } from './types';

/* Aprendizado de trechos lentos. O app anota, pelo GPS, onde você anda devagar ou para (buraco, lombada, semáforo, trânsito)
   e você marca problemas na hora (⚠). Esses trechos "custam mais" nas próximas rotas. Vias onde você ignorou a sugestão
   3 vezes viram favoritas. Entregas na via não contam: não adianta evitar a rua da entrega. */

export const LC = 0.0003;                                   // célula de ~33 m
export const lcKey = (la: number, lo: number) => Math.floor(la / LC) + '_' + Math.floor(lo / LC);

export type Cell = [number, number, number, number];         // [amostras, soma das velocidades (m/s), paradas, segundos parado]
export interface Hazard { id: string; lat: number; lon: number; type: string; ts: number }
export interface DevZone { id: string; lat: number; lon: number; n: number; routes: string[]; path: [number, number][] | null }
export interface Learn { learned: Record<string, Cell>; hazards: Hazard[]; devZones: DevZone[]; on: boolean }

export const HAZ_SPAN = 200;                                 // o problema vale para ~200 m da mesma via
// Prioridade para evitar: buraco > semáforo (~60 s parado) > trânsito > depressão/lombada/redutor.
export const HAZARD: Record<string, { icon: string; label: string; add: number; mult: number }> = {
  buraco: { icon: '🕳️', label: 'Rua esburacada', add: 90, mult: 5 },
  semaforo: { icon: '🚦', label: 'Semáforo', add: 60, mult: 1 },
  transito: { icon: '🚗', label: 'Trânsito / muito carro', add: 0, mult: 3 },
  depressao: { icon: '〰️', label: 'Depressão transversal / drenagem', add: 12, mult: 1.5 },
  lombada: { icon: '🚧', label: 'Lombada', add: 8, mult: 1.2 },
  redutor: { icon: '🐢', label: 'Redutor de velocidade', add: 8, mult: 1.3 },
};

export const FAV_MIN = 3;                                    // 3 rotas em que você saiu da sugestão no mesmo lugar
export const FAV_MULT = 0.7;                                 // a via favorita "custa" 30% menos
export const favZones = (l: Learn) => l.devZones.filter(z => z.n >= FAV_MIN && z.path && z.path.length > 1);
export const isSlowCell = (c: Cell) => (c[0] >= 3 && c[1] / c[0] < 3.5) || c[2] >= 2;

export function favCells(l: Learn) {
  const set = new Set<string>();
  for (const z of favZones(l)) {
    for (let i = 1; i < z.path!.length; i++) {
      const a = z.path![i - 1], b = z.path![i], steps = Math.max(1, Math.ceil(haversine({ lat: a[0], lon: a[1] }, { lat: b[0], lon: b[1] }) / 10));
      for (let k = 0; k <= steps; k++) set.add(lcKey(a[0] + (b[0] - a[0]) * k / steps, a[1] + (b[1] - a[1]) * k / steps));
    }
  }
  return set;
}

export const hasLearning = (l: Learn) => l.on && (l.hazards.length > 0 || favZones(l).length > 0 || Object.values(l.learned).some(c => c[0] >= 3 || c[2] >= 2));

// Entrega na via (80 m): não se evita uma via onde há entrega.
const DELIVERY_NEAR = 80;
export function nearDelivery(list: LatLon[], la: number, lo: number) {
  const dLa = DELIVERY_NEAR / 111320, dLo = DELIVERY_NEAR / (111320 * Math.cos(la * Math.PI / 180));
  for (const s of list) if (Math.abs(s.lat - la) < dLa && Math.abs(s.lon - lo) < dLo) return true;
  return false;
}

// Segundos a somar à duração prevista de uma alternativa: trechos lentos, problemas marcados a menos de 40 m e desconto nas favoritas.
export function routePenalty(l: Learn, coords: number[][], planV: number, deliveries: LatLon[]) {
  const fav = favCells(l), seenCell = new Set<string>(), seenHaz = new Set<number>();
  let extra = 0;
  for (let k = 0; k + 1 < coords.length; k++) {
    const a = coords[k], b = coords[k + 1], len = haversine({ lat: a[0], lon: a[1] }, { lat: b[0], lon: b[1] });
    const steps = Math.max(1, Math.ceil(len / 20)), seg = len / steps;
    for (let i = 0; i < steps; i++) {
      const f = (i + 0.5) / steps, la = a[0] + (b[0] - a[0]) * f, lo = a[1] + (b[1] - a[1]) * f;
      if (deliveries.length && nearDelivery(deliveries, la, lo)) continue;
      const key = lcKey(la, lo), c = l.learned[key], base = seg / planV;
      if (c && c[0] >= 3) extra += base * (Math.min(3, Math.max(1, planV / Math.max(c[1] / c[0], 0.8))) - 1);
      if (c && c[2] >= 2 && !seenCell.has(key)) extra += Math.min(60, c[3] / c[2]);
      seenCell.add(key);
      if (fav.has(key)) extra -= base * (1 - FAV_MULT);
      l.hazards.forEach((h, n) => {
        const spec = HAZARD[h.type];
        if (!spec || seenHaz.has(n) || Math.abs(h.lat - la) > 0.0004 || Math.abs(h.lon - lo) > 0.0005 || haversine({ lat: la, lon: lo }, h) > 40) return;
        seenHaz.add(n);
        extra += spec.add + (spec.mult - 1) * HAZ_SPAN / planV;
      });
    }
  }
  return extra;
}

// Via à frente vs tempo médio registrado (análise em tempo real).
export const AHEAD_M = 1500, SLOW_EXTRA = 60, SLOW_RATIO = 1.5;
export function analyzeAhead(l: Learn, geo: RouteGeo, nearI: number, deliveries: LatLon[]) {
  const cum = cumulative(geo.coords);
  const planV = Math.max(geo.distance / Math.max(geo.duration, 1), 1);           // m/s previsto no plano
  const from = cum[nearI], seen = new Set<string>();
  let plan = 0, real = 0, firstKey: string | null = null;
  for (let k = nearI; k + 1 < geo.coords.length && cum[k] - from < AHEAD_M; k++) {
    const a = geo.coords[k], b = geo.coords[k + 1], len = cum[k + 1] - cum[k];
    const steps = Math.max(1, Math.ceil(len / 20));
    for (let i = 0; i < steps; i++) {
      const f = (i + 0.5) / steps, la = a[0] + (b[0] - a[0]) * f, lo = a[1] + (b[1] - a[1]) * f;
      if (deliveries.length && nearDelivery(deliveries, la, lo)) continue;          // entrega nesta via: ignora
      const key = lcKey(la, lo), c = l.learned[key], seg = len / steps;
      plan += seg / planV;
      if (!c || c[0] < 3) { real += seg / planV; continue; }                        // sem histórico: assume o previsto
      real += seg / Math.max(c[1] / c[0], 0.8);
      if (!seen.has(key)) { seen.add(key); if (c[2] >= 2) real += Math.min(60, c[3] / c[2]); }
      if (!firstKey && real - plan > 5) firstKey = key;
    }
  }
  return { plan, real, extra: real - plan, sig: firstKey, slow: real - plan >= SLOW_EXTRA && real >= plan * SLOW_RATIO };
}
