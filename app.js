'use strict';

const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const newId = () => Date.now() + '-' + Math.random().toString(36).slice(2, 7);

/* ---------- Banco local (IndexedDB) ---------- */
const DB = (() => {
  let db;
  const req = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  const store = (name, mode = 'readonly') => db.transaction(name, mode).objectStore(name);
  return {
    open: () => new Promise((res, rej) => {
      const r = indexedDB.open('motoboy', 3);
      r.onupgradeneeded = () => {
        const d = r.result;
        for (const n of ['stops', 'deliveries', 'expenses', 'routes']) if (!d.objectStoreNames.contains(n)) d.createObjectStore(n, { keyPath: 'id' });
        if (!d.objectStoreNames.contains('kv')) d.createObjectStore('kv');
      };
      r.onsuccess = () => { db = r.result; res(); };
      r.onerror = () => rej(r.error);
    }),
    all: () => req(store('stops').getAll()),
    put: s => req(store('stops', 'readwrite').put(s)),
    del: id => req(store('stops', 'readwrite').delete(id)),
    allOf: n => req(store(n).getAll()),
    putOf: (n, o) => req(store(n, 'readwrite').put(o)),
    delOf: (n, id) => req(store(n, 'readwrite').delete(id)),
    get: k => req(store('kv').get(k)),
    set: (k, v) => req(store('kv', 'readwrite').put(v, k)),
  };
})();

/* ---------- Estado ---------- */
// routes:     { id, name, createdAt, status: pendente|andamento|finalizada, geo, startedAt, legStartedAt,
//               endedAt, km (GPS, m), kmPlan (m), kmFinal (m), kmSrc }
// stops:      { id, routeId, raw, note, sender, when, lat, lon, done, doneAt, durSec, order, ... }
// deliveries: { id (= stop id), routeId, doneAt }   histórico para ganhos
let routes = [], stops = [], deliveries = [], expenses = [];
let curId = null;          // rota selecionada (mapa e lista de paradas)
let session = null;        // rota em andamento (no máximo uma)
let me = null;             // { lat, lon }
let city = '';
let busy = false;
let target = 15;           // tempo médio de entrega desejado (min)
let follow = true;         // mapa acompanha a posição durante a rota
let tab = 'routes';
let daySel = '';
// mode: entrega | fixo | misto. Custos da moto: gasolina (R$/L e km/L), óleo (R$ e km entre trocas) e outros (R$/km).
let pay = { mode: 'entrega', perDelivery: 0, fixed: 0, fuelPrice: 0, kmPerL: 0, oilPrice: 0, oilKm: 0, otherKm: 0 };

// Custo estimado por km rodado, em partes.
function costParts() {
  return {
    fuel: pay.kmPerL > 0 ? pay.fuelPrice / pay.kmPerL : 0,
    oil: pay.oilKm > 0 ? pay.oilPrice / pay.oilKm : 0,
    other: pay.otherKm || 0,
  };
}
const costPerKm = () => { const c = costParts(); return c.fuel + c.oil + c.other; };
const CITY_ZOOM = 13;     // zoom que mostra a cidade inteira
let geoCache = {};         // endereço -> { lat, lon, label }: evita consultar de novo e funciona offline
let saveGeoTimer;
const saveGeoCache = () => { clearTimeout(saveGeoTimer); saveGeoTimer = setTimeout(() => DB.set('geocache', geoCache), 500); };
let map, markersLayer, routeLine, meMarker;

const cur = () => routes.find(r => r.id === curId) || null;
const pending = () => stops.filter(s => s.routeId === curId && !s.done).sort((a, b) => a.order - b.order);
const routeStops = id => stops.filter(s => s.routeId === id);
const active = () => routes.filter(r => r.status !== 'finalizada').sort((a, b) => a.createdAt - b.createdAt);
const putRoute = r => DB.putOf('routes', r);

