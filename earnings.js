'use strict';

/* Períodos de trabalho, ganhos e gastos.
   Você pode trabalhar em mais de um período no mesmo dia (ex.: manhã e noite), cada um com seu local e seu
   modelo de pagamento: por entrega, fixo ou fixo + por entrega. Os dados são separados por período.
   Usa as globais de app.js (routes, deliveries, expenses, stops, session, DB, fmt*...). */

let profiles = [];                    // { id, name, local, mode, perDelivery, fixed, from, to }
let lastProfileId = null;

const MODE_LABEL = { entrega: 'Por entrega', fixo: 'Fixo por dia', misto: 'Fixo + por entrega' };
const noKm = '—';
const cards = items => items.map(([l, v, c = '']) => `<div><span>${l}</span><b class="${c}">${v}</b></div>`).join('');

/* ---------- Períodos ---------- */
const profileById = id => profiles.find(p => p.id === id) || null;
const normPid = id => (profileById(id) ? id : (profiles[0] ? profiles[0].id : ''));
const routePid = r => normPid(r && r.profileId);
const profileName = id => { const p = profileById(id); return p ? p.name : 'Geral'; };
const kmOf = r => (r.kmFinal || 0) / 1000;

function newProfile(name = 'Novo período') {
  return { id: newId(), name, local: '', mode: 'entrega', perDelivery: 0, fixed: 0, from: '', to: '' };
}

function modeText(p) {
  const f = money(p.fixed), v = money(p.perDelivery);
  if (p.mode === 'fixo') return `Fixo ${f}`;
  if (p.mode === 'misto') return `Fixo ${f} + ${v}/entrega`;
  return `${v} por entrega`;
}

const hourOf = s => { const m = /^(\d{1,2}):(\d{2})$/.exec(s || ''); return m ? +m[1] + +m[2] / 60 : null; };

// Período que combina com o horário atual (se os horários foram preenchidos).
function autoProfileId(date = new Date()) {
  const h = date.getHours() + date.getMinutes() / 60;
  for (const p of profiles) {
    const a = hourOf(p.from), b = hourOf(p.to);
    if (a == null || b == null || a === b) continue;
    if (a < b ? h >= a && h < b : h >= a || h < b) return p.id;       // aceita virada de dia (ex.: 18:00 às 02:00)
  }
  return null;
}

const defaultProfileId = () => autoProfileId() || (profileById(lastProfileId) ? lastProfileId : (profiles[0] ? profiles[0].id : ''));

const profileOptions = (sel, withAll) =>
  (withAll ? `<option value="all">${withAll}</option>` : '') +
  profiles.map(p => `<option value="${p.id}" ${p.id === sel ? 'selected' : ''}>${esc(p.name)}${p.local ? ' · ' + esc(p.local) : ''}</option>`).join('');

async function loadProfiles() {
  profiles = (await DB.get('profiles')) || null;
  lastProfileId = (await DB.get('lastProfile')) || null;
  if (!profiles || !profiles.length) {                                 // migra o modelo único de versões anteriores
    profiles = [{ ...newProfile('Padrão'), mode: pay.mode || 'entrega', perDelivery: pay.perDelivery || 0, fixed: pay.fixed || 0 }];
    await DB.set('profiles', profiles);
  }
}

/* ---------- Cálculo ---------- */
// Ganho bruto de um período num dia. O fixo vale por dia trabalhado (houve entrega ou rota finalizada).
function shiftGain(p, n, worked) {
  if (!p || (!n && !worked)) return 0;
  return (p.mode !== 'fixo' ? n * p.perDelivery : 0) + (p.mode !== 'entrega' ? p.fixed : 0);
}

const deliveryPid = d => routePid(routes.find(x => x.id === d.routeId));
const dayBounds = k => { const a = new Date(k + 'T00:00:00').getTime(); return [a, a + 86400000]; };

