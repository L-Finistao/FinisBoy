import { local } from './local-db';
import { geocode, ensureAutoCity, type GeoCtx } from '../core/geocode';
import { optimizeRoute } from '../core/routing';
import { newId, haversine, fmtDist } from '../core/format';
import { parseText } from '../core/text';
import { DEFAULT_PAY, autoProfileId, newProfile, normPid, type Expense, type Pay, type Profile } from '../core/earnings';
import { setLiveTrackGuard } from './sync';
import { finishDev, getLearn, liveFix, liveLoad, liveReset, saveLearned, spokenAddr } from './live';
import { loadVoice, say } from './voice';
import { hasLearning, routePenalty } from '../core/learn';
import type { Delivery, LatLon, Route, Stop } from '../core/types';

/* Estado do app (rotas, paradas, entregas). Tudo é lido e gravado no aparelho (IndexedDB);
   o backup para a conta é feito por sync.ts, que observa as gravações. */

export interface AppState {
  ready: boolean; routes: Route[]; stops: Stop[]; deliveries: Delivery[];
  curId: string | null; me: LatLon | null; city: string; pay: Pay; target: number;
  profiles: Profile[]; expenses: Expense[]; lastProfile: string | null;
  busy: boolean; status: string; picking: string | null;
}

let state: AppState = { ready: false, routes: [], stops: [], deliveries: [], curId: null, me: null, city: '', pay: DEFAULT_PAY, target: 15, profiles: [], expenses: [], lastProfile: null, busy: false, status: '', picking: null };
const subs = new Set<() => void>();
const set = (p: Partial<AppState>) => { state = { ...state, ...p }; subs.forEach(f => f()); };
export const getApp = () => state;
export const subscribeApp = (f: () => void) => { subs.add(f); return () => { subs.delete(f); }; };

/* ---------- Consultas ---------- */
export const routeStops = (id: string) => state.stops.filter(s => s.routeId === id);
export const pendingStops = (id: string | null) => state.stops.filter(s => s.routeId === id && !s.done).sort((a, b) => a.order - b.order);
export const activeRoutes = () => state.routes.filter(r => r.status !== 'finalizada').sort((a, b) => a.createdAt - b.createdAt);
export const currentRoute = () => state.routes.find(r => r.id === state.curId) || null;
export const session = () => state.routes.find(r => r.status === 'andamento') || null;

/* ---------- Gravação (estado + aparelho) ---------- */
const saveRoute = async (r: Route) => { set({ routes: state.routes.some(x => x.id === r.id) ? state.routes.map(x => (x.id === r.id ? r : x)) : [...state.routes, r] }); await local.put('routes', r); };
const saveStop = async (s: Stop) => { set({ stops: state.stops.some(x => x.id === s.id) ? state.stops.map(x => (x.id === s.id ? s : x)) : [...state.stops, s] }); await local.put('stops', s); };
const patchStop = (s: Stop, p: Partial<Stop>) => saveStop({ ...s, ...p });

let geoCache: Record<string, any> = {}, geoTimer: ReturnType<typeof setTimeout> | undefined;
const geoCtx = (): GeoCtx => ({
  city: state.city, me: state.me, cache: geoCache,
  save: () => { clearTimeout(geoTimer); geoTimer = setTimeout(() => local.kvSet('geocache', geoCache, true), 500); },   // cache só no aparelho
});

export const setStatus = (status: string, ms = 0) => {
  set({ status });
  if (status && ms) setTimeout(() => { if (state.status === status) set({ status: '' }); }, ms);
};

/* ---------- Trajeto gravado durante a rota ---------- */
// [lat, lon, horário, km/h do GPS]: grava a cada ~6 m ou 10 s. É o que o histórico mostra no mapa.
let track: number[][] = [], trackId: string | null = null, trackDirty = false;
function recordTrack(p: GeolocationPosition) {
  if (!trackId || p.coords.accuracy > 30) return;          // GPS impreciso: ignora
  const t = p.timestamp || Date.now();
  const sp = p.coords.speed != null && p.coords.speed >= 0 ? Math.round(p.coords.speed * 3.6) : null;
  const pt = [+p.coords.latitude.toFixed(6), +p.coords.longitude.toFixed(6), t, sp as number];
  const last = track[track.length - 1];
  const moved = last ? haversine({ lat: last[0], lon: last[1] }, { lat: pt[0], lon: pt[1] }) : Infinity;
  if (!last || (moved >= 6 && t - last[2] >= 1000) || t - last[2] >= 10000) { track.push(pt); trackDirty = true; }
}
async function saveTrack() {
  if (!trackId || !trackDirty) return;
  trackDirty = false;
  await local.put('tracks', { id: trackId, pts: track } as { id: string });
}

