import type { Delivery, Route } from './types';

/* Períodos de trabalho, ganhos e gastos.
   Você pode trabalhar em mais de um período no mesmo dia (ex.: manhã e noite), cada um com seu local e seu
   modelo de pagamento: por entrega, fixo ou fixo + por entrega. Os dados são separados por período. */

export interface Profile { id: string; name: string; local: string; mode: 'entrega' | 'fixo' | 'misto'; perDelivery: number; fixed: number; from: string; to: string }
export interface Expense { id: string; date: number; valor: number; cat: string; desc: string; profileId: string | null }

// Custos da moto (o modelo de pagamento ficou nos períodos; mode/perDelivery/fixed só migram versões antigas).
export interface Pay {
  mode?: Profile['mode']; perDelivery?: number; fixed?: number;
  fuelPrice: number; kmPerL: number; oilPrice: number; oilKm: number; otherKm: number;
}
export const DEFAULT_PAY: Pay = { fuelPrice: 0, kmPerL: 0, oilPrice: 0, oilKm: 0, otherKm: 0 };

export const MODE_LABEL: Record<Profile['mode'], string> = { entrega: 'Por entrega', fixo: 'Fixo por dia', misto: 'Fixo + por entrega' };

/* ---------- Formatação e datas ---------- */
const pad2 = (n: number) => String(n).padStart(2, '0');
export const dayKey = (ts: number) => { const d = new Date(ts); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; };
export const fmtDay = (k: string) => `${k.slice(8)}/${k.slice(5, 7)}`;
export const fmtTime = (ts: number) => { const d = new Date(ts); return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`; };
export const fmtKm = (km: number) => km.toFixed(1).replace('.', ',') + ' km';
export const dayBounds = (k: string): [number, number] => { const a = new Date(k + 'T00:00:00').getTime(); return [a, a + 86400000]; };
// Aceita "6,50", "6.50" e "1.234,50".
export const parseMoney = (v: string) => {
  const s = String(v).trim();
  const n = parseFloat(s.includes(',') || !/^\d+\.\d{1,2}$/.test(s) ? s.replace(/\./g, '').replace(',', '.') : s);
  return isNaN(n) ? 0 : n;
};
export function periodStart(p: string) {
  const d = new Date(); d.setHours(0, 0, 0, 0);
  if (p === 'tudo') return 0;
  if (p === 'semana') d.setDate(d.getDate() - ((d.getDay() + 6) % 7));   // segunda-feira
  if (p === 'mes') d.setDate(1);
  return d.getTime();
}

/* ---------- Custo da moto ---------- */
export function costParts(pay: Pay) {
  return { fuel: pay.kmPerL > 0 ? pay.fuelPrice / pay.kmPerL : 0, oil: pay.oilKm > 0 ? pay.oilPrice / pay.oilKm : 0, other: pay.otherKm || 0 };
}
export const costPerKm = (pay: Pay) => { const c = costParts(pay); return c.fuel + c.oil + c.other; };

/* ---------- Períodos ---------- */
export const newProfile = (id: string, name = 'Novo período'): Profile => ({ id, name, local: '', mode: 'entrega', perDelivery: 0, fixed: 0, from: '', to: '' });

export function modeText(p: Profile, money: (n: number) => string) {
  if (p.mode === 'fixo') return `Fixo ${money(p.fixed)}`;
  if (p.mode === 'misto') return `Fixo ${money(p.fixed)} + ${money(p.perDelivery)}/entrega`;
  return `${money(p.perDelivery)} por entrega`;
}

const hourOf = (s: string) => { const m = /^(\d{1,2}):(\d{2})$/.exec(s || ''); return m ? +m[1] + +m[2] / 60 : null; };

// Período que combina com o horário atual (se os horários foram preenchidos).
export function autoProfileId(profiles: Profile[], date = new Date()) {
  const h = date.getHours() + date.getMinutes() / 60;
  for (const p of profiles) {
    const a = hourOf(p.from), b = hourOf(p.to);
    if (a == null || b == null || a === b) continue;
    if (a < b ? h >= a && h < b : h >= a || h < b) return p.id;       // aceita virada de dia (ex.: 18:00 às 02:00)
  }
  return null;
}

export const normPid = (profiles: Profile[], id?: string | null) => (profiles.some(p => p.id === id) ? id! : profiles[0]?.id || '');

/* ---------- Cálculo ---------- */
// Ganho bruto de um período num dia. O fixo vale por dia trabalhado (houve entrega ou rota finalizada).
export function shiftGain(p: Profile | undefined, n: number, worked: boolean) {
  if (!p || (!n && !worked)) return 0;
  return (p.mode !== 'fixo' ? n * p.perDelivery : 0) + (p.mode !== 'entrega' ? p.fixed : 0);
}

export interface Ctx { profiles: Profile[]; routes: Route[]; deliveries: Delivery[]; expenses: Expense[] }
export interface Slot { day: string; pid: string; n: number; fin: Route[]; spent: number; km: number; sec: number; live: boolean; gain: number; net: number }

const kmOf = (r: Route) => (r.kmFinal || 0) / 1000;
export const routePid = (c: Ctx, r?: Route) => normPid(c.profiles, r?.profileId);

// Junta entregas, rotas e gastos por (dia, período).
export function collect(c: Ctx, from: number, to: number, pf = 'all', live: Route | null = null) {
  const m = new Map<string, Slot>();
  const slot = (day: string, pid: string) => {
    const key = day + '|' + pid;
    if (!m.has(key)) m.set(key, { day, pid, n: 0, fin: [], spent: 0, km: 0, sec: 0, live: false, gain: 0, net: 0 });
    return m.get(key)!;
  };
  const ok = (pid: string) => pf === 'all' || pid === pf;
  for (const d of c.deliveries) {
    if (d.doneAt < from || d.doneAt >= to) continue;
    const pid = routePid(c, c.routes.find(x => x.id === d.routeId));
    if (ok(pid)) slot(dayKey(d.doneAt), pid).n++;
  }
  for (const r of c.routes) {
    if (r.status !== 'finalizada' || !r.endedAt || r.endedAt < from || r.endedAt >= to) continue;
    const pid = routePid(c, r);
    if (!ok(pid)) continue;
    const s = slot(dayKey(r.endedAt), pid);
    s.fin.push(r); s.km += kmOf(r); s.sec += (r.endedAt - (r.startedAt || r.endedAt)) / 1000;
  }
  for (const e of c.expenses) {
    if (e.date < from || e.date >= to) continue;
    const pid = c.profiles.some(p => p.id === e.profileId) ? e.profileId! : 'geral';
    if (ok(pid)) slot(dayKey(e.date), pid).spent += e.valor;
  }
  if (live) {
    const t = Date.now(), pid = routePid(c, live);
    if (t >= from && t < to && ok(pid)) slot(dayKey(t), pid).live = true;
  }
  for (const s of m.values()) {
    s.gain = shiftGain(c.profiles.find(p => p.id === s.pid), s.n, s.fin.length > 0 || s.live);
    s.net = s.gain - s.spent;
  }
  return m;
}

export const sumSlots = (slots: Slot[]) => slots.reduce((t, s) => {
  t.n += s.n; t.rotas += s.fin.length; t.km += s.km; t.sec += s.sec; t.gain += s.gain; t.spent += s.spent;
  return t;
}, { n: 0, rotas: 0, km: 0, sec: 0, gain: 0, spent: 0 });

// O fixo vale uma vez por dia e período: entra inteiro na primeira rota finalizada do dia naquele período.
// No modo "fixo por dia" as entregas não rendem nada, só entram no custo (km).
export function routeStats(c: Ctx, r: Route, totalStops: number, perKm: number) {
  const pid = routePid(c, r), p = c.profiles.find(x => x.id === pid);
  const n = c.deliveries.filter(d => d.routeId === r.id).length;
  const day = dayKey(r.endedAt || 0);
  const first = c.routes.filter(x => x.status === 'finalizada' && dayKey(x.endedAt || 0) === day && routePid(c, x) === pid)
    .sort((a, b) => (a.endedAt || 0) - (b.endedAt || 0))[0];
  const fixed = p && p.mode !== 'entrega' && first && first.id === r.id ? p.fixed : 0;
  const gain = p ? (p.mode !== 'fixo' ? n * p.perDelivery : 0) + fixed : 0;
  const km = kmOf(r), cost = km * perKm;
  return { n, total: totalStops, gain, km, cost, net: gain - cost, sec: ((r.endedAt || 0) - (r.startedAt || 0)) / 1000 };
}

export function todayGross(c: Ctx, live: Route | null) {
  const [a, b] = dayBounds(dayKey(Date.now()));
  return sumSlots([...collect(c, a, b, 'all', live).values()]).gain;
}