// Junta entregas, rotas e gastos por (dia, período).
function collect(from, to, pf = 'all', includeLive = false) {
  const m = new Map();
  const slot = (day, pid) => {
    const key = day + '|' + pid;
    if (!m.has(key)) m.set(key, { day, pid, n: 0, fin: [], spent: 0, km: 0, sec: 0, live: false });
    return m.get(key);
  };
  const ok = pid => pf === 'all' || pid === pf;
  for (const d of deliveries) {
    if (d.doneAt < from || d.doneAt >= to) continue;
    const pid = deliveryPid(d);
    if (ok(pid)) slot(dayKey(d.doneAt), pid).n++;
  }
  for (const r of routes) {
    if (r.status !== 'finalizada' || r.endedAt < from || r.endedAt >= to) continue;
    const pid = routePid(r);
    if (!ok(pid)) continue;
    const s = slot(dayKey(r.endedAt), pid);
    s.fin.push(r); s.km += kmOf(r); s.sec += (r.endedAt - r.startedAt) / 1000;
  }
  for (const e of expenses) {
    if (e.date < from || e.date >= to) continue;
    const pid = profileById(e.profileId) ? e.profileId : 'geral';
    if (ok(pid)) slot(dayKey(e.date), pid).spent += e.valor;
  }
  if (includeLive && session) {
    const t = Date.now(), pid = routePid(session);
    if (t >= from && t < to && ok(pid)) slot(dayKey(t), pid).live = true;
  }
  for (const s of m.values()) {
    s.gain = shiftGain(profileById(s.pid), s.n, s.fin.length > 0 || s.live);
    s.net = s.gain - s.spent;
  }
  return m;
}

const sumSlots = slots => slots.reduce((t, s) => {
  t.n += s.n; t.rotas += s.fin.length; t.km += s.km; t.sec += s.sec; t.gain += s.gain; t.spent += s.spent;
  return t;
}, { n: 0, rotas: 0, km: 0, sec: 0, gain: 0, spent: 0 });

// O fixo do dia é dividido entre as rotas do mesmo período e dia, proporcional às entregas de cada uma.
function routeStats(r) {
  const pid = routePid(r), p = profileById(pid);
  const n = deliveries.filter(d => d.routeId === r.id).length;
  const day = dayKey(r.endedAt);
  const dayN = deliveries.filter(d => dayKey(d.doneAt) === day && deliveryPid(d) === pid).length;
  const dayRoutes = routes.filter(x => x.status === 'finalizada' && dayKey(x.endedAt) === day && routePid(x) === pid).length || 1;
  const share = dayN ? n / dayN : 1 / dayRoutes;
  const gain = p ? (p.mode !== 'fixo' ? n * p.perDelivery : 0) + (p.mode !== 'entrega' ? p.fixed * share : 0) : 0;
  const km = kmOf(r), cost = km * costPerKm();
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
  const k = dayKey(Date.now()), [a, b] = dayBounds(k);
  return sumSlots([...collect(a, b, 'all', true).values()]).gain;
}

/* ---------- Tela: Dia ---------- */
const slotCard = s => {
  const p = profileById(s.pid);
  const title = p ? `${esc(p.name)}${p.local ? ' · ' + esc(p.local) : ''}` : 'Geral (sem período)';
  return `<div class="pcard">
    <div class="ph"><b>${title}</b>${p ? `<span class="muted">${modeText(p)}</span>` : ''}</div>
    <div class="pg">
      <span>Entregas<b>${s.n}</b></span><span>Rotas<b>${s.fin.length}</b></span><span>Km<b>${s.km ? fmtKm(s.km) : noKm}</b></span>
      <span>Ganho<b>${money(s.gain)}</b></span><span>Gastos<b class="neg">${money(s.spent)}</b></span>
      <span>Líquido<b class="${s.net < 0 ? 'neg' : 'pos'}">${money(s.net)}</b></span>
    </div></div>`;
};