/* ---------- Posição ---------- */
let watchId: number | null = null, lastSaved = 0;
function onPosition(p: GeolocationPosition) {
  const me = { lat: p.coords.latitude, lon: p.coords.longitude };
  const r = session();
  let routes = state.routes, moved: Route | null = null;
  if (r && p.coords.accuracy <= 60) {                    // GPS impreciso: ignora
    const last = r.lastPt, d = last ? haversine(last, me) : 0;
    if (!last || d >= 15) {                              // d < 15: parado/ruído
      moved = { ...r, km: (r.km || 0) + (last && d <= 1500 ? d : 0), lastPt: me };   // > 1500 m: salto do GPS, não conta
      routes = routes.map(x => (x.id === r.id ? moved! : x));
    }
  }
  if (r) recordTrack(p);
  set({ me, routes });
  const live = session();
  if (live) {
    liveFix(p, {
      route: live, stops: state.stops, curId: state.curId, me, track, busy: state.busy,
      reroute: () => { void buildRoute(); }, status: (m, ms) => setStatus(m, ms),
    });
  }
  if (Date.now() - lastSaved > 10000) {                  // grava no aparelho a cada 10 s (não a cada ponto do GPS)
    lastSaved = Date.now();
    void local.kvSet('lastMe', me, true);
    const cur = session();
    if (cur) { void local.put('routes', cur); void saveTrack(); void saveLearned(); }
  }
}
export function watchPosition() {
  if (watchId != null || !navigator.geolocation) return;
  watchId = navigator.geolocation.watchPosition(onPosition, () => {}, { enableHighAccuracy: true, maximumAge: 10000 });
}
export const getPosition = () => new Promise<LatLon | null>(res => {
  if (!navigator.geolocation) return res(state.me);
  navigator.geolocation.getCurrentPosition(p => { onPosition(p); res(state.me); }, () => res(state.me), { enableHighAccuracy: true, timeout: 8000, maximumAge: 15000 });
});

/* ---------- Início ---------- */
export async function init() {
  if (state.ready) return;
  const [stops, routes, deliveries] = await Promise.all([local.all<Stop>('stops'), local.all<Route>('routes'), local.all<Delivery>('deliveries')]);
  geoCache = (await local.kvGet('geocache')) || {};
  const me = (await local.kvGet<LatLon>('lastMe')) || null;
  const city = (await local.kvGet<string>('city')) || '';
  const pay = { ...DEFAULT_PAY, ...((await local.kvGet<Partial<Pay>>('pay')) || {}) };
  const t = await local.kvGet<number>('target');
  const expenses = await local.all<Expense>('expenses');
  let profiles = (await local.kvGet<Profile[]>('profiles')) || [];
  if (!profiles.length) {                                  // migra o modelo único de versões anteriores
    profiles = [{ ...newProfile(newId(), 'Padrão'), mode: pay.mode || 'entrega', perDelivery: pay.perDelivery || 0, fixed: pay.fixed || 0 }];
    await local.kvSet('profiles', profiles);
  }
  const lastProfile = (await local.kvGet<string>('lastProfile')) || null;
  const running = routes.find(r => r.status === 'andamento');
  const first = routes.filter(r => r.status !== 'finalizada').sort((a, b) => a.createdAt - b.createdAt)[0];
  set({ stops, routes, deliveries, expenses, profiles, lastProfile, me, city, pay, target: t ?? 15, curId: running?.id || first?.id || null, ready: true });
  const live = routes.find(r => r.status === 'andamento');
  if (live) { const tk = await local.get<{ pts: number[][] }>('tracks', live.id); track = tk ? tk.pts : []; trackId = live.id; trackDirty = false; }
  await Promise.all([liveLoad(), loadVoice()]);
  setLiveTrackGuard(id => session()?.id === id);            // o trajeto da rota em andamento só vai para o backup no fim
  document.addEventListener('visibilitychange', () => { if (document.hidden) void saveTrack(); });
  watchPosition();
  void navigator.storage?.persist?.();                    // evita o celular apagar os dados
}

export const selectRoute = (id: string) => set({ curId: id });
export const setCity = async (city: string) => { set({ city }); await local.kvSet('city', city); };

