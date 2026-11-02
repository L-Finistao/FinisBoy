'use client';
import { useSyncExternalStore } from 'react';
import { local } from './local-db';
import { getVoice, say } from './voice';
import { cumulative, nearestOnRoute, posOnRoute, type Near } from '../core/geo';
import { fmtDist, fmtDur, haversine, newId } from '../core/format';
import { analyzeAhead, FAV_MIN, HAZARD, hasLearning, isSlowCell, lcKey, type Cell, type DevZone, type Hazard, type Learn } from '../core/learn';
import { nextAnnouncement, routeSteps } from '../core/nav';
import type { LatLon, Route, Stop } from '../core/types';

/* Acompanhamento em tempo real: posição na rota, chegada, recálculo automático, aprendizado de trechos lentos,
   problemas marcados (⚠) e vias favoritas (onde você ignorou a sugestão 3 vezes). */

export interface LiveInfo { speedKmh: number | null; left: number; etaSec: number; near: Near | null; slowNote: string; version: number }
let learn: Learn = { learned: {}, hazards: [], devZones: [], on: true };
let info: LiveInfo = { speedKmh: null, left: 0, etaSec: 0, near: null, slowNote: '', version: 0 };
const subs = new Set<() => void>();
const bump = (p: Partial<LiveInfo> = {}) => { info = { ...info, ...p, version: info.version + 1 }; subs.forEach(f => f()); };
const subscribe = (f: () => void) => { subs.add(f); return () => { subs.delete(f); }; };
const SERVER_INFO: LiveInfo = { speedKmh: null, left: 0, etaSec: 0, near: null, slowNote: '', version: 0 };

export const getLearn = () => learn;
export const getLive = () => info;
export const useLive = () => ({ info: useSyncExternalStore(subscribe, () => info, () => SERVER_INFO), learn });

export interface LiveCtx {
  route: Route; stops: Stop[]; me: LatLon; curId: string | null; track: number[][]; busy: boolean;
  reroute: () => void; status: (m: string, ms?: number) => void;
}

let loaded = false, dirty = false;
export async function liveLoad() {
  if (loaded) return;
  loaded = true;
  const on = await local.kvGet<boolean>('learnOn');
  learn = {
    learned: (await local.kvGet('speedmap')) || {}, hazards: (await local.kvGet('hazards')) || [],
    devZones: (await local.kvGet('devzones')) || [], on: on == null ? true : !!on,
  };
  bump();
}

export async function saveLearned() {
  if (!dirty) return;
  dirty = false;
  const keys = Object.keys(learn.learned);
  if (keys.length > 30000) for (const k of keys.slice(0, keys.length - 30000)) delete learn.learned[k];   // limita o tamanho
  await local.kvSet('speedmap', learn.learned);
}

export async function setLearnOn(on: boolean) { learn = { ...learn, on }; bump(); await local.kvSet('learnOn', on); }

/* ---------- Problemas marcados ---------- */
export async function addHazard(type: string, at: LatLon) {
  learn = { ...learn, hazards: [...learn.hazards, { id: newId(), lat: at.lat, lon: at.lon, type, ts: Date.now() }] };
  bump();
  await local.kvSet('hazards', learn.hazards);
  return `${HAZARD[type].icon} ${HAZARD[type].label} marcado: as próximas rotas evitam este trecho.`;
}
export async function removeHazard(id: string) { learn = { ...learn, hazards: learn.hazards.filter(h => h.id !== id) }; bump(); await local.kvSet('hazards', learn.hazards); }
export async function removeFav(id: string) { learn = { ...learn, devZones: learn.devZones.filter(z => z.id !== id) }; bump(); await local.kvSet('devzones', learn.devZones); }
export async function clearLearned() {
  learn = { ...learn, learned: {}, hazards: [], devZones: [] }; curDev = null; dirty = false; bump();
  await local.kvSet('speedmap', {}); await local.kvSet('hazards', []); await local.kvSet('devzones', []);
}
export function learnSummary() {
  const slow = Object.values(learn.learned).filter(isSlowCell).length;
  return `${slow} trecho(s) lento(s) aprendido(s) · ${learn.hazards.length} marcação(ões) sua(s) · ${learn.devZones.filter(z => z.n >= FAV_MIN).length} via(s) favorita(s).`;
}