function renderDay() {
  const k = daySel;
  $('dDate').value = k;
  const [from, to] = dayBounds(k);
  const m = collect(from, to, 'all', k === dayKey(Date.now()));
  const slots = [...m.values()].sort((a, b) => profiles.findIndex(p => p.id === a.pid) - profiles.findIndex(p => p.id === b.pid));
  const t = sumSlots(slots);
  const fin = routes.filter(r => r.status === 'finalizada' && r.endedAt >= from && r.endedAt < to).sort((a, b) => a.endedAt - b.endedAt);
  const ex = expenses.filter(e => e.date >= from && e.date < to);
  const net = t.gain - t.spent;
  const timed = stops.filter(s => s.durSec != null && s.doneAt && s.doneAt >= from && s.doneAt < to);
  const avg = timed.length ? timed.reduce((a, s) => a + s.durSec, 0) / timed.length : null;

  $('dSum').innerHTML = cards([
    ['Entregas', t.n], ['Rotas finalizadas', t.rotas],
    ['Km rodados', t.km ? fmtKm(t.km) : noKm], ['Tempo em rota', t.sec ? fmtDur(t.sec) : noKm],
    ['Ganho bruto', money(t.gain)], ['Gastos', money(t.spent), 'neg'],
    ['Líquido', money(net), net < 0 ? 'neg' : 'pos'], ['Média por entrega', avg != null ? fmtClock(avg) : noKm],
    ['Ganho por km', t.km ? money(t.gain / t.km) : noKm], ['Custo por km', t.km ? money(t.spent / t.km) : noKm],
  ]);

  $('dProf').innerHTML = slots.map(slotCard).join('') || '<p class="muted">Nenhum período trabalhado neste dia.</p>';

  $('dRoutes').innerHTML = fin.map(r => {
    const st = routeStats(r);
    return `<li><span>${fmtTime(r.startedAt)}–${fmtTime(r.endedAt)}</span><span>${esc(r.name)} · ${esc(profileName(routePid(r)))} · ${st.n} entrega(s) · ${fmtKm(st.km)}</span><span>${money(st.gain)}</span><button data-act="hmap" data-id="${r.id}" title="Ver no mapa">🗺</button></li>`;
  }).join('') || '<li class="muted">Nenhuma rota finalizada neste dia.</li>';

  $('dExp').innerHTML = ex.sort((a, b) => b.date - a.date).map(e =>
    `<li><span></span><span>${esc(e.cat)}${e.desc ? ' · ' + esc(e.desc) : ''} <span class="muted">· ${esc(profileName(profileById(e.profileId) ? e.profileId : 'geral'))}</span></span><span class="neg">${money(e.valor)}</span>
      <button data-act="delx" data-id="${e.id}">🗑</button></li>`).join('') || '<li class="muted">Nenhum gasto neste dia.</li>';

  const sel = $('exProf').value;
  $('exProf').innerHTML = profileOptions(sel && sel !== 'geral' ? sel : defaultProfileId()) + `<option value="geral" ${sel === 'geral' ? 'selected' : ''}>Geral (sem período)</option>`;
  renderDaily();
}

// Ganho e gasto dia a dia (últimos 7, 14 ou 30 dias).
function renderDaily() {
  const n = +$('dRange').value || 14;
  const end = dayBounds(dayKey(Date.now()))[1];
  const from = end - n * 86400000;
  const m = collect(from, end, 'all', true);
  const byDay = new Map();
  for (const s of m.values()) {
    if (!byDay.has(s.day)) byDay.set(s.day, []);
    byDay.get(s.day).push(s);
  }
  const days = [...byDay.keys()].sort().reverse();
  const rows = days.map(day => {
    const slots = byDay.get(day), t = sumSlots(slots);
    return { day, t, net: t.gain - t.spent, slots };
  });
  const max = Math.max(1, ...rows.map(r => Math.max(r.t.gain, r.t.spent)));
  const tot = rows.reduce((a, r) => ({ gain: a.gain + r.t.gain, spent: a.spent + r.t.spent, n: a.n + r.t.n }), { gain: 0, spent: 0, n: 0 });
  const worked = rows.filter(r => r.t.gain > 0 || r.t.n > 0).length;

  $('dTotals').innerHTML = cards([
    ['Ganho no período', money(tot.gain)], ['Gastos', money(tot.spent), 'neg'],
    ['Líquido', money(tot.gain - tot.spent), tot.gain - tot.spent < 0 ? 'neg' : 'pos'],
    ['Média por dia trabalhado', worked ? money((tot.gain - tot.spent) / worked) : noKm],
  ]);
  $('dDaily').innerHTML = rows.map(r => {
    const wd = new Date(r.day + 'T12:00').toLocaleDateString('pt-BR', { weekday: 'short' });
    const chips = r.slots.filter(s => s.gain || s.spent).map(s => `<span class="chip">${esc(profileName(s.pid))} ${money(s.gain)}${s.spent ? ' − ' + money(s.spent) : ''}</span>`).join('');
    return `<li data-day="${r.day}" class="${r.day === daySel ? 'sel' : ''}">
      <div class="dtop"><b>${fmtDay(r.day)} <span class="muted">${wd}</span></b><b class="${r.net < 0 ? 'neg' : 'pos'}">${money(r.net)}</b></div>
      <div class="dbar"><i class="g" style="width:${r.t.gain / max * 100}%"></i></div>
      <div class="dbar"><i class="s" style="width:${r.t.spent / max * 100}%"></i></div>
      <div class="dmeta muted">${r.t.n} entrega(s) · ganho ${money(r.t.gain)} · gastos ${money(r.t.spent)}</div>
      <div class="chips">${chips}</div></li>`;
  }).join('') || '<li class="muted">Nenhum dado neste intervalo.</li>';
}