/* ---------- Cálculo da rota ---------- */
async function geocodeAll(r: Route, notes: string[]) {
  // sem posição, ou os que o usuário marcou no mapa não mudam
  const todo = state.stops.filter(s => s.routeId === r.id && !s.done && s.src !== 'manual' && s.lat == null);
  if (todo.length) await ensureAutoCity(geoCtx());
  for (let i = 0; i < todo.length; i++) {
    const s = todo[i];
    setStatus(`Localizando endereços ${i + 1}/${todo.length}…`);
    try {
      const g = await geocode(s, geoCtx());
      if (g) await patchStop(s, { lat: g.lat, lon: g.lon, label: g.label, failed: false, approx: g.approx, src: g.src, precision: g.precision });
      else await patchStop(s, { failed: true });
    } catch {                                              // sem internet: segue com o que já foi localizado
      notes.push(`Sem internet: ${todo.length - i} endereço(s) serão localizados quando a conexão voltar (toque em Recalcular rota).`);
      return;
    }
  }
  const falhas = state.stops.filter(s => s.routeId === r.id && !s.done && s.failed).length;
  if (falhas) notes.unshift(`${falhas} endereço(s) não localizado(s): toque em ✎ para corrigir ou 📍 para marcar no mapa.`);
}

async function optimize(r: Route, notes: string[]) {
  const list = state.stops.filter(s => s.routeId === r.id && !s.done && s.lat != null);
  if (!list.length) { await saveRoute({ ...r, geo: null }); return; }
  await getPosition();
  const me = state.me, start = !!me;
  const pts: LatLon[] = start ? [me!, ...list.map(s => ({ lat: s.lat!, lon: s.lon! }))] : list.map(s => ({ lat: s.lat!, lon: s.lon! }));
  if (pts.length < 2) { await patchStop(list[0], { order: 0, legDist: null, legDur: null }); await saveRoute({ ...r, geo: null }); return; }

  setStatus('Calculando o melhor caminho…');
  const learn = getLearn(), deliveries = list.map(x => ({ lat: x.lat!, lon: x.lon! }));
  const pen = hasLearning(learn) ? (coords: number[][], v: number) => routePenalty(learn, coords, v, deliveries) : undefined;
  const { result: res, warn } = await optimizeRoute(pts, start, pen);
  if (warn) notes.push(warn);
  const off = start ? 1 : 0;
  for (const [k, s] of list.entries()) {
    const order = res.position[k + off] - off, leg = res.legs[order + off - 1];
    await patchStop(s, { order, legDist: leg ? leg.distance : null, legDur: leg ? leg.duration : null });
  }
  const { coords, distance, duration, approx, baseline, steps, learned } = res;
  if (learned) notes.push('Evitando trechos lentos aprendidos.');
  await saveRoute({ ...r, geo: { coords, distance, duration, approx, baseline, steps, learned } });
}

let rerun = false;
export async function buildRoute() {
  if (state.busy) { rerun = true; return; }                // já calculando: refaz logo depois (não perde o endereço que acabou de entrar)
  const r = currentRoute();
  if (!r) return;
  set({ busy: true });
  const notes: string[] = [];
  try {
    await geocodeAll(r, notes);
    await optimize(currentRoute() || r, notes);
    setStatus(notes.join(' · '), notes.length ? 9000 : 0);
  } catch (e) {
    console.error(e);
    setStatus('Não foi possível calcular agora (' + ((e as Error).message || 'erro') + '). Verifique a internet.');
  } finally {
    set({ busy: false });
    if (rerun) { rerun = false; void buildRoute(); }
  }
}

/* ---------- Ações ---------- */
// Endereços novos entram na rota atual (pendente ou em andamento); só cria rota nova se não houver nenhuma para iniciar.
export const addTarget = () => { const c = currentRoute(); return c && c.status !== 'finalizada' ? c : activeRoutes()[0] || null; };

const topOf = (xs: string[]) => xs.sort((a, b) => xs.filter(x => x === b).length - xs.filter(x => x === a).length)[0];