/* ---------- Formatação ---------- */
const pad2 = n => String(n).padStart(2, '0');
const dayKey = ts => { const d = new Date(ts); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; };
const fmtDay = k => `${k.slice(8)}/${k.slice(5, 7)}`;
const fmtTime = ts => { const d = new Date(ts); return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`; };
const money = v => (v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
// Aceita "6,50", "6.50" e "1.234,50".
const parseMoney = v => {
  const s = String(v).trim();
  const n = parseFloat(s.includes(',') || !/^\d+\.\d{1,2}$/.test(s) ? s.replace(/\./g, '').replace(',', '.') : s);
  return isNaN(n) ? 0 : n;
};
const fmtDist = m => (m / 1000).toFixed(1).replace('.', ',') + ' km';
const fmtKm = km => km.toFixed(1).replace('.', ',') + ' km';
const fmtDur = s => {
  const m = Math.round(s / 60);
  return m < 60 ? m + ' min' : Math.floor(m / 60) + ' h ' + (m % 60 ? (m % 60) + ' min' : '');
};
const fmtClock = sec => {
  sec = Math.max(0, Math.round(sec));
  const h = Math.floor(sec / 3600), m = Math.floor(sec / 60) % 60, s = sec % 60;
  return h ? `${h}:${pad2(m)}:${pad2(s)}` : `${pad2(m)}:${pad2(s)}`;
};
const haversine = (a, b) => {
  const t = x => x * Math.PI / 180;
  const h = Math.sin(t(b.lat - a.lat) / 2) ** 2 + Math.cos(t(a.lat)) * Math.cos(t(b.lat)) * Math.sin(t(b.lon - a.lon) / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(h));
};

/* ---------- Geocodificação das paradas da rota selecionada ---------- */
async function geocodeAll() {
  // sem posição, ou achados só offline (refinados quando há internet); os que o usuário marcou no mapa não mudam
  const todo = stops.filter(s => s.routeId === curId && !s.done && s.src !== 'manual' && (s.lat == null || (s.src === 'offline' && navigator.onLine)));
  for (let i = 0; i < todo.length; i++) {
    const s = todo[i];
    setStatus(`Localizando endereços ${i + 1}/${todo.length}…`);
    try {
      const g = await geocode(s);
      if (g) Object.assign(s, { lat: g.lat, lon: g.lon, label: g.label, failed: false, approx: !!g.approx, src: g.src || 'online', precision: g.precision });
      else if (s.lat == null) s.failed = true;
    } catch (e) {                         // sem internet: segue com o que já foi localizado
      lastWarn = `Sem internet: ${todo.length - i} endereço(s) serão localizados quando a conexão voltar (toque em Recalcular rota).`;
      return;
    }
    await DB.put(s);
    render();
  }
  const falhas = stops.filter(s => s.routeId === curId && !s.done && s.failed).length;
  if (falhas) geoFailMsg = `${falhas} endereço(s) não localizado(s): toque em ✎ para corrigir ou 📍 para marcar no mapa.`;
}

// Marca a posição de uma parada tocando no mapa (para endereços que a busca não achou ou achou só na rua).
let picking = null;
function placeOnMap(id) {
  const s = stops.find(x => x.id === id);
  if (!s) return;
  picking = id;
  if (tab !== 'routes') showTab('routes');
  setStatus('📍 Toque no mapa onde fica: ' + s.raw);
}

async function onMapClick(e) {
  if (!picking) return;
  const s = stops.find(x => x.id === picking);
  picking = null;
  setStatus('');
  if (!s) return;
  Object.assign(s, { lat: e.latlng.lat, lon: e.latlng.lng, failed: false, approx: false, src: 'manual', precision: 'manual', label: 'Marcado no mapa' });
  await DB.put(s);
  await buildRoute();
}

/* ---------- Posição atual e quilometragem ---------- */
let lastSaved = 0, centered = false;

function trackKm(p) {
  if (p.coords.accuracy > 60) return;                  // GPS impreciso: ignora
  const last = session.lastPt;
  if (last) {
    const d = haversine(last, me);
    if (d < 15) return;                                // parado / ruído
    if (d <= 1500) session.km = (session.km || 0) + d;
  }
  session.lastPt = { lat: me.lat, lon: me.lon };
}

function setMe(p) {
  me = { lat: p.coords.latitude, lon: p.coords.longitude };
  drawMe();
  if (session) trackKm(p);
  if (Date.now() - lastSaved > 10000) {
    lastSaved = Date.now();
    DB.set('lastMe', me);
    if (session) putRoute(session);
  }
  if (!centered) {                       // primeira posição: mostra a cidade inteira, sem precisar de zoom
    centered = true;
    if (!cur()) map.setView([me.lat, me.lon], CITY_ZOOM);
  } else if (session && follow) map.panTo([me.lat, me.lon]);
}

function getPosition() {
  return new Promise(res => {
    if (!navigator.geolocation) return res(me);
    navigator.geolocation.getCurrentPosition(
      p => { setMe(p); res(me); },
      () => res(me),
      { enableHighAccuracy: true, timeout: 8000, maximumAge: 15000 }
    );
  });
}

function watchPosition() {
  if (!navigator.geolocation) return;
  navigator.geolocation.watchPosition(setMe, () => {}, { enableHighAccuracy: true, maximumAge: 10000 });
}

/* ---------- Otimização da rota (OSRM /trip = caixeiro-viajante) ---------- */
// Melhor ordem possível: pega as distâncias reais entre todos os pontos (OSRM /table) e escolhe a ordem de
// menor tempo (exata até 13 paradas), depois traça o caminho nessa ordem.
async function osrmBest(pts, start) {
  const base = 'https://router.project-osrm.org';
  const cs = a => a.map(p => `${p.lon},${p.lat}`).join(';');
  const tj = await (await fetch(`${base}/table/v1/driving/${cs(pts)}?annotations=duration,distance`)).json();
  if (tj.code !== 'Ok') throw new Error(tj.message || tj.code);
  const fix = m => m.map(row => row.map(v => (v == null ? 1e9 : v)));
  const T = fix(tj.durations), D = fix(tj.distances);
  const { order, position } = planOrder(T, pts.length, start);
  const rj = await (await fetch(`${base}/route/v1/driving/${cs(order.map(i => pts[i]))}?overview=full&geometries=geojson&steps=false`)).json();
  if (rj.code !== 'Ok') throw new Error(rj.message || rj.code);
  const rt = rj.routes[0];
  return {
    position, legs: rt.legs, distance: rt.distance, duration: rt.duration,
    coords: rt.geometry.coordinates.map(([lon, lat]) => [lat, lon]),
    baseline: baselineCost(T, D),
  };
}

// Plano B online: ordem escolhida pelo próprio OSRM (aproximada).
async function osrmTrip(pts, start) {
  const coords = pts.map(p => `${p.lon},${p.lat}`).join(';');
  const url = `https://router.project-osrm.org/trip/v1/driving/${coords}` +
    `?roundtrip=false&source=${start ? 'first' : 'any'}&destination=any&geometries=geojson&overview=full`;
  const resp = await fetch(url);
  const j = await resp.json();
  if (j.code !== 'Ok') throw new Error(j.message || j.code);
  const trip = j.trips[0];
  return {
    position: j.waypoints.map(w => w.waypoint_index),
    legs: trip.legs,
    coords: trip.geometry.coordinates.map(([lon, lat]) => [lat, lon]),
    distance: trip.distance,
    duration: trip.duration,
  };
}

// Plano B sem internet: vizinho mais próximo + 2-opt, distâncias em linha reta (x1,3 para aproximar as ruas).
function localTrip(pts) {
  const n = pts.length;
  const d = (i, j) => haversine(pts[i], pts[j]);
  const order = [0], used = Array(n).fill(false);
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
  const position = Array(n);
  order.forEach((idx, p) => { position[idx] = p; });
  const legs = [];
  for (let p = 0; p < n - 1; p++) {
    const dist = d(order[p], order[p + 1]) * FATOR;
    legs.push({ distance: dist, duration: dist / MS });
  }
  const distance = legs.reduce((a, l) => a + l.distance, 0);
  return {
    position, legs, distance, duration: distance / MS, approx: true,
    coords: order.map(i => [pts[i].lat, pts[i].lon]),
  };
}