/* ---------- Aprendizado a partir do GPS ---------- */
interface Fix { lat: number; lon: number; t: number; stopped: boolean }
let lastFix: Fix | null = null;
function learnFix(p: GeolocationPosition, nearStop: (pt: LatLon) => boolean) {
  if (p.coords.accuracy > 40) return;                      // GPS ruim: ignora
  const t = p.timestamp || Date.now();
  const pt: Fix = { lat: p.coords.latitude, lon: p.coords.longitude, t, stopped: false };
  if (lastFix) {
    const dt = (t - lastFix.t) / 1000;
    if (dt >= 1 && dt <= 20) {
      const v = haversine(lastFix, pt) / dt;
      if (v < 80 / 3.6) {                                  // descarta saltos de GPS
        const key = lcKey(pt.lat, pt.lon);
        const c: Cell = (learn.learned[key] ||= [0, 0, 0, 0]);
        if (v < 1.4) {                                     // parado (< 5 km/h)
          pt.stopped = true;
          if (!nearStop(pt)) {                             // parar para entregar não conta como problema da rua
            if (!lastFix.stopped) c[2]++;
            c[3] += dt;
          }
        } else { c[0]++; c[1] += v; }
        dirty = true;
      }
    }
  }
  lastFix = pt;
}

/* ---------- Desvio da rota sugerida (vias favoritas) ---------- */
let curDev: { routeId: string; idx: number; lat: number; lon: number; ahead: number[][] } | null = null;

function devLength(track: number[][]) {
  if (!curDev) return 0;
  let d = 0;
  for (let i = curDev.idx + 1; i < track.length; i++) d += haversine({ lat: track[i - 1][0], lon: track[i - 1][1] }, { lat: track[i][0], lon: track[i][1] });
  return d;
}
function startDev(route: Route, coords: number[][], since: number, track: number[][]) {
  if (curDev || !track.length) return;
  let idx = track.findIndex(q => q[2] >= since - 3000);
  if (idx < 0) idx = track.length - 1;
  const nr = nearestOnRoute({ lat: track[idx][0], lon: track[idx][1] }, coords);
  const cum = cumulative(coords), lim = cum[nr.i] + 1500, ahead: number[][] = [];
  for (let k = nr.i; k < coords.length && cum[k] <= lim; k++) ahead.push(coords[k]);
  curDev = { routeId: route.id, idx, lat: coords[nr.i][0], lon: coords[nr.i][1], ahead };
}
// O desvio termina quando você volta para a rota sugerida (ou depois de 1,5 km, entrega feita ou fim da rota).
function checkDev(track: number[][], me: LatLon, status: LiveCtx['status']) {
  if (!curDev) return;
  const len = devLength(track);
  if (len < 80) return;
  const back = curDev.ahead.length > 1 && nearestOnRoute(me, curDev.ahead).d < 40;
  if (back || len > 1500) void finishDev(track, status);
}
export async function finishDev(track: number[][], status?: LiveCtx['status']) {
  const d = curDev;
  curDev = null;
  if (!d) return;
  const path: [number, number][] = [];
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
  if (len < 80) return;                                    // movimento curto demais: ruído de GPS
  const zones = [...learn.devZones];
  let z = zones.find(x => haversine(x, d) < 150) as DevZone | undefined;
  if (!z) zones.push(z = { id: newId(), lat: d.lat, lon: d.lon, n: 0, routes: [], path: null });
  if (!z.routes.includes(d.routeId)) { z.routes.push(d.routeId); z.n++; }
  z.path = path;                                           // vale o caminho mais recente
  learn = { ...learn, devZones: zones };
  bump();
  await local.kvSet('devzones', zones);
  if (z.n === FAV_MIN) status?.('⭐ Você ignorou a sugestão aqui 3 vezes: o seu caminho virou via favorita.', 6000);
}

/* ---------- A cada posição do GPS durante a rota ---------- */
const arrived = new Set<string>(), navSaid = new Set<string>();
let offSince = 0, lastReroute = 0, lastSlowCheck = 0, lastSlowReroute = 0, slowSig: string | null = null, slowNote = '';