export async function addFromText(text: string, profileId?: string) {
  const addrs = parseText(text);
  if (!addrs.length) { setStatus('Nenhum endereço encontrado no texto.', 4000); return; }
  // Alguns endereços vêm sem a UF ("Birigui" em vez de "Birigui - SP"): completa com a UF mais comum da lista.
  const ufs = addrs.map(a => (/ - ([A-Z]{2})$/.exec(a.cityGuess || '') || [])[1]).filter(Boolean);
  if (ufs.length) {
    const top = topOf(ufs);
    for (const a of addrs) if (a.cityGuess && !/ - [A-Z]{2}$/.test(a.cityGuess)) a.cityGuess += ' - ' + top;
    if (!geoCache._uf) geoCache._uf = top;
  }
  // Endereço sem cidade nenhuma: usa a cidade mais comum da lista (ou a cidade padrão).
  const cities = addrs.map(a => a.cityGuess).filter(Boolean);
  if (cities.length && !state.city) {
    const topCity = topOf(cities);
    for (const a of addrs) if (!a.cityGuess) a.cityGuess = topCity;
  }
  let r = addTarget();
  if (!r) {
    const seq = ((await local.kvGet<number>('routeSeq')) || 0) + 1;
    await local.kvSet('routeSeq', seq, true);
    r = { id: newId(), name: 'Rota ' + seq, createdAt: Date.now(), status: 'pendente', km: 0, profileId: normPid(state.profiles, profileId || defaultProfileId()) };
    await saveRoute(r);
  }
  const base = routeStops(r.id).length;
  for (const [i, a] of addrs.entries()) {
    await saveStop({
      id: newId(), routeId: r.id, raw: a.raw, note: a.note, cep: a.cep, cityGuess: a.cityGuess,
      sender: a.sender, when: a.when, addedAt: Date.now(), lat: null, lon: null, done: false, order: 1000 + base + i,
    });
  }
  set({ curId: r.id });
  setStatus(`${addrs.length} endereço(s) adicionado(s) em "${r.name}".`, 3000);
  await buildRoute();
}

export async function startRoute(id: string) {
  const running = session();
  if (running) { setStatus(`Finalize "${running.name}" antes de iniciar outra rota.`, 4000); return; }
  const r = state.routes.find(x => x.id === id);
  if (!r || !routeStops(id).some(s => !s.done)) { setStatus('Esta rota não tem paradas pendentes.', 4000); return; }
  const now = Date.now();
  track = []; trackId = id; trackDirty = true;
  liveReset();
  await saveRoute({ ...r, status: 'andamento', startedAt: now, legStartedAt: now, km: 0, lastPt: null });
  set({ curId: id });
  await buildRoute();                                      // recalcula a partir de onde você está
  const cur = state.routes.find(x => x.id === id);
  if (cur?.geo) await saveRoute({ ...cur, kmPlan: cur.geo.distance });
  say('Rota iniciada. ' + nextStopText());
}

export async function endRoute() {
  const r = session();
  if (!r) return;
  const gps = r.km || 0;
  await saveRoute({
    ...r, status: 'finalizada', endedAt: Date.now(), lastPt: null,
    kmSrc: gps >= 200 ? 'gps' : 'plan', kmFinal: gps >= 200 ? gps : (r.kmPlan || r.geo?.distance || 0),
  });
  await finishDev(track);
  await saveTrack();
  await saveLearned();
  track = []; trackId = null; trackDirty = false;
  liveReset();
  say(`Rota finalizada. ${routeStops(r.id).filter(x => x.done).length} entregas feitas.`);
  set({ curId: activeRoutes()[0]?.id || null });
  setStatus('✓ Rota finalizada e enviada ao histórico.', 4000);
}

export async function deleteRoute(id: string) {
  const r = state.routes.find(x => x.id === id);
  if (!r) return;
  if (r.status === 'andamento') { setStatus('Finalize a rota antes de apagar.', 4000); return; }
  for (const s of routeStops(id)) await local.remove('stops', s.id);
  for (const d of state.deliveries.filter(x => x.routeId === id)) await local.remove('deliveries', d.id);
  await local.remove('routes', id);
  await local.remove('tracks', id);
  const routes = state.routes.filter(x => x.id !== id);
  set({
    stops: state.stops.filter(s => s.routeId !== id), deliveries: state.deliveries.filter(d => d.routeId !== id), routes,
    curId: state.curId === id ? routes.filter(x => x.status !== 'finalizada')[0]?.id || null : state.curId,
  });
}

export async function clearPending() {
  for (const r of state.routes.filter(x => x.status === 'pendente')) await deleteRoute(r.id);
}

async function logDelivery(s: Stop, doneAt: number | null) {
  set({ deliveries: state.deliveries.filter(d => d.id !== s.id) });
  if (doneAt) { const d = { id: s.id, routeId: s.routeId, doneAt }; set({ deliveries: [...state.deliveries, d] }); await local.put('deliveries', d); }
  else await local.remove('deliveries', s.id);
}