/* ---------- Tela: Histórico ---------- */
const histProfile = () => $('hProf').value || 'all';

function renderHist() {
  const sel = $('hProf').value || 'all';
  $('hProf').innerHTML = profileOptions(sel, 'Todos os períodos');
  const pf = histProfile();
  const from = periodStart($('hPeriod').value);
  const fin = routes.filter(r => r.status === 'finalizada' && r.endedAt >= from && (pf === 'all' || routePid(r) === pf)).sort((a, b) => b.endedAt - a.endedAt);
  const m = collect(from, Date.now() + 86400000, pf);
  const slots = [...m.values()];
  const t = sumSlots(slots), net = t.gain - t.spent;

  $('hSum').innerHTML = cards([
    ['Rotas', fin.length], ['Entregas', t.n],
    ['Km rodados', t.km ? fmtKm(t.km) : noKm], ['Ganho bruto', money(t.gain)],
    ['Gastos', money(t.spent), 'neg'], ['Líquido', money(net), net < 0 ? 'neg' : 'pos'],
    ['Ganho por km', t.km ? money(t.gain / t.km) : noKm], ['Custo por km', t.km ? money(t.spent / t.km) : noKm],
  ]);

  // comparação entre períodos trabalhados
  const per = new Map();
  for (const s of slots) {
    if (!per.has(s.pid)) per.set(s.pid, { pid: s.pid, days: new Set(), n: 0, gain: 0, spent: 0, km: 0 });
    const a = per.get(s.pid);
    if (s.gain || s.n || s.fin.length) a.days.add(s.day);
    a.n += s.n; a.gain += s.gain; a.spent += s.spent; a.km += s.km;
  }
  $('hProfSum').innerHTML = pf === 'all' && per.size > 1 ? `<h3>Por período trabalhado</h3>` + [...per.values()].map(a => {
    const p = profileById(a.pid), nt = a.gain - a.spent;
    return `<div class="pcard"><div class="ph"><b>${esc(p ? p.name : 'Geral')}${p && p.local ? ' · ' + esc(p.local) : ''}</b><span class="muted">${a.days.size} dia(s)</span></div>
      <div class="pg"><span>Entregas<b>${a.n}</b></span><span>Ganho<b>${money(a.gain)}</b></span><span>Líquido<b class="${nt < 0 ? 'neg' : 'pos'}">${money(nt)}</b></span>
      <span>Por dia<b>${a.days.size ? money(nt / a.days.size) : noKm}</b></span><span>Por entrega<b>${a.n ? money(nt / a.n) : noKm}</b></span><span>Km<b>${a.km ? fmtKm(a.km) : noKm}</b></span></div></div>`;
  }).join('') : '';

  $('hAll').hidden = !fin.length;
  $('hList').innerHTML = fin.map(r => {
    const st = routeStats(r);
    const addr = routeStops(r.id).sort((a, b) => (a.doneAt || 0) - (b.doneAt || 0))
      .map(s => `<li class="${s.done ? '' : 'miss'}">${s.done ? '✓' : '✗'} ${esc(s.raw)}${s.durSec != null ? ` <span class="muted">(${fmtClock(s.durSec)})</span>` : ''}</li>`).join('');
    return `<details class="hrow"><summary>
        <span class="hn">${esc(r.name)} <span class="badge">${esc(profileName(routePid(r)))}</span></span>
        <span class="muted">${fmtDay(dayKey(r.endedAt))} ${fmtTime(r.startedAt)}–${fmtTime(r.endedAt)}</span>
        <span>${st.n}/${st.total} entregas · ${r.kmSrc === 'plan' ? '~' : ''}${fmtKm(st.km)}</span>
        <span><b>${money(st.gain)}</b>${costPerKm() ? ` · custo ${money(st.cost)} · <b class="${st.net < 0 ? 'neg' : 'pos'}">${money(st.net)}</b>` : ''}</span>
        <span class="muted">${st.km ? money(st.gain / st.km) + '/km' : ''}${costPerKm() ? ' · custo ' + money(costPerKm()) + '/km' : ''}${pay.kmPerL && st.km ? ' · ~' + (st.km / pay.kmPerL).toFixed(1).replace('.', ',') + ' L' : ''} · ${fmtDur(st.sec)}</span>
      </summary>
      <div class="hbody"><ul>${addr}</ul>
        <label>Período desta rota <select data-rprof="${r.id}">${profileOptions(routePid(r))}</select></label>
        <div class="btns"><button class="primary" data-act="hmap" data-id="${r.id}">🗺 Ver trajeto e tempos no mapa</button>
        <button class="danger" data-act="rdel" data-id="${r.id}">🗑 Apagar rota</button></div></div></details>`;
  }).join('') || '<p class="muted">Nenhuma rota finalizada neste período. Inicie uma rota e finalize-a para ela aparecer aqui.</p>';
}