export function liveReset() { lastFix = null; arrived.clear(); navSaid.clear(); offSince = 0; slowSig = null; slowNote = ''; curDev = null; bump({ near: null, left: 0, etaSec: 0, speedKmh: null, slowNote: '' }); }

export function liveFix(p: GeolocationPosition, c: LiveCtx) {
  const r = c.route, me = c.me;
  const pending = c.stops.filter(s => s.routeId === r.id && !s.done).sort((a, b) => a.order - b.order);
  learnFix(p, pt => c.stops.some(s => s.routeId === r.id && s.lat != null && haversine(pt, { lat: s.lat!, lon: s.lon! }) < 40));
  const speedKmh = p.coords.speed != null && p.coords.speed >= 0 ? Math.round(p.coords.speed * 3.6) : null;

  const nxt = pending.find(s => s.lat != null);
  if (nxt && c.curId === r.id && haversine(me, { lat: nxt.lat!, lon: nxt.lon! }) < 35 && !arrived.has(nxt.id)) {
    arrived.add(nxt.id);
    c.status('📍 Você chegou: toque em Marcar entrega quando entregar.', 6000);
    say('Você chegou: ' + spokenAddr(nxt) + '.', 'arr' + nxt.id);
    if (navigator.vibrate) navigator.vibrate(200);
  }

  const geo = r.geo;
  if (!geo || !geo.coords || geo.coords.length < 2 || c.curId !== r.id) { bump({ speedKmh, near: null, left: 0, etaSec: 0 }); return; }
  const near = nearestOnRoute(me, geo.coords);
  const cum = cumulative(geo.coords), total = cum[cum.length - 1];
  const pos = posOnRoute(geo.coords, near);

  // voz curva a curva
  const v = getVoice();
  if (v.speak && v.nav && near.d <= 80) {
    const t = nextAnnouncement(routeSteps(geo), pos, p.coords.speed || 0, navSaid);
    if (t) say(t, undefined, true);
  }

  // quanto falta pelo caminho planejado
  let left = 0, etaSec = 0;
  if (total > 0 && near.d < 150) { left = Math.max(0, total - pos); etaSec = geo.duration * (left / total); }

  // via lenta à frente (comparada ao tempo médio registrado)
  const dpts = pending.filter(s => s.lat != null).map(s => ({ lat: s.lat!, lon: s.lon! }));
  if (learn.on && near.d < 70 && Date.now() - lastSlowCheck >= 10000) {
    lastSlowCheck = Date.now();
    const a = analyzeAhead(learn, geo, near.i, dpts);
    if (!a.slow) { slowNote = ''; slowSig = null; }
    else {
      slowNote = ` · ⚠ via lenta à frente: média registrada ${fmtDur(a.real)} (previsto ${fmtDur(a.plan)})`;
      if (a.sig !== slowSig && !c.busy && Date.now() - lastSlowReroute >= 60000) {          // já tentou desviar desta; não fica recalculando à toa
        slowSig = a.sig; lastSlowReroute = Date.now();
        c.status('🐢 Via lenta à frente (+' + fmtDur(a.extra) + ' pela média registrada): procurando alternativa…');
        say('Via lenta à frente. Procurando alternativa.', 'slow');
        c.reroute();
      }
    }
  }

  // saiu do caminho por mais de 8 s: recalcula a partir de onde está
  if (near.d > 70) {
    if (!offSince) offSince = Date.now();
    else {
      if (Date.now() - offSince > 8000) startDev(r, geo.coords, offSince, c.track);   // sugestão ignorada: aprende o caminho que você escolheu
      if (Date.now() - offSince > 8000 && Date.now() - lastReroute > 25000 && !c.busy) {
        lastReroute = Date.now(); offSince = 0;
        c.status('↻ Você saiu da rota: recalculando…');
        c.reroute();
      }
    }
  } else offSince = 0;
  checkDev(c.track, me, c.status);

  bump({ speedKmh, near, left, etaSec, slowNote });
}

export const spokenAddr = (s: Pick<Stop, 'raw'>) => String(s.raw || 'endereço sem nome').split(/\s[-–]\s|;|\(/)[0].slice(0, 70);
export const learningActive = () => hasLearning(learn);
export const etaText = () => (info.near && info.left ? `Restam ${fmtDist(info.left)}, ${fmtDur(info.etaSec)}.` : '');
