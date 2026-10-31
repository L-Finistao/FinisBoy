'use strict';

/* Trajeto gravado durante a rota e histórico no mapa:
   - grava a posição do GPS (a cada ~12 m ou 15 s) junto com o horário;
   - no histórico mostra o trajeto colorido pela velocidade e compara os trechos entre as entregas, parte a parte.
   Usa as globais de app.js (routes, stops, deliveries, map, DB, pinIcon, fmt*...). */

/* ---------- Gravação do trajeto ---------- */
let track = [];                 // [[lat, lon, horário], ...] da rota em andamento
let trackId = null, trackDirty = false;

function startTrack(id) { track = []; trackId = id; trackDirty = true; }
function stopTrack() { track = []; trackId = null; trackDirty = false; }

async function resumeTrack(id) {
  const t = await DB.getOf('tracks', id);
  track = t ? t.pts : [];
  trackId = id;
  trackDirty = false;
}

function recordTrack(p) {
  if (p.coords.accuracy > 50 || !trackId) return;          // GPS impreciso: ignora
  const t = p.timestamp || Date.now();
  const pt = [+p.coords.latitude.toFixed(6), +p.coords.longitude.toFixed(6), t];
  const last = track[track.length - 1];
  if (!last || haversine({ lat: last[0], lon: last[1] }, { lat: pt[0], lon: pt[1] }) >= 12 || t - last[2] >= 15000) {
    track.push(pt);
    trackDirty = true;
  }
}

async function saveTrack() {
  if (!trackId || !trackDirty) return;
  trackDirty = false;
  await DB.putOf('tracks', { id: trackId, pts: track });
}

document.addEventListener('visibilitychange', () => { if (document.hidden) saveTrack(); });

/* ---------- Análise: parte a parte ---------- */
const SPEED_COLORS = ['#dc2626', '#f97316', '#eab308', '#16a34a'];
const speedBand = kmh => (kmh < 5 ? 0 : kmh < 15 ? 1 : kmh < 30 ? 2 : 3);
const ptObj = p => ({ lat: p[0], lon: p[1] });
const shortAddr = s => s.raw.split(',').slice(0, 2).join(',').trim();

function deliveredStops(r) {
  return routeStops(r.id).filter(s => s.done && s.doneAt && s.lat != null).sort((a, b) => a.doneAt - b.doneAt);
}

// Cada parte vai de uma entrega (ou da saída) até a próxima entrega.
function segmentsOf(r, pts) {
  const first = pts[0];
  const marks = [{ t: r.startedAt, label: 'Saída', lat: first ? first[0] : null, lon: first ? first[1] : null }];
  for (const s of deliveredStops(r)) marks.push({ t: s.doneAt, label: shortAddr(s), stop: s, lat: s.lat, lon: s.lon });

  const segs = [];
  for (let i = 1; i < marks.length; i++) {
    const a = marks[i - 1], b = marks[i];
    const sub = pts.filter(p => p[2] >= a.t && p[2] <= b.t);
    const dur = (b.t - a.t) / 1000;
    let dist = null, moving = 0;
    if (sub.length >= 2) {
      dist = 0;
      for (let k = 1; k < sub.length; k++) {
        const d = haversine(ptObj(sub[k - 1]), ptObj(sub[k])), dt = (sub[k][2] - sub[k - 1][2]) / 1000;
        dist += d;
        if (dt > 0 && dt <= 90 && d / dt >= 1.4) moving += dt;       // rodando (> 5 km/h)
      }
    }
    segs.push({
      i, from: a, to: b, n: i, sub, dur, dist, moving,
      stopped: dist != null ? Math.max(0, dur - moving) : null,
      kmh: dist != null && dur > 0 ? dist / dur * 3.6 : null,
      kmhMoving: dist != null && moving > 0 ? dist / moving * 3.6 : null,
      pace: dist != null && dist >= 100 ? (dur / 60) / (dist / 1000) : null,   // min por km (maior = mais lento)
    });
  }
  return segs;
}

/* ---------- Visualização no mapa ---------- */
let hist = null;                // { ids, single, tracks, segs, focus, dirty, prevTab }
let histLayer = null;

const finishedInPeriod = () => {
  const from = periodStart($('hPeriod').value), pf = histProfile();
  return routes.filter(r => r.status === 'finalizada' && r.endedAt >= from && (pf === 'all' || routePid(r) === pf)).sort((a, b) => b.endedAt - a.endedAt);
};

async function openHistory(ids) {
  if (!ids.length) return;
  const tracks = {};
  for (const id of ids) { const t = await DB.getOf('tracks', id); tracks[id] = t ? t.pts : []; }
  hist = { ids, single: ids.length === 1, tracks, segs: [], focus: null, dirty: true, prevTab: tab };
  document.body.classList.add('histview');
  showTab('routes', true);
  renderHistPanel();
}