async function optimize() {
  const r = cur();
  if (!r) return;
  const list = stops.filter(s => s.routeId === r.id && !s.done && s.lat != null);
  if (!list.length) { r.geo = null; await putRoute(r); return; }

  await getPosition();
  const start = !!me;
  const pts = start ? [me, ...list] : list;

  if (pts.length < 2) {                       // uma parada e sem GPS: nada a otimizar
    list[0].order = 0; delete list[0].legDist; delete list[0].legDur;
    r.geo = null; await putRoute(r); await DB.put(list[0]);
    return;
  }

  setStatus('Calculando o melhor caminho…');
  let res;
  try {
    if (!navigator.onLine) throw new Error('offline');
    try { res = await osrmBest(pts, start); } catch (e) { res = await osrmTrip(pts, start); }
  } catch (e) {
    try {
      res = await offlineTrip(pts, start);   // mapa salvo no aparelho: melhor ordem pelas ruas reais
      lastWarn = 'Modo offline: rota calculada com o mapa salvo no aparelho.';
    } catch (e2) {
      res = localTrip(pts);                  // sem pacote: vizinho mais próximo, em linha reta
      lastWarn = packReady() ? 'Modo offline: ponto fora do pacote salvo, rota em linha reta (aproximada).'
        : 'Modo offline sem pacote: rota em linha reta (aproximada). Baixe o pacote da cidade com internet.';
    }
  }

  const off = start ? 1 : 0;
  list.forEach((s, k) => {
    s.order = res.position[k + off] - off;
    const leg = res.legs[s.order + off - 1];
    s.legDist = leg ? leg.distance : null;
    s.legDur = leg ? leg.duration : null;
  });
  r.geo = { coords: res.coords, distance: res.distance, duration: res.duration, approx: !!res.approx, baseline: res.baseline || null };
  const saved = res.baseline ? res.baseline.duration - res.duration : 0;
  lastInfo = `✓ Melhor rota: ${list.length} parada(s) · ${fmtDist(res.distance)} · ${fmtDur(res.duration)}` +
    (saved > 60 ? ` · ${fmtDur(saved)} a menos que na ordem colada` : '');
  await putRoute(r);
  await Promise.all(list.map(s => DB.put(s)));
}

/* ---------- Ações ---------- */
let statusTimer, lastWarn = '', lastInfo = '', geoFailMsg = '';
function setStatus(msg, ms) {
  const el = $('status');
  el.hidden = !msg;
  el.textContent = msg || '';
  clearTimeout(statusTimer);
  if (msg && ms) statusTimer = setTimeout(() => setStatus(''), ms);
}

async function run(fn, { fit = true } = {}) {
  if (busy) return;
  busy = true;
  document.querySelectorAll('button').forEach(b => (b.disabled = true));
  try {
    lastWarn = ''; lastInfo = ''; geoFailMsg = '';
    await fn();
    const msg = [geoFailMsg, lastWarn || lastInfo].filter(Boolean).join(' · ');
    setStatus(msg, msg ? 9000 : 0);
  } catch (e) {
    console.error(e);
    setStatus('Não foi possível calcular agora (' + (e.message || 'erro') + '). Verifique a internet.');
  } finally {
    busy = false;
    document.querySelectorAll('button').forEach(b => (b.disabled = false));
    render(fit);
  }
}

const buildRoute = (fit = true) => run(async () => { await geocodeAll(); await optimize(); }, { fit });

// Cada colagem de endereços vira uma rota nova, que pode ser iniciada separadamente.
async function addFromText(text) {
  const addrs = parseText(text);
  if (!addrs.length) { setStatus('Nenhum endereço encontrado no texto.', 4000); return; }
  const seq = ((await DB.get('routeSeq')) || 0) + 1;
  await DB.set('routeSeq', seq);
  const r = { id: newId(), name: 'Rota ' + seq, createdAt: Date.now(), status: 'pendente', km: 0 };
  routes.push(r);
  await putRoute(r);
  for (const [i, a] of addrs.entries()) {
    const s = {
      id: newId(), routeId: r.id,
      raw: a.raw, note: a.note, cep: a.cep, cityGuess: a.cityGuess,
      sender: a.sender, when: a.when, addedAt: Date.now(),
      lat: null, lon: null, done: false, order: 1000 + i,
    };
    stops.push(s);
    await DB.put(s);
  }
  curId = r.id;
  showTab('routes');
  render();
  await buildRoute();
}

async function startRoute(id) {
  if (session) { setStatus(`Finalize "${session.name}" antes de iniciar outra rota.`, 4000); return; }
  const r = routes.find(x => x.id === id);
  if (!r || !routeStops(id).some(s => !s.done)) { setStatus('Esta rota não tem paradas pendentes.', 4000); return; }
  const now = Date.now();
  Object.assign(r, { status: 'andamento', startedAt: now, legStartedAt: now, km: 0, lastPt: null });
  await putRoute(r);
  session = r; curId = r.id; follow = true;
  applySessionUI();
  await buildRoute();        // recalcula a partir de onde você está e enquadra o mapa
  if (r.geo) { r.kmPlan = r.geo.distance; await putRoute(r); }
}

async function endRoute() {
  const r = session;
  if (!r) return;
  const rs = routeStops(r.id);
  const feitas = rs.filter(s => s.done).length;
  const dn = rs.filter(s => s.durSec != null);
  const avg = dn.length ? dn.reduce((a, s) => a + s.durSec, 0) / dn.length : null;
  const msg = `${feitas} de ${rs.length} entrega(s) em ${fmtClock((Date.now() - r.startedAt) / 1000)}` +
    (avg != null ? ` · média ${fmtClock(avg)}` : '') + '\n\nFinalizar a rota e enviar para o histórico?';
  if (!confirm(msg)) return;
  const gps = r.km || 0;
  Object.assign(r, {
    status: 'finalizada', endedAt: Date.now(), lastPt: null,
    kmSrc: gps >= 200 ? 'gps' : 'plan',
    kmFinal: gps >= 200 ? gps : (r.kmPlan || r.geo?.distance || 0),
  });
  await putRoute(r);
  session = null;
  curId = active()[0]?.id || null;
  applySessionUI();
  render(true);
  setStatus('✓ Rota finalizada e enviada ao histórico.', 4000);
}