/* ---------- Gastos ---------- */
async function addExpense() {
  const valor = parseMoney($('exValor').value);
  if (valor <= 0) { $('exValor').focus(); return; }
  const e = {
    id: newId(), date: new Date(daySel + 'T12:00').getTime(), valor, cat: $('exCat').value, desc: $('exDesc').value.trim(),
    profileId: $('exProf').value === 'geral' ? null : $('exProf').value,
  };
  expenses.push(e);
  await DB.putOf('expenses', e);
  $('exValor').value = ''; $('exDesc').value = '';
  renderDay();
}

/* ---------- Editor de períodos (Configurações) ---------- */
let editProfiles = [];

function profileEditorHtml(p, i) {
  return `<div class="prof" data-id="${p.id}">
    <div class="two">
      <label>Nome <input data-f="name" type="text" value="${esc(p.name)}" placeholder="Manhã"></label>
      <label>Local <input data-f="local" type="text" value="${esc(p.local || '')}" placeholder="Onde trabalha"></label>
    </div>
    <label>Como é pago
      <select data-f="mode">
        ${Object.entries(MODE_LABEL).map(([v, l]) => `<option value="${v}" ${p.mode === v ? 'selected' : ''}>${l}</option>`).join('')}
      </select>
    </label>
    <div class="two">
      <label class="fx" ${p.mode === 'entrega' ? 'hidden' : ''}>Fixo por dia (R$) <input data-f="fixed" type="text" inputmode="decimal" value="${p.fixed ? String(p.fixed).replace('.', ',') : ''}" placeholder="100,00"></label>
      <label class="pe" ${p.mode === 'fixo' ? 'hidden' : ''}>Por entrega (R$) <input data-f="perDelivery" type="text" inputmode="decimal" value="${p.perDelivery ? String(p.perDelivery).replace('.', ',') : ''}" placeholder="5,00"></label>
    </div>
    <div class="two">
      <label>Horário: das <input data-f="from" type="time" value="${p.from || ''}"></label>
      <label>até <input data-f="to" type="time" value="${p.to || ''}"></label>
    </div>
    ${editProfiles.length > 1 ? `<button type="button" class="danger" data-pdel="${i}">Remover este período</button>` : ''}
  </div>`;
}

function readProfileEditor() {
  return [...document.querySelectorAll('#profList .prof')].map((el, i) => {
    const f = n => el.querySelector(`[data-f="${n}"]`).value;
    return {
      id: el.dataset.id, name: f('name').trim() || `Período ${i + 1}`, local: f('local').trim(), mode: f('mode'),
      fixed: parseMoney(f('fixed')), perDelivery: parseMoney(f('perDelivery')), from: f('from'), to: f('to'),
    };
  });
}

function renderProfileEditor() {
  $('profList').innerHTML = editProfiles.map(profileEditorHtml).join('');
}

function openProfileEditor() {
  editProfiles = profiles.map(p => ({ ...p }));
  renderProfileEditor();
}

function profileEditorBind() {
  $('profAdd').onclick = () => { editProfiles = readProfileEditor(); editProfiles.push(newProfile(`Período ${editProfiles.length + 1}`)); renderProfileEditor(); };
  $('profList').onclick = e => {
    const b = e.target.closest('[data-pdel]');
    if (!b) return;
    editProfiles = readProfileEditor();
    editProfiles.splice(+b.dataset.pdel, 1);
    renderProfileEditor();
  };
  $('profList').onchange = e => {
    if (!e.target.matches('[data-f="mode"]')) return;
    const el = e.target.closest('.prof');
    el.querySelector('.fx').hidden = e.target.value === 'entrega';
    el.querySelector('.pe').hidden = e.target.value === 'fixo';
  };
}

async function saveProfiles() {
  const list = readProfileEditor();
  profiles = list.length ? list : [newProfile('Padrão')];
  await DB.set('profiles', profiles);
}
