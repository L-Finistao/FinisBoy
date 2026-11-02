import { haversine } from './format';
import type { LatLon, Route, Stop } from './types';

// Trajeto gravado: [lat, lon, horário, km/h do GPS][]. Análise parte a parte entre as entregas.
export type TrackPt = number[];
export const SPEED_COLORS = ['#dc2626', '#f97316', '#eab308', '#16a34a'];
export const speedBand = (kmh: number) => (kmh < 5 ? 0 : kmh < 15 ? 1 : kmh < 30 ? 2 : 3);
const ptObj = (p: TrackPt): LatLon => ({ lat: p[0], lon: p[1] });
export const shortAddr = (s: Stop) => s.raw.split(',').slice(0, 2).join(',').trim();

export function ptKmh(a: TrackPt, b: TrackPt) {
  const dt = (b[2] - a[2]) / 1000;
  if (b[3] != null && dt <= 20) return b[3];                         // velocidade medida pelo GPS
  return dt > 0 ? haversine(ptObj(a), ptObj(b)) / dt * 3.6 : 0;
}

// Trechos contínuos na mesma faixa de velocidade (o sinal perdido não liga os pontos).
export function speedRuns(pts: TrackPt[]) {
  const runs: { band: number; pts: [number, number][] }[] = [];
  let run: (typeof runs)[number] | null = null;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i], dt = (b[2] - a[2]) / 1000;
    if (dt <= 0 || dt > 90) { run = null; continue; }
    const band = speedBand(ptKmh(a, b));
    if (run && run.band === band) run.pts.push([b[0], b[1]]);
    else runs.push(run = { band, pts: [[a[0], a[1]], [b[0], b[1]]] });
  }
  return runs;
}

export interface Mark { t: number; label: string; lat: number | null; lon: number | null }
export interface Segment {
  n: number; from: Mark; to: Mark; sub: TrackPt[]; dur: number; dist: number | null; moving: number;
  stopped: number | null; kmh: number | null; kmhMoving: number | null; pace: number | null;
}

// Cada parte vai de uma entrega (ou da saída) até a próxima entrega.
export function segmentsOf(r: Route, delivered: Stop[], pts: TrackPt[]): Segment[] {
  const first = pts[0];
  const marks: Mark[] = [{ t: r.startedAt || 0, label: 'Saída', lat: first ? first[0] : null, lon: first ? first[1] : null }];
  for (const s of delivered) marks.push({ t: s.doneAt!, label: shortAddr(s), lat: s.lat, lon: s.lon });

  const segs: Segment[] = [];
  for (let i = 1; i < marks.length; i++) {
    const a = marks[i - 1], b = marks[i];
    const sub = pts.filter(p => p[2] >= a.t && p[2] <= b.t);
    const dur = (b.t - a.t) / 1000;
    let dist: number | null = null, moving = 0;
    if (sub.length >= 2) {
      dist = 0;
      for (let k = 1; k < sub.length; k++) {
        const d = haversine(ptObj(sub[k - 1]), ptObj(sub[k])), dt = (sub[k][2] - sub[k - 1][2]) / 1000;
        dist += d;
        if (dt > 0 && dt <= 90 && d / dt >= 1.4) moving += dt;       // rodando (> 5 km/h)
      }
    }
    segs.push({
      n: i, from: a, to: b, sub, dur, dist, moving,
      stopped: dist != null ? Math.max(0, dur - moving) : null,
      kmh: dist != null && dur > 0 ? dist / dur * 3.6 : null,
      kmhMoving: dist != null && moving > 0 ? dist / moving * 3.6 : null,
      pace: dist != null && dist >= 100 ? (dur / 60) / (dist / 1000) : null,   // min por km (maior = mais lento)
    });
  }
  return segs;
}