async function deleteRoute(id) {
  const r = routes.find(x => x.id === id);
  if (!r) return;
  if (r.status === 'andamento') { setStatus('Finalize a rota antes de apagar.', 4000); return; }
  if (!confirm(`Apagar "${r.name}"${r.status === 'finalizada' ? ' do histórico (os ganhos dela também saem da conta)' : ''}?`)) return;
  for (const s of routeStops(id)) await DB.del(s.id);
  for (const d of deliveries.filter(x => x.routeId === id)) await DB.delOf('deliveries', d.id);
  await DB.delOf('routes', id);
  stops = stops.filter(s => s.routeId !== id);
  deliveries = deliveries.filter(d => d.routeId !== id);
  routes = routes.filter(x => x.id !== id);
  if (curId === id) curId = active()[0]?.id || null;
  render(true);
}

async function clearPending() {
  const list = routes.filter(r => r.status === 'pendente');
  if (!list.length) return;
  if (!confirm(`Apagar ${list.length} rota(s) pendente(s)?`)) return;
  for (const r of list) {
    for (const s of routeStops(r.id)) await DB.del(s.id);
    await DB.delOf('routes', r.id);
    stops = stops.filter(s => s.routeId !== r.id);
  }
  routes = routes.filter(r => r.status !== 'pendente');
  if (!cur()) curId = active()[0]?.id || null;
  render(true);
}

async function logDelivery(s, doneAt) {
  deliveries = deliveries.filter(d => d.id !== s.id);
  if (doneAt) { const d = { id: s.id, routeId: s.routeId, doneAt }; deliveries.push(d); await DB.putOf('deliveries', d); }
  else await DB.delOf('deliveries', s.id);
}

async function markDone(id, done) {
  const s = stops.find(x => x.id === id);
  s.done = done;
  if (done) {
    s.order = 5000;
    s.doneAt = Date.now();
    if (session && s.routeId === session.id) {   // cronômetro: tempo desta entrega, depois zera para a próxima
      s.durSec = (s.doneAt - session.legStartedAt) / 1000;
      session.legStartedAt = s.doneAt;
      await putRoute(session);
    }
    await logDelivery(s, s.doneAt);
  } else {
    delete s.doneAt; delete s.durSec;
    await logDelivery(s, null);
  }
  await DB.put(s);
  await buildRoute();
  if (session && !pending().length && curId === session.id) endRoute();   // acabaram as paradas
}

async function removeStop(id) {
  const s = stops.find(x => x.id === id);
  stops = stops.filter(x => x.id !== id);
  await DB.del(id);
  if (s.done) await logDelivery(s, null);
  await buildRoute();
}

async function editStop(id) {
  const s = stops.find(x => x.id === id);
  const t = prompt('Corrigir endereço:', s.raw);
  if (t == null || !t.trim()) return;
  Object.assign(s, { raw: t.trim(), lat: null, lon: null, failed: false });
  await DB.put(s);
  await buildRoute();
}

/* ---------- Ganhos ---------- */
// Ganho bruto de um dia com n entregas. Fixo = valor por dia trabalhado (dia com ao menos 1 entrega).
function dayGain(n) {
  if (!n) return 0;
  return (pay.mode !== 'fixo' ? n * pay.perDelivery : 0) + (pay.mode !== 'entrega' ? pay.fixed : 0);
}

const kmOf = r => (r.kmFinal || 0) / 1000;

// O fixo do dia é rateado entre as rotas do dia, proporcional às entregas de cada uma.
function routeStats(r) {
  const n = deliveries.filter(d => d.routeId === r.id).length;
  const dayN = deliveries.filter(d => dayKey(d.doneAt) === dayKey(r.endedAt)).length;
  const gain = (pay.mode !== 'fixo' ? n * pay.perDelivery : 0) + (pay.mode !== 'entrega' && dayN ? pay.fixed * n / dayN : 0);
  const km = kmOf(r);
  const cost = km * costPerKm();
  return { n, total: routeStops(r.id).length, gain, km, cost, net: gain - cost, sec: (r.endedAt - r.startedAt) / 1000 };
}

function periodStart(p) {
  const d = new Date(); d.setHours(0, 0, 0, 0);
  if (p === 'tudo') return 0;
  if (p === 'semana') d.setDate(d.getDate() - ((d.getDay() + 6) % 7));   // segunda-feira
  if (p === 'mes') d.setDate(1);
  return d.getTime();
}

function todayGross() {
  const k = dayKey(Date.now());
  return dayGain(deliveries.filter(d => dayKey(d.doneAt) === k).length);
}

const cards = items => items.map(([l, v, c = '']) => `<div><span>${l}</span><b class="${c}">${v}</b></div>`).join('');
const noKm = '—';

function renderDay() {
  const k = daySel;
  $('dDate').value = k;
  const dl = deliveries.filter(d => dayKey(d.doneAt) === k);
  const fin = routes.filter(r => r.status === 'finalizada' && dayKey(r.endedAt) === k).sort((a, b) => a.endedAt - b.endedAt);
  const ex = expenses.filter(e => dayKey(e.date) === k);
  const km = fin.reduce((a, r) => a + kmOf(r), 0);
  const sec = fin.reduce((a, r) => a + (r.endedAt - r.startedAt) / 1000, 0);
  const gross = dayGain(dl.length);
  const spent = ex.reduce((a, e) => a + e.valor, 0);
  const net = gross - spent;
  const timed = stops.filter(s => s.durSec != null && s.doneAt && dayKey(s.doneAt) === k);
  const avg = timed.length ? timed.reduce((a, s) => a + s.durSec, 0) / timed.length : null;

  $('dSum').innerHTML = cards([
    ['Entregas', dl.length], ['Rotas finalizadas', fin.length],
    ['Km rodados', km ? fmtKm(km) : noKm], ['Tempo em rota', sec ? fmtDur(sec) : noKm],
    ['Ganho bruto', money(gross)], ['Gastos', money(spent), 'neg'],
    ['Líquido', money(net), net < 0 ? 'neg' : 'pos'], ['Média por entrega', avg != null ? fmtClock(avg) : noKm],
    ['Ganho por km', km ? money(gross / km) : noKm], ['Custo por km', km ? money(spent / km) : noKm],
  ]);

  $('dRoutes').innerHTML = fin.map(r => {
    const st = routeStats(r);
    return `<li><span>${fmtTime(r.startedAt)}–${fmtTime(r.endedAt)}</span><span>${esc(r.name)} · ${st.n} entrega(s) · ${fmtKm(st.km)}</span><span>${money(st.gain)}</span></li>`;
  }).join('') || '<li class="muted">Nenhuma rota finalizada neste dia.</li>';

  $('dExp').innerHTML = ex.sort((a, b) => b.date - a.date).map(e =>
    `<li><span></span><span>${esc(e.cat)}${e.desc ? ' · ' + esc(e.desc) : ''}</span><span class="neg">${money(e.valor)}</span>
      <button data-act="delx" data-id="${e.id}">🗑</button></li>`).join('') || '<li class="muted">Nenhum gasto neste dia.</li>';
}

