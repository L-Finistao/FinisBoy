import type { LatLon } from './types';

export const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
export const newId = () => Date.now() + '-' + Math.random().toString(36).slice(2, 7);

const pad2 = (n: number) => String(n).padStart(2, '0');
export const money = (v: number) => (v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
export const fmtDist = (m: number) => (m / 1000).toFixed(1).replace('.', ',') + ' km';
export const fmtDur = (s: number) => {
  const m = Math.round(s / 60);
  return m < 60 ? m + ' min' : Math.floor(m / 60) + ' h ' + (m % 60 ? (m % 60) + ' min' : '');
};
export const fmtClock = (sec: number) => {
  sec = Math.max(0, Math.round(sec));
  const h = Math.floor(sec / 3600), m = Math.floor(sec / 60) % 60, s = sec % 60;
  return h ? `${h}:${pad2(m)}:${pad2(s)}` : `${pad2(m)}:${pad2(s)}`;
};

export const haversine = (a: LatLon, b: LatLon) => {
  const t = (x: number) => x * Math.PI / 180;
  const h = Math.sin(t(b.lat - a.lat) / 2) ** 2 + Math.cos(t(a.lat)) * Math.cos(t(b.lat)) * Math.sin(t(b.lon - a.lon) / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(h));
};