function closeHistory(rerender = true) {
  if (!hist) return;
  hist = null;
  document.body.classList.remove('histview');
  $('histview').hidden = true;
  if (histLayer) histLayer.clearLayers();
  if (rerender) render(true);
}

function drawTrack(pts, weight, cv, bounds) {
  const runs = [];
  let run = null;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i], dt = (b[2] - a[2]) / 1000;
    if (dt <= 0 || dt > 90) { run = null; continue; }                // sinal de GPS perdido: não liga os pontos
    const band = speedBand(haversine(ptObj(a), ptObj(b)) / dt * 3.6);
    if (run && run.band === band) run.pts.push([b[0], b[1]]);
    else runs.push(run = { band, pts: [[a[0], a[1]], [b[0], b[1]]] });
  }
  for (const r of runs) {
    L.polyline(r.pts, { color: SPEED_COLORS[r.band], weight, opacity: 0.9, renderer: cv, interactive: false }).addTo(histLayer);
    bounds.push(...r.pts);
  }
}

function drawHistory(fit) {
  markersLayer.clearLayers();
  if (routeLine) { map.removeLayer(routeLine); routeLine = null; }
  if (!histLayer) histLayer = L.layerGroup().addTo(map);
  histLayer.clearLayers();
  hist.dirty = false;
  const cv = L.canvas({ padding: 0.5 });
  const bounds = [];

  for (const id of hist.ids) {
    const r = routes.find(x => x.id === id);
    if (!r) continue;
    const pts = hist.tracks[id] || [];
    const seg = hist.single && hist.focus != null ? hist.segs[hist.focus] : null;
    if (seg && seg.sub.length > 1) {                                  // destaque do trecho escolhido
      L.polyline(seg.sub.map(p => [p[0], p[1]]), { color: '#111827', weight: 12, opacity: 0.35, renderer: cv, interactive: false }).addTo(histLayer);
    }
    drawTrack(pts, hist.single ? 6 : 3, cv, bounds);

    const done = deliveredStops(r);
    done.forEach((s, k) => {
      bounds.push([s.lat, s.lon]);
      const gap = k === 0 ? (s.doneAt - r.startedAt) / 1000 : (s.doneAt - done[k - 1].doneAt) / 1000;
      const info = `<b>${k + 1}. ${esc(s.raw)}</b><br>Entregue às ${fmtTime(s.doneAt)}<br>${fmtClock(gap)} desde ${k === 0 ? 'a saída' : 'a entrega anterior'}` +
        (s.durSec != null ? `<br>Cronômetro da entrega: ${fmtClock(s.durSec)}` : '');
      if (hist.single) {
        const m = L.marker([s.lat, s.lon], { icon: pinIcon(k + 1) }).bindPopup(info);
        m.bindTooltip(`${fmtTime(s.doneAt)} · +${fmtClock(gap)}`, { permanent: true, direction: 'right', offset: [12, 0], className: 'hv-tip' });
        m.addTo(histLayer);
      } else {
        L.circleMarker([s.lat, s.lon], { radius: 6, color: '#fff', weight: 2, fillColor: '#FF6B00', fillOpacity: 1 }).bindPopup(`<b>${esc(r.name)}</b><br>${info}`).addTo(histLayer);
      }
    });
    if (hist.single && pts.length) {
      L.marker([pts[0][0], pts[0][1]], { icon: L.divIcon({ className: '', html: '<div class="pin done">🏁</div>', iconSize: [28, 28], iconAnchor: [14, 14] }) })
        .bindPopup(`Saída às ${fmtTime(r.startedAt)}`).addTo(histLayer);
    }
  }
  if (fit && bounds.length) map.fitBounds(bounds, { padding: [30, 30], maxZoom: 17 });
}

function focusSegment(i) {
  if (!hist || !hist.single) return;
  hist.focus = hist.focus === i ? null : i;
  drawHistory(false);
  const seg = hist.segs[i];
  if (hist.focus != null && seg && seg.sub.length > 1) map.fitBounds(seg.sub.map(p => [p[0], p[1]]), { padding: [40, 40], maxZoom: 17 });
  document.querySelectorAll('#segList [data-seg]').forEach(li => li.classList.toggle('focus', +li.dataset.seg === hist.focus));
}

/* ---------- Painel ---------- */
const paceLabel = s => (s.dist != null && s.dist >= 100 ? s.kmh.toFixed(0) + ' km/h' : '—');