function renderHist() {
  const from = periodStart($('hPeriod').value);
  const fin = routes.filter(r => r.status === 'finalizada' && r.endedAt >= from).sort((a, b) => b.endedAt - a.endedAt);
  const ids = new Set(fin.map(r => r.id));
  const dl = deliveries.filter(d => d.doneAt >= from);
  const ex = expenses.filter(e => e.date >= from);

  const days = {};
  dl.forEach(d => { const k = dayKey(d.doneAt); days[k] = (days[k] || 0) + 1; });
  const gross = Object.values(days).reduce((a, n) => a + dayGain(n), 0);
  const km = fin.reduce((a, r) => a + kmOf(r), 0);
  const spent = ex.reduce((a, e) => a + e.valor, 0);
  const net = gross - spent;

  $('hSum').innerHTML = cards([
    ['Rotas', fin.length], ['Entregas', dl.length],
    ['Km rodados', km ? fmtKm(km) : noKm], ['Ganho bruto', money(gross)],
    ['Gastos', money(spent), 'neg'], ['Líquido', money(net), net < 0 ? 'neg' : 'pos'],
    ['Ganho por km', km ? money(gross / km) : noKm], ['Custo por km', km ? money(spent / km) : noKm],
  ]);

  $('hList').innerHTML = fin.map(r => {
    const st = routeStats(r);
    const addr = routeStops(r.id).sort((a, b) => (a.doneAt || 0) - (b.doneAt || 0))
      .map(s => `<li class="${s.done ? '' : 'miss'}">${s.done ? '✓' : '✗'} ${esc(s.raw)}${s.durSec != null ? ` <span class="muted">(${fmtClock(s.durSec)})</span>` : ''}</li>`).join('');
    return `<details class="hrow"><summary>
        <span class="hn">${esc(r.name)}</span>
        <span class="muted">${fmtDay(dayKey(r.endedAt))} ${fmtTime(r.startedAt)}–${fmtTime(r.endedAt)}</span>
        <span>${st.n}/${st.total} entregas · ${r.kmSrc === 'plan' ? '~' : ''}${fmtKm(st.km)}</span>
        <span><b>${money(st.gain)}</b>${costPerKm() ? ` · custo ${money(st.cost)} · <b class="${st.net < 0 ? 'neg' : 'pos'}">${money(st.net)}</b>` : ''}</span>
        <span class="muted">${st.km ? money(st.gain / st.km) + '/km' : ''}${costPerKm() ? ' · custo ' + money(costPerKm()) + '/km' : ''}${pay.kmPerL && st.km ? ' · ~' + (st.km / pay.kmPerL).toFixed(1).replace('.', ',') + ' L' : ''} · ${fmtDur(st.sec)}</span>
      </summary>
      <div class="hbody"><ul>${addr}</ul><button class="danger" data-act="rdel" data-id="${r.id}">🗑 Apagar rota</button></div></details>`;
  }).join('') || '<p class="muted">Nenhuma rota finalizada neste período. Inicie uma rota e finalize-a para ela aparecer aqui.</p>';
}

const COST_FIELDS = { fuelPrice: 'fuelPrice', kmPerL: 'kmPerL', oilPrice: 'oilPrice', oilKm: 'oilKm', otherKm: 'otherKm' };

function fillCostInputs() {
  for (const k in COST_FIELDS) $(k).value = pay[k] ? String(pay[k]).replace('.', ',') : '';
  previewCost();
}

function readCostInputs() {
  const o = {};
  for (const k in COST_FIELDS) o[k] = parseMoney($(k).value);
  return o;
}

// Mostra o custo por km enquanto você digita.
function previewCost() {
  const saved = pay;
  pay = { ...pay, ...readCostInputs() };
  const c = costParts(), tot = costPerKm();
  pay = saved;
  $('costPreview').innerHTML = tot
    ? `<b>${money(tot)}/km</b> <span class="muted">(gasolina ${money(c.fuel)} + óleo ${money(c.oil)}${c.other ? ' + outros ' + money(c.other) : ''})</span>`
    : '<span class="muted">Preencha para ver o custo por km.</span>';
}

function syncPayInputs() {
  $('payPerWrap').hidden = $('payMode').value === 'fixo';
  $('payFixedWrap').hidden = $('payMode').value === 'entrega';
}

async function addExpense() {
  const valor = parseMoney($('exValor').value);
  if (valor <= 0) { $('exValor').focus(); return; }
  const e = { id: newId(), date: new Date(daySel + 'T12:00').getTime(), valor, cat: $('exCat').value, desc: $('exDesc').value.trim() };
  expenses.push(e);
  await DB.putOf('expenses', e);
  $('exValor').value = ''; $('exDesc').value = '';
  renderDay();
}

async function removeExpense(id) {
  expenses = expenses.filter(e => e.id !== id);
  await DB.delOf('expenses', id);
  renderDay();
}

/* ---------- Rota em andamento (cronômetro) ---------- */
function applySessionUI() {
  document.body.classList.toggle('running', !!session);
  if (!session) document.body.classList.remove('showlist');
  if (session) showTab('routes');
  map.invalidateSize();
  updateRunbar();
}

