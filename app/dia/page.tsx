'use client';
import { useState, type FormEvent } from 'react';
import { useApp } from '../../lib/client/use-app';
import { useRequireUser } from '../../lib/client/use-sync';
import * as A from '../../lib/client/store';
import { Shell } from '../_components/Shell';
import { Icon } from '../_components/Icon';
import { fmtClock, fmtDur, money } from '../../lib/core/format';
import { collect, costPerKm, dayBounds, dayKey, fmtDay, fmtKm, fmtTime, modeText, parseMoney, routePid, routeStats, sumSlots, type Slot } from '../../lib/core/earnings';

const CATS = ['Combustível', 'Manutenção', 'Alimentação', 'Aluguel da moto', 'Outros'];
const dash = '—';

function Stat({ l, v, tone = '' }: { l: string; v: string | number; tone?: string }) {
  return <div className="stat"><small>{l}</small><b className={tone}>{v}</b></div>;
}

export default function Dia() {
  const sync = useRequireUser();
  const app = useApp();
  const [day, setDay] = useState(() => dayKey(Date.now()));
  const [range, setRange] = useState(14);

  if (!sync.ready || !sync.user || !app.ready) return <div className="app"><p className="empty">Carregando…</p></div>;

  const ctx = A.earningsCtx();
  const running = A.session();
  const today = day === dayKey(Date.now());
  const [from, to] = dayBounds(day);
  const slots = [...collect(ctx, from, to, 'all', today ? running : null).values()]
    .sort((a, b) => app.profiles.findIndex(p => p.id === a.pid) - app.profiles.findIndex(p => p.id === b.pid));
  const t = sumSlots(slots), net = t.gain - t.spent;
  const fin = app.routes.filter(r => r.status === 'finalizada' && r.endedAt && r.endedAt >= from && r.endedAt < to).sort((a, b) => (a.endedAt || 0) - (b.endedAt || 0));
  const exp = app.expenses.filter(e => e.date >= from && e.date < to).sort((a, b) => b.date - a.date);
  const timed = app.stops.filter(s => s.durSec != null && s.doneAt && s.doneAt >= from && s.doneAt < to);
  const avg = timed.length ? timed.reduce((a, s) => a + (s.durSec || 0), 0) / timed.length : null;
  const perKm = costPerKm(app.pay);
  const pname = (pid: string | null) => app.profiles.find(p => p.id === pid)?.name || 'Geral';

  // Ganho e gasto dia a dia
  const end = dayBounds(dayKey(Date.now()))[1];
  const byDay = new Map<string, Slot[]>();
  for (const s of collect(ctx, end - range * 86400000, end, 'all', running).values()) byDay.set(s.day, [...(byDay.get(s.day) || []), s]);
  const rows = [...byDay.keys()].sort().reverse().map(d => { const sl = byDay.get(d)!, tt = sumSlots(sl); return { d, tt, net: tt.gain - tt.spent, sl }; });
  const max = Math.max(1, ...rows.map(r => Math.max(r.tt.gain, r.tt.spent)));
  const tot = rows.reduce((a, r) => ({ gain: a.gain + r.tt.gain, spent: a.spent + r.tt.spent }), { gain: 0, spent: 0 });
  const worked = rows.filter(r => r.tt.gain > 0 || r.tt.n > 0).length;

  const shift = (n: number) => { const d = new Date(day + 'T12:00'); d.setDate(d.getDate() + n); setDay(dayKey(d.getTime())); };

  async function addExp(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const valor = parseMoney(String(f.get('valor')));
    if (valor <= 0) return;
    const pid = String(f.get('profile'));
    await A.addExpense({ date: new Date(day + 'T12:00').getTime(), valor, cat: String(f.get('cat')), desc: String(f.get('desc') || '').trim(), profileId: pid === 'geral' ? null : pid });
    e.currentTarget.reset();
  }

  return (
    <Shell running={!!running}>
      <div className="panel daynav">
        <button className="icon-btn" aria-label="Dia anterior" onClick={() => shift(-1)}>‹</button>
        <input type="date" value={day} onChange={e => e.target.value && setDay(e.target.value)} />
        <button className="icon-btn" aria-label="Próximo dia" onClick={() => shift(1)}>›</button>
        <button onClick={() => setDay(dayKey(Date.now()))}>Hoje</button>
      </div>

      <section className="panel">
        <div className="eyebrow">Resumo do dia</div>
        <div className="grid2">
          <Stat l="Entregas" v={t.n} /><Stat l="Rotas finalizadas" v={t.rotas} />
          <Stat l="Km rodados" v={t.km ? fmtKm(t.km) : dash} /><Stat l="Tempo em rota" v={t.sec ? fmtDur(t.sec) : dash} />
          <Stat l="Ganho bruto" v={money(t.gain)} tone="g" /><Stat l="Gastos" v={money(t.spent)} tone="neg" />
          <Stat l="Líquido" v={money(net)} tone={net < 0 ? 'neg' : 'g'} /><Stat l="Média por entrega" v={avg != null ? fmtClock(avg) : dash} />
          <Stat l="Ganho por km" v={t.km ? money(t.gain / t.km) : dash} /><Stat l="Custo da moto por km" v={perKm ? money(perKm) : dash} />
        </div>
      </section>

      <div className="sechead"><h2>Por período trabalhado</h2></div>
      {slots.length ? slots.map(s => {
        const p = app.profiles.find(x => x.id === s.pid);
        return (
          <section key={s.pid} className="panel">
            <div className="rowb"><b>{p ? p.name + (p.local ? ' · ' + p.local : '') : 'Geral (sem período)'}</b>{p && <span className="muted">{modeText(p, money)}</span>}</div>
            <div className="grid3">
              <Stat l="Entregas" v={s.n} /><Stat l="Rotas" v={s.fin.length} /><Stat l="Km" v={s.km ? fmtKm(s.km) : dash} />
              <Stat l="Ganho" v={money(s.gain)} tone="g" /><Stat l="Gastos" v={money(s.spent)} tone="neg" /><Stat l="Líquido" v={money(s.net)} tone={s.net < 0 ? 'neg' : 'g'} />
            </div>
          </section>
        );
      }) : <div className="panel empty">Nenhum período trabalhado neste dia.</div>}

      <div className="sechead"><h2>Rotas do dia</h2></div>
      <ul className="stops">
        {fin.map(r => {
          const st = routeStats(ctx, r, A.routeStops(r.id).length, perKm);
          return (
            <li key={r.id} className="stop"><div className="main" style={{ cursor: 'default' }}>
              <div className="txt"><div className="a">{r.name} · {pname(routePid(ctx, r))}</div><div className="m">{fmtTime(r.startedAt || 0)}–{fmtTime(r.endedAt || 0)} · {st.n} entrega(s) · {fmtKm(st.km)}</div></div>
              <div className="t"><b>{money(st.gain)}</b></div>
            </div></li>
          );
        })}
        {!fin.length && <li className="stop muted">Nenhuma rota finalizada neste dia.</li>}
      </ul>

      <div className="sechead"><h2>Gastos do dia</h2></div>
      <ul className="stops">
        {exp.map(e => (
          <li key={e.id} className="stop"><div className="main" style={{ cursor: 'default' }}>
            <div className="txt"><div className="a">{e.cat}{e.desc ? ' · ' + e.desc : ''}</div><div className="m">{pname(e.profileId)}</div></div>
            <div className="t"><b className="neg">{money(e.valor)}</b></div>
            <button className="icon-btn soft-bad" aria-label="Apagar gasto" onClick={() => void A.removeExpense(e.id)}><Icon n="trash" /></button>
          </div></li>
        ))}
        {!exp.length && <li className="stop muted">Nenhum gasto neste dia.</li>}
      </ul>
      <form className="panel" onSubmit={addExp}>
        <div className="eyebrow">Apontar gasto</div>
        <div className="row"><input name="valor" inputMode="decimal" placeholder="Valor R$" required />
          <select name="cat">{CATS.map(c => <option key={c}>{c}</option>)}</select></div>
        <select name="profile" defaultValue={A.defaultProfileId()}>
          {app.profiles.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}<option value="geral">Geral (sem período)</option>
        </select>
        <input name="desc" placeholder="Descrição (opcional)" />
        <button className="primary"><Icon n="plus" />Apontar gasto</button>
      </form>

      <div className="sechead"><h2>Ganho e gasto por dia</h2>
        <select value={range} onChange={e => setRange(+e.target.value)} style={{ padding: '6px 8px' }}>
          <option value={7}>7 dias</option><option value={14}>14 dias</option><option value={30}>30 dias</option>
        </select></div>
      <section className="panel">
        <div className="grid2">
          <Stat l="Ganho no período" v={money(tot.gain)} tone="g" /><Stat l="Gastos" v={money(tot.spent)} tone="neg" />
          <Stat l="Líquido" v={money(tot.gain - tot.spent)} tone={tot.gain - tot.spent < 0 ? 'neg' : 'g'} />
          <Stat l="Média por dia trabalhado" v={worked ? money((tot.gain - tot.spent) / worked) : dash} />
        </div>
      </section>
      <ul className="stops">
        {rows.map(r => (
          <li key={r.d} className="stop" style={{ cursor: 'pointer' }} onClick={() => { setDay(r.d); window.scrollTo({ top: 0, behavior: 'smooth' }); }}>
            <div className="rowb"><b>{fmtDay(r.d)} <span className="muted">{new Date(r.d + 'T12:00').toLocaleDateString('pt-BR', { weekday: 'short' })}</span></b><b className={r.net < 0 ? 'neg' : 'g'}>{money(r.net)}</b></div>
            <div className="bar"><i className="g" style={{ width: `${r.tt.gain / max * 100}%` }} /></div>
            <div className="bar"><i className="s" style={{ width: `${r.tt.spent / max * 100}%` }} /></div>
            <div className="m">{r.tt.n} entrega(s) · ganho {money(r.tt.gain)} · gastos {money(r.tt.spent)}</div>
          </li>
        ))}
        {!rows.length && <li className="stop muted">Nenhum dado neste intervalo.</li>}
      </ul>
    </Shell>
  );
}