function renderHistPanel() {
  const panel = $('histview');
  panel.hidden = false;

  if (!hist.single) {                                               // visão geral do período
    const rs = hist.ids.map(id => routes.find(r => r.id === id)).filter(Boolean);
    const dels = rs.reduce((a, r) => a + deliveredStops(r).length, 0);
    const km = rs.reduce((a, r) => a + kmOf(r), 0);
    $('hvTitle').textContent = 'Entregas do período';
    $('hvSummary').innerHTML = cards([['Rotas', rs.length], ['Entregas no mapa', dels], ['Km rodados', km ? fmtKm(km) : '—']]);
    $('hvNote').textContent = 'Cada ponto laranja é uma entrega; as linhas coloridas mostram a velocidade. Toque numa rota para ver parte a parte.';
    $('hvSegTitle').textContent = 'Rotas';
    $('segList').innerHTML = rs.map(r => `<li class="seg" data-open="${r.id}"><div class="sg-top"><b>${esc(r.name)}</b><span class="sg-t">${fmtDay(dayKey(r.endedAt))} ${fmtTime(r.startedAt)}–${fmtTime(r.endedAt)}</span></div>
      <div class="sg-meta">${deliveredStops(r).length} entrega(s) · ${fmtKm(kmOf(r))} · ${fmtDur((r.endedAt - r.startedAt) / 1000)}</div></li>`).join('');
    return;
  }

  const r = routes.find(x => x.id === hist.ids[0]);
  const pts = hist.tracks[r.id] || [];
  const segs = hist.segs = segmentsOf(r, pts);
  const withKm = segs.filter(s => s.dist != null);
  const dist = withKm.reduce((a, s) => a + s.dist, 0);
  const moving = withKm.reduce((a, s) => a + s.moving, 0);
  const stopped = withKm.reduce((a, s) => a + s.stopped, 0);
  const paced = segs.filter(s => s.pace != null);
  const slow = paced.length ? paced.reduce((a, s) => (s.pace > a.pace ? s : a)) : null;
  const fast = paced.length > 2 ? paced.reduce((a, s) => (s.pace < a.pace ? s : a)) : null;

  $('hvTitle').textContent = `${r.name} · ${fmtDay(dayKey(r.endedAt))}`;
  $('hvSummary').innerHTML = cards([
    ['Tempo total', fmtDur((r.endedAt - r.startedAt) / 1000)], ['Entregas', `${deliveredStops(r).length}/${routeStops(r.id).length}`],
    ['Rodando', moving ? fmtDur(moving) : '—'], ['Parado (entregas, semáforos…)', withKm.length ? fmtDur(stopped) : '—'],
    ['Velocidade rodando', moving ? (dist / moving * 3.6).toFixed(0) + ' km/h' : '—'], ['Mais lento', slow ? `${slow.from.stop ? slow.n - 1 : 'Saída'} → ${slow.n}` : '—'],
  ]);
  $('hvNote').textContent = pts.length
    ? 'Toque numa parte para destacá-la no mapa. A barra mostra o tempo por km: quanto maior, mais lento o trecho.'
    : 'Esta rota não tem trajeto gravado (foi feita antes desta versão ou sem GPS). Mostrando só as entregas e os tempos.';
  $('hvSegTitle').textContent = 'Parte a parte';

  const maxPace = paced.length ? Math.max(...paced.map(s => s.pace)) : 0;
  $('segList').innerHTML = segs.map(s => {
    const label = `${s.i === 1 ? 'Saída' : s.i - 1} → ${s.n}`;
    const tag = s === slow ? '<span class="tag slow">🐢 mais lento</span>' : s === fast ? '<span class="tag fast">🐇 mais rápido</span>' : '';
    const bar = s.pace != null && maxPace ? `<div class="sg-bar"><i style="width:${Math.max(6, s.pace / maxPace * 100)}%;background:${SPEED_COLORS[speedBand(s.kmh)]}"></i></div>` : '';
    const meta = s.dist != null
      ? `${fmtKm(s.dist / 1000)} · ${paceLabel(s)} no total${s.kmhMoving ? ` · ${s.kmhMoving.toFixed(0)} km/h rodando` : ''} · parado ${fmtClock(s.stopped)}${s.pace != null ? ` · ${s.pace.toFixed(1).replace('.', ',')} min/km` : ''}`
      : 'sem trajeto gravado';
    return `<li class="seg ${s === slow ? 'is-slow' : ''}" data-seg="${s.i - 1}">
      <div class="sg-top"><b>${label}</b>${tag}<span class="sg-t">${fmtClock(s.dur)}</span></div>
      <div class="sg-addr">${esc(s.from.label)} → ${esc(s.to.label)}</div>
      <div class="sg-meta">${meta}</div>${bar}</li>`;
  }).join('') || '<li class="muted">Nenhuma entrega registrada nesta rota.</li>';
}

function histBind() {
  $('hvBack').onclick = () => { if (hist) showTab(hist.prevTab); };
  $('segList').onclick = e => {
    const li = e.target.closest('[data-seg]');
    if (li) { focusSegment(+li.dataset.seg); return; }
    const ro = e.target.closest('[data-open]');
    if (ro) openHistory([ro.dataset.open]);
  };
}