function updateRunbar() {
  const bar = $('runbar');
  bar.hidden = !session;
  if (!session) return;
  const now = Date.now();
  const leg = (now - session.legStartedAt) / 1000;
  const lim = target * 60;
  const dn = routeStops(session.id).filter(s => s.durSec != null);
  const avg = dn.length ? dn.reduce((a, s) => a + s.durSec, 0) / dn.length : null;
  const state = !lim ? '' : leg > lim ? 'late' : leg > lim * 0.8 ? 'warn' : 'ok';
  $('rbName').textContent = session.name;
  $('rbLeg').textContent = fmtClock(leg);
  $('rbLeg').className = 'clock ' + state;
  $('rbTarget').textContent = lim ? 'meta ' + fmtClock(lim) : '';
  $('rbTotal').textContent = '⏱ ' + fmtClock((now - session.startedAt) / 1000);
  $('rbAvg').textContent = avg != null ? `média ${fmtClock(avg)} (${dn.length})` : '';
  $('rbAvg').className = avg != null && lim && avg > lim ? 'late' : '';
  $('rbMoney').textContent = pay.perDelivery || pay.fixed ? '💰 hoje ' + money(todayGross()) : '';
}

/* ---------- Offline ---------- */
function updateNet() {
  const off = !navigator.onLine;
  $('netbar').hidden = !off;
  if (off) $('netbar').textContent = '📴 Sem internet — modo offline: usando o que está salvo no aparelho.';
}