export async function markDone(id: string, done: boolean) {
  const s = state.stops.find(x => x.id === id);
  if (!s) return;
  const r = session();
  if (done) {
    const doneAt = Date.now();
    let durSec = s.durSec;
    if (r && s.routeId === r.id) {                         // cronômetro: tempo desta entrega, depois zera para a próxima
      durSec = (doneAt - (r.legStartedAt || doneAt)) / 1000;
      await saveRoute({ ...r, legStartedAt: doneAt });
    }
    await patchStop(s, { done: true, order: 5000, doneAt, durSec });
    await logDelivery(s, doneAt);
    await finishDev(track);
    if (r && s.routeId === r.id && !pendingStops(r.id).length) { await endRoute(); return; }   // acabaram as paradas
  } else {
    const { doneAt: _d, durSec: _s, ...rest } = s;
    await saveStop({ ...rest, done: false });
    await logDelivery(s, null);
  }
  await buildRoute();
  if (done && r && state.curId === r.id) say(nextStopText());
}

export async function removeStop(id: string) {
  const s = state.stops.find(x => x.id === id);
  if (!s) return;
  set({ stops: state.stops.filter(x => x.id !== id) });
  await local.remove('stops', id);
  if (s.done) await logDelivery(s, null);
  await buildRoute();
}

export async function editStop(id: string, raw: string) {
  const s = state.stops.find(x => x.id === id);
  if (!s || !raw.trim()) return;
  await patchStop(s, { raw: raw.trim(), lat: null, lon: null, failed: false, src: undefined });
  await buildRoute();
}

// Marcar a posição tocando no mapa (para endereços que a busca não achou ou achou só na rua).
export function startPicking(id: string) {
  const s = state.stops.find(x => x.id === id);
  if (!s) return;
  set({ picking: id, status: '📍 Toque no mapa onde fica: ' + s.raw });
}
export const cancelPicking = () => { if (state.picking) set({ picking: null, status: '' }); };
export async function placeStop(lat: number, lon: number) {
  const s = state.stops.find(x => x.id === state.picking);
  set({ picking: null, status: '' });
  if (!s) return;
  await patchStop(s, { lat, lon, failed: false, approx: false, src: 'manual', precision: 'manual', label: 'Marcado no mapa' });
  await buildRoute();
}

/* ---------- Períodos de trabalho, custos, meta e gastos ---------- */
export const defaultProfileId = () => autoProfileId(state.profiles) || normPid(state.profiles, state.lastProfile);

export async function saveProfiles(list: Profile[]) {
  const profiles = list.length ? list : [newProfile(newId(), 'Padrão')];
  set({ profiles });
  await local.kvSet('profiles', profiles);
}
export async function savePay(pay: Pay) { set({ pay }); await local.kvSet('pay', pay); }
export async function setTarget(target: number) { set({ target }); await local.kvSet('target', target); }

export async function setRouteProfile(id: string, profileId: string) {
  const r = state.routes.find(x => x.id === id);
  if (r) await saveRoute({ ...r, profileId });
  set({ lastProfile: profileId });
  await local.kvSet('lastProfile', profileId);
}

export async function addExpense(e: Omit<Expense, 'id'>) {
  const x = { ...e, id: newId() };
  set({ expenses: [...state.expenses, x] });
  await local.put('expenses', x);
}
export async function removeExpense(id: string) {
  set({ expenses: state.expenses.filter(e => e.id !== id) });
  await local.remove('expenses', id);
}

// Dados para os cálculos de ganho (ver core/earnings.ts)
export const earningsCtx = () => ({ profiles: state.profiles, routes: state.routes, deliveries: state.deliveries, expenses: state.expenses });

export async function setLastProfile(id: string) { set({ lastProfile: id }); await local.kvSet('lastProfile', id); }

// Texto falado da próxima parada ("Próxima parada: Rua X, a 800 metros.")
export function nextStopText() {
  const n = pendingStops(state.curId).find(x => x.lat != null) || pendingStops(state.curId)[0];
  if (!n) return 'Não há paradas pendentes.';
  const d = state.me && n.lat != null ? ', a ' + fmtDist(haversine(state.me, { lat: n.lat, lon: n.lon! })) : '';
  return 'Próxima parada: ' + spokenAddr(n) + d + '.';
}
