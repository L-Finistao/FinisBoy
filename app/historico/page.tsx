'use client';
import Link from 'next/link';
import { useState } from 'react';
import { useApp } from '../../lib/client/use-app';
import { useRequireUser } from '../../lib/client/use-sync';
import * as A from '../../lib/client/store';
import { Shell } from '../_components/Shell';
import { fmtClock, fmtDur, money } from '../../lib/core/format';
import { collect, costPerKm, dayKey, fmtDay, fmtKm, fmtTime, periodStart, routePid, routeStats, sumSlots } from '../../lib/core/earnings';

const dash = '—';
const Stat = ({ l, v, tone = '' }: { l: string; v: string | number; tone?: string }) => <div className="stat"><small>{l}</small><b className={tone}>{v}</b></div>;

export default function Historico() {
  const sync = useRequireUser();
  const app = useApp();
  const [period, setPeriod] = useState('semana');
  const [pf, setPf] = useState('all');

  if (!sync.ready || !sync.user || !app.ready) return <div className="app"><p className="empty">Carregando…</p></div>;

  const ctx = A.earningsCtx();
  const perKm = costPerKm(app.pay);
  const from = periodStart(period);
  const fin = app.routes.filter(r => r.status === 'finalizada' && (r.endedAt || 0) >= from && (pf === 'all' || routePid(ctx, r) === pf)).sort((a, b) => (b.endedAt || 0) - (a.endedAt || 0));
  const slots = [...collect(ctx, from, Date.now() + 86400000, pf).values()];
  const t = sumSlots(slots), net = t.gain - t.spent;
  const pname = (pid: string) => app.profiles.find(p => p.id === pid)?.name || 'Geral';

  const per = new Map<string, { days: Set<string>; n: number; gain: number; spent: number; km: number }>();
  for (const s of slots) {
    const a = per.get(s.pid) || { days: new Set<string>(), n: 0, gain: 0, spent: 0, km: 0 };
    if (s.gain || s.n || s.fin.length) a.days.add(s.day);
    a.n += s.n; a.gain += s.gain; a.spent += s.spent; a.km += s.km;
    per.set(s.pid, a);
  }

  return (
    <Shell running={!!A.session()}>
      <div className="two">
        <label>Período
          <select value={period} onChange={e => setPeriod(e.target.value)}>
            <option value="hoje">Hoje</option><option value="semana">Esta semana</option><option value="mes">Este mês</option><option value="tudo">Tudo</option>
          </select></label>
        <label>Período trabalhado
          <select value={pf} onChange={e => setPf(e.target.value)}>
            <option value="all">Todos</option>{app.profiles.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select></label>
      </div>

      <section className="panel">
        <div className="eyebrow">Resumo</div>
        <div className="grid2">
          <Stat l="Rotas" v={fin.length} /><Stat l="Entregas" v={t.n} />
          <Stat l="Km rodados" v={t.km ? fmtKm(t.km) : dash} /><Stat l="Ganho bruto" v={money(t.gain)} tone="g" />
          <Stat l="Gastos" v={money(t.spent)} tone="neg" /><Stat l="Líquido" v={money(net)} tone={net < 0 ? 'neg' : 'g'} />
          <Stat l="Ganho por km" v={t.km ? money(t.gain / t.km) : dash} /><Stat l="Custo por km" v={t.km ? money(t.spent / t.km) : dash} />
        </div>
      </section>

      {pf === 'all' && per.size > 1 && (
        <>
          <div className="sechead"><h2>Por período trabalhado</h2></div>
          {[...per.entries()].map(([pid, a]) => {
            const nt = a.gain - a.spent;
            return (
              <section key={pid} className="panel">
                <div className="rowb"><b>{pname(pid)}</b><span className="muted">{a.days.size} dia(s)</span></div>
                <div className="grid3">
                  <Stat l="Entregas" v={a.n} /><Stat l="Ganho" v={money(a.gain)} tone="g" /><Stat l="Líquido" v={money(nt)} tone={nt < 0 ? 'neg' : 'g'} />
                  <Stat l="Por dia" v={a.days.size ? money(nt / a.days.size) : dash} /><Stat l="Por entrega" v={a.n ? money(nt / a.n) : dash} /><Stat l="Km" v={a.km ? fmtKm(a.km) : dash} />
                </div>
              </section>
            );
          })}
        </>
      )}

      <div className="sechead"><h2>Rotas finalizadas</h2></div>
      {fin.length ? (
        <ul className="stops">
          {fin.map(r => {
            const stops = A.routeStops(r.id).sort((a, b) => (a.doneAt || 0) - (b.doneAt || 0));
            const st = routeStats(ctx, r, stops.length, perKm);
            return (
              <li key={r.id}>
                <details className="hrow">
                  <summary>
                    <span className="rowb"><b>{r.name} <span className="badge">{pname(routePid(ctx, r))}</span></b><b className="g">{money(st.gain)}</b></span>
                    <span className="muted">{fmtDay(dayKey(r.endedAt || 0))} {fmtTime(r.startedAt || 0)}–{fmtTime(r.endedAt || 0)} · {st.n}/{st.total} entregas · {r.kmSrc === 'plan' ? '~' : ''}{fmtKm(st.km)} · {fmtDur(st.sec)}</span>
                    {perKm > 0 && <span className="muted">custo {money(st.cost)} · líquido <b className={st.net < 0 ? 'neg' : 'g'}>{money(st.net)}</b>{app.pay.kmPerL && st.km ? ` · ~${(st.km / app.pay.kmPerL).toFixed(1).replace('.', ',')} L` : ''}</span>}
                  </summary>
                  <div className="hbody">
                    <ul>{stops.map(s => <li key={s.id} className={s.done ? '' : 'miss'}>{s.done ? '✓' : '✗'} {s.raw}{s.durSec != null && <span className="muted"> ({fmtClock(s.durSec)})</span>}</li>)}</ul>
                    <label>Período desta rota
                      <select value={routePid(ctx, r)} onChange={e => void A.setRouteProfile(r.id, e.target.value)}>
                        {app.profiles.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                      </select></label>
                    <div className="row">
                      <Link className="btn primary" href={`/historico/${r.id}`}>Ver trajeto e tempos</Link>
                      <button className="soft-bad" onClick={() => { if (confirm(`Apagar "${r.name}" do histórico? Os ganhos dela também saem da conta.`)) void A.deleteRoute(r.id); }}>Apagar rota</button>
                    </div>
                  </div>
                </details>
              </li>
            );
          })}
        </ul>
      ) : <div className="panel empty">Nenhuma rota finalizada neste período. Inicie uma rota e finalize-a para ela aparecer aqui.</div>}
    </Shell>
  );
}