// Baixa os blocos do mapa da área visível para usar sem internet (o service worker guarda no aparelho).
const TILE_URL = (z, x, y) => `https://tile.openstreetmap.org/${z}/${x}/${y}.png`;
const lon2x = (lon, z) => Math.floor((lon + 180) / 360 * 2 ** z);
const lat2y = (lat, z) => {
  const r = lat * Math.PI / 180;
  return Math.floor((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * 2 ** z);
};

function tilesForView(maxTiles) {
  const b = map.getBounds();
  const z0 = Math.max(10, Math.round(map.getZoom()) - 1);
  const list = [];
  for (let z = z0; z <= 17; z++) {
    const x1 = lon2x(b.getWest(), z), x2 = lon2x(b.getEast(), z);
    const y1 = lat2y(b.getNorth(), z), y2 = lat2y(b.getSouth(), z);
    const level = [];
    for (let x = x1; x <= x2; x++) for (let y = y1; y <= y2; y++) level.push(TILE_URL(z, x, y));
    if (list.length + level.length > maxTiles) break;   // para no nível que estoura o limite
    list.push(...level);
  }
  return list;
}

function tilesForBox(bb, zmin, zmax, cap) {
  const list = [];
  for (let z = zmin; z <= zmax; z++) {
    const x1 = lon2x(bb.w, z), x2 = lon2x(bb.e, z), y1 = lat2y(bb.n, z), y2 = lat2y(bb.s, z);
    const level = [];
    for (let x = x1; x <= x2; x++) for (let y = y1; y <= y2; y++) level.push(TILE_URL(z, x, y));
    if (list.length + level.length > cap) break;
    list.push(...level);
  }
  return list;
}

async function fetchTiles(urls) {
  let done = 0, fail = 0;
  const total = urls.length;
  const worker = async () => {
    while (urls.length) {
      const u = urls.pop();
      try { const r = await fetch(u); if (!r.ok) fail++; } catch { fail++; }
      if (++done % 10 === 0) setStatus(`Baixando mapa… ${done}/${total}`);
      await sleep(80);                                    // sem sobrecarregar o servidor
    }
  };
  await Promise.all([worker(), worker()]);
  return fail;
}

// Baixa ruas + endereços + mapa da área visível para funcionar 100% sem internet.
async function downloadPackFlow() {
  if (busy) return;
  if (!navigator.onLine) { setStatus('Conecte-se à internet para baixar o pacote offline.', 4000); return; }
  const b = map.getBounds();
  const bbox = { s: b.getSouth(), w: b.getWest(), n: b.getNorth(), e: b.getEast() };
  if (bbox.n - bbox.s > 0.4 || bbox.e - bbox.w > 0.4) {
    alert('A área visível está grande demais. Aproxime o mapa até enquadrar só a sua cidade e tente de novo.');
    return;
  }
  const km = (distM(bbox.s, bbox.w, bbox.n, bbox.e) / 1000).toFixed(0);
  if (!confirm(`Baixar a região visível no mapa (~${km} km na diagonal) para usar 100% offline?

Salva ruas, endereços, bairros e o mapa no aparelho. Leva alguns minutos e usa Wi-Fi de preferência.

Dica: deixe a cidade inteira visível na tela.`)) return;
  busy = true;
  document.querySelectorAll('button').forEach(x => (x.disabled = true));
  try {
    await downloadPack(bbox, m => setStatus(m));
    const urls = tilesForBox(bbox, 11, 17, 2500);
    setStatus(`Baixando mapa… 0/${urls.length}`);
    const fail = await fetchTiles(urls);
    setStatus(fail ? `Pacote salvo. ${fail} bloco(s) do mapa falharam.` : '✓ Pacote offline salvo: já pode usar sem internet.', 7000);
  } catch (e) {
    console.error(e);
    setStatus('Não foi possível baixar o pacote: ' + (e.message || 'erro') + '. Tente de novo.', 8000);
  } finally {
    busy = false;
    document.querySelectorAll('button').forEach(x => (x.disabled = false));
    render();
  }
}

/* ---------- Interface ---------- */
function pinIcon(text, cls = '') {
  return L.divIcon({ className: '', html: `<div class="pin ${cls}">${text}</div>`, iconSize: [28, 28], iconAnchor: [14, 14] });
}

function drawMe() {
  if (!map || !me) return;
  if (!meMarker) meMarker = L.marker([me.lat, me.lon], { icon: L.divIcon({ className: '', html: '<div class="pin me"></div>', iconSize: [16, 16], iconAnchor: [8, 8] }), zIndexOffset: 1000 }).addTo(map);
  else meMarker.setLatLng([me.lat, me.lon]);
}

function renderMap(fit) {
  markersLayer.clearLayers();
  if (routeLine) { map.removeLayer(routeLine); routeLine = null; }
  const r = cur();
  const bounds = [];
  if (r) {
    const pend = pending();
    routeStops(r.id).forEach(s => {
      if (s.lat == null) return;
      const m = L.marker([s.lat, s.lon], { icon: s.done ? pinIcon('✓', 'done') : pinIcon(pend.indexOf(s) + 1) });
      m.bindPopup(esc(s.raw));
      markersLayer.addLayer(m);
      bounds.push([s.lat, s.lon]);
    });
    if (r.geo) {
      routeLine = L.polyline(r.geo.coords, { color: '#2563eb', weight: 5, opacity: .8 }).addTo(map);
      bounds.push(...r.geo.coords);
    }
  }
  if (me) bounds.push([me.lat, me.lon]);
  if (fit && bounds.length) map.fitBounds(bounds, { padding: [30, 30], maxZoom: session ? 15 : 16 });
}

function renderRoutes() {
  const list = active();
  $('empty').hidden = list.length > 0;
  $('rlist').innerHTML = list.map(r => {
    const rs = routeStops(r.id);
    const feitas = rs.filter(s => s.done).length;
    const info = [
      `${rs.length} parada(s)`,
      feitas ? `${feitas} entregue(s)` : '',
      r.geo ? fmtDist(r.geo.distance) + ' · ' + fmtDur(r.geo.duration) : '',
      r.geo && r.geo.baseline && r.geo.baseline.duration - r.geo.duration > 60 ? '⚡ ' + fmtDur(r.geo.baseline.duration - r.geo.duration) + ' a menos' : '',
    ].filter(Boolean).join(' · ');
    const em = r.status === 'andamento';
    return `<li class="rcard ${r.id === curId ? 'sel' : ''} ${r.status}" data-rid="${r.id}">
      <div class="rtop"><b>${esc(r.name)}</b><span class="badge ${r.status}">${em ? '● Em andamento' : 'Pendente'}</span></div>
      <div class="muted">${info}</div>
      <div class="btns">
        ${em ? '' : `<button class="primary" data-act="rstart" data-id="${r.id}" ${session ? 'disabled' : ''}>▶ Iniciar</button>`}
        ${em ? '' : `<button class="danger" data-act="rdel" data-id="${r.id}">🗑</button>`}
      </div></li>`;
  }).join('');
}

function render(fit = false) {
  const r = cur();
  const pend = pending();
  const all = r ? routeStops(r.id) : [];
  const done = all.filter(s => s.done);

  renderRoutes();
  $('stopsTitle').textContent = r ? `Paradas · ${r.name}` : '';
  $('stopsTitle').hidden = !r;

  const nxt = session && r && r.id === session.id ? pend.find(s => s.lat != null) : null;
  const box = $('next');
  if (nxt) {
    const n = pend.indexOf(nxt) + 1;
    box.hidden = false;
    box.innerHTML = `
      <div class="lbl">Próxima parada · ${n} de ${pend.length}</div>
      <div class="addr">${esc(nxt.raw)}</div>
      ${nxt.note ? `<div class="note">📝 ${esc(nxt.note)}</div>` : ''}
      <div class="meta">${[nxt.legDist != null ? fmtDist(nxt.legDist) + ' · ' + fmtDur(nxt.legDur) : '', nxt.sender ? '📞 ' + esc(nxt.sender) : '', nxt.when ? '🕒 ' + esc(nxt.when) : ''].filter(Boolean).join(' · ')}</div>
      <div class="btns">
        <a class="btn" target="_blank" rel="noopener" href="https://www.google.com/maps/dir/?api=1&destination=${nxt.lat},${nxt.lon}&travelmode=two-wheeler">Google Maps</a>
        <a class="btn waze" target="_blank" rel="noopener" href="https://waze.com/ul?ll=${nxt.lat},${nxt.lon}&navigate=yes">Waze</a>
        <button class="done" data-act="done" data-id="${nxt.id}">✓ Entregue</button>
      </div>`;
  } else box.hidden = true;

  $('btnList').textContent = document.body.classList.contains('showlist') ? '▼ Ocultar lista' : '☰ Lista';
  updateRunbar();

  $('list').innerHTML = [...pend, ...done].map(s => {
    const num = s.done ? '✓' : pend.indexOf(s) + 1;
    const cls = s.done ? 'done' : s.failed ? 'fail' : '';
    const meta = s.done ? 'Entregue'
      : s.failed ? '⚠ Endereço não localizado — toque em ✎ para corrigir'
      : s.lat == null ? 'Localizando…'
      : s.src === 'offline' ? '~ localizado offline (posição aproximada)'
      : s.precision === 'street' ? '~ posição na rua (número exato não encontrado)'
      : s.precision === 'cep' ? '~ posição pelo CEP (aproximada)'
      : s.legDist != null ? fmtDist(s.legDist) + ' · ' + fmtDur(s.legDur) : '';
    return `<li class="${cls}">
      <span class="num">${num}</span>
      <div class="info"><div class="a">${esc(s.raw)}</div>
        ${s.note ? `<div class="m">📝 ${esc(s.note)}</div>` : ''}
        <div class="m">${meta}</div>
        ${s.sender || s.when ? `<div class="m">${[s.sender ? '📞 ' + esc(s.sender) : '', s.when ? '🕒 ' + esc(s.when) : ''].filter(Boolean).join(' · ')}</div>` : ''}</div>
      <div class="acts">
        ${s.done ? `<button data-act="undo" data-id="${s.id}">↩</button>` : `<button data-act="done" data-id="${s.id}">✓</button>`}
        ${s.done ? '' : `<button data-act="pin" data-id="${s.id}" title="Marcar no mapa">📍</button>`}
        <button data-act="edit" data-id="${s.id}">✎</button>
        <button data-act="del" data-id="${s.id}">🗑</button>
      </div></li>`;
  }).join('');

  renderMap(fit);
  if (tab === 'day') renderDay();
  if (tab === 'hist') renderHist();
}

function showTab(name) {
  tab = name;
  $('viewRoutes').hidden = name !== 'routes';
  $('viewDay').hidden = name !== 'day';
  $('viewHist').hidden = name !== 'hist';
  document.querySelectorAll('.tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === name));
  if (name === 'routes') { map.invalidateSize(); render(true); }
  if (name === 'day') renderDay();
  if (name === 'hist') renderHist();
}

function shiftDay(delta) {
  const d = new Date(daySel + 'T12:00');
  d.setDate(d.getDate() + delta);
  daySel = dayKey(d.getTime());
  renderDay();
}

function bind() {
  const dlg = $('addDlg');
  $('btnAdd').onclick = () => { $('city').value = city; $('txt').value = ''; dlg.showModal(); $('txt').focus(); };
  $('btnCancel').onclick = () => dlg.close();
  $('addForm').onsubmit = async () => {
    city = $('city').value.trim();
    await DB.set('city', city);
    const text = $('txt').value;
    dlg.close();
    addFromText(text);
  };

  const sdlg = $('setDlg');
  $('btnSet').onclick = () => {
    $('target').value = target; $('cityS').value = city;
    $('payMode').value = pay.mode;
    $('payPer').value = pay.perDelivery || ''; $('payFixed').value = pay.fixed || ''; fillCostInputs();
    syncPayInputs();
    $('packInfo').textContent = packInfo();
    sdlg.showModal();
  };
  $('payMode').onchange = syncPayInputs;
  for (const k in COST_FIELDS) $(k).oninput = previewCost;
  $('setCancel').onclick = () => sdlg.close();
  $('setForm').onsubmit = async () => {
    target = Math.max(0, parseInt($('target').value, 10) || 0);
    city = $('cityS').value.trim();
    pay = { mode: $('payMode').value, perDelivery: parseMoney($('payPer').value), fixed: parseMoney($('payFixed').value), ...readCostInputs() };
    await DB.set('target', target); await DB.set('city', city); await DB.set('pay', pay);
    sdlg.close();
    render();
  };

  document.querySelectorAll('.tabs button').forEach(b => { b.onclick = () => showTab(b.dataset.tab); });
  $('dPrev').onclick = () => shiftDay(-1);
  $('dNext').onclick = () => shiftDay(1);
  $('dToday').onclick = () => { daySel = dayKey(Date.now()); renderDay(); };
  $('dDate').onchange = () => { if ($('dDate').value) { daySel = $('dDate').value; renderDay(); } };
  $('hPeriod').onchange = renderHist;
  $('exAdd').onclick = addExpense;

  $('btnEnd').onclick = endRoute;
  $('btnList').onclick = () => { document.body.classList.toggle('showlist'); map.invalidateSize(); render(); };
  $('btnCenter').onclick = () => { follow = true; if (me) map.panTo([me.lat, me.lon]); else getPosition(); };
  map.on('dragstart', () => { follow = false; });
  map.on('click', onMapClick);

  $('btnRoute').onclick = () => buildRoute();
  $('btnLocate').onclick = async () => { await getPosition(); if (me) map.setView([me.lat, me.lon], CITY_ZOOM + 2); else setStatus('Não consegui obter sua localização (permita o GPS).', 4000); };
  $('btnClear').onclick = clearPending;
  $('btnInstall').onclick = async () => { if (!installEvt) return; installEvt.prompt(); await installEvt.userChoice; installEvt = null; $('btnInstall').hidden = true; };
  $('btnMapOff').onclick = downloadPackFlow;
  $('btnPackDel').onclick = async () => { if (!confirm('Apagar o pacote offline salvo?')) return; await DB.set('pack', null); loadPack(null); $('packInfo').textContent = packInfo(); };
  window.addEventListener('online', () => { updateNet(); setStatus('Internet de volta. Toque em Recalcular rota para localizar o que faltou.', 5000); });
  window.addEventListener('offline', updateNet);

  document.body.addEventListener('click', e => {
    const b = e.target.closest('button[data-act]');
    if (b) {
      const { act, id } = b.dataset;
      if (act === 'done') markDone(id, true);
      else if (act === 'undo') markDone(id, false);
      else if (act === 'del') removeStop(id);
      else if (act === 'edit') editStop(id);
      else if (act === 'pin') placeOnMap(id);
      else if (act === 'delx') removeExpense(id);
      else if (act === 'rstart') startRoute(id);
      else if (act === 'rdel') deleteRoute(id);
      return;
    }
    const card = e.target.closest('.rcard');
    if (card && card.dataset.rid !== curId) { curId = card.dataset.rid; render(true); }
  });
}

/* ---------- Instalação (Android/Chrome) ---------- */
let installEvt = null;
window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault();
  installEvt = e;
  const b = $('btnInstall');
  if (b) b.hidden = false;
});

/* ---------- Inicialização ---------- */
// Dados de versões antigas (paradas sem rota) viram uma rota só.
async function migrate() {
  const orphans = stops.filter(s => !s.routeId);
  if (!orphans.length) return;
  const allDone = orphans.every(s => s.done);
  const last = Math.max(...orphans.map(s => s.doneAt || 0)) || Date.now();
  const r = {
    id: newId(), name: 'Rota anterior', km: 0,
    createdAt: Math.min(...orphans.map(s => s.addedAt || Date.now())),
    status: allDone ? 'finalizada' : 'pendente',
    ...(allDone ? { startedAt: last, endedAt: last, kmFinal: 0, kmSrc: 'plan' } : {}),
  };
  routes.push(r);
  await putRoute(r);
  for (const s of orphans) { s.routeId = r.id; await DB.put(s); }
  for (const d of deliveries) {
    if (!d.routeId && orphans.some(s => s.id === d.id)) { d.routeId = r.id; await DB.putOf('deliveries', d); }
  }
}

(async function init() {
  await DB.open();
  stops = await DB.all();
  routes = await DB.allOf('routes');
  deliveries = await DB.allOf('deliveries');
  expenses = await DB.allOf('expenses');
  await migrate();
  city = (await DB.get('city')) || '';
  const t = await DB.get('target');
  if (t != null) target = t;
  pay = { ...pay, ...((await DB.get('pay')) || {}) };
  geoCache = (await DB.get('geocache')) || {};
  loadPack(await DB.get('pack'));
  me = (await DB.get('lastMe')) || null;      // última posição conhecida: abre já na sua cidade
  daySel = dayKey(Date.now());

  session = routes.find(r => r.status === 'andamento') || null;
  curId = session?.id || active()[0]?.id || null;

  const start = me ? [me.lat, me.lon] : [-14.2, -51.9];
  map = L.map('map', { zoomControl: false }).setView(start, me ? CITY_ZOOM : 4);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' }).addTo(map);
  markersLayer = L.layerGroup().addTo(map);

  bind();
  document.body.classList.toggle('running', !!session);
  map.invalidateSize();
  drawMe();
  render(!!cur());
  watchPosition();
  updateNet();
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist();   // evita o celular apagar os dados
  setInterval(updateRunbar, 1000);
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
})();
