'use client';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useEffect, useState, type FormEvent } from 'react';
import { useApp } from '../../lib/client/use-app';
import { useRequireUser } from '../../lib/client/use-sync';
import * as A from '../../lib/client/store';
import { Shell } from '../_components/Shell';
import { Icon } from '../_components/Icon';
import { Character, GameCard } from '../_components/Game';
import { companionOf } from '../../lib/core/game';
import { useGame } from '../../lib/client/game';
import { useLive, addHazard, removeHazard, removeFav } from '../../lib/client/live';
import { useVoiceCfg, startListening, stopListening, voiceSupport } from '../../lib/client/voice';
import { onHeard, voiceRoute } from '../../lib/client/commands';
import { useKeepOn, useWakeLock } from '../../lib/client/wake';
import { HAZARD } from '../../lib/core/learn';
import { fmtClock, fmtDist, fmtDur, money } from '../../lib/core/format';
import { costPerKm, todayGross, type Profile } from '../../lib/core/earnings';
import type { Stop } from '../../lib/core/types';

const MapView = dynamic(() => import('./MapView'), { ssr: false, loading: () => <div className="map" /> });

const hhmm = (t: number) => new Date(t).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
const profLabel = (p: Profile) => p.name + (p.local ? ' · ' + p.local : '');

function meta(s: Stop) {
  if (s.failed) return { t: 'Endereço não localizado — corrija ou marque no mapa', bad: true };
  if (s.lat == null) return { t: 'Localizando…' };
  if (s.precision === 'street') return { t: 'Posição aproximada (na rua)' };
  if (s.precision === 'cep') return { t: 'Posição aproximada (pelo CEP)' };
  return { t: s.legDist != null ? `${fmtDist(s.legDist)} · ${fmtDur(s.legDur || 0)}` : '' };
}

export default function Rotas() {
  const sync = useRequireUser();
  const app = useApp();
  const { cfg, game } = useGame();
  const { info, learn } = useLive();
  const vcfg = useVoiceCfg();
  const [keepOn] = useKeepOn();
  const [hz, setHz] = useState(false);
  const [adding, setAdding] = useState(false);
  const [follow, setFollow] = useState(true);
  const [center, setCenter] = useState(0);
  const [all, setAll] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [sheetH, setSheetH] = useState(260);
  // altura real da folha inferior: o mapa enquadra a rota na parte que continua visível
  const [sheetEl, setSheetEl] = useState<HTMLElement | null>(null);
  useEffect(() => {
    if (!sheetEl) return;
    const ro = new ResizeObserver(() => setSheetH(sheetEl.offsetHeight));
    ro.observe(sheetEl); setSheetH(sheetEl.offsetHeight);
    return () => ro.disconnect();
  }, [sheetEl]);

  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);
  // ao iniciar a corrida o mapa acompanha você de novo
  const running = A.session();
  useEffect(() => { if (running) { setFollow(true); setExpanded(false); } }, [running?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // escuta contínua só com a rota iniciada; tela acesa durante a rota
  useEffect(() => {
    if (!running || !vcfg.listen || !voiceSupport().listen) return;
    startListening(onHeard, m => A.setStatus(m, 6000));
    A.setStatus('🎙 Escutando. Diga "Turbo, entrega feita" ou "Turbo, ajuda".', 5000);
    return () => stopListening();
  }, [running?.id, vcfg.listen]); // eslint-disable-line react-hooks/exhaustive-deps
  useWakeLock(!!running && keepOn);

  if (!sync.ready || !sync.user || !app.ready) return <div className="app"><p className="empty">Carregando…</p></div>;

  const cur = A.currentRoute();
  const pend = A.pendingStops(app.curId);
  const mine = cur ? A.routeStops(cur.id) : [];
  const done = mine.filter(s => s.done).sort((a, b) => (a.doneAt || 0) - (b.doneAt || 0));
  const isRun = !!running && cur?.id === running.id;
  const next = isRun ? pend.find(s => s.lat != null) : null;
  const active = A.activeRoutes();
  const target = A.addTarget();
  const ctx = A.earningsCtx();

  async function submitAdd(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    await A.setCity(String(f.get('city') || '').trim());
    setAdding(false);
    const pid = String(f.get('profile') || '');
    if (pid) await A.setLastProfile(pid);
    void A.addFromText(String(f.get('txt') || ''), pid || undefined);
  }

  // Cronômetro da entrega atual: verde, amarelo (80% da meta) e vermelho (estourou)
  const leg = running ? (now - (running.legStartedAt || now)) / 1000 : 0, lim = app.target * 60;
  const st = !lim ? 'ok' : leg > lim ? 'late' : leg > lim * 0.8 ? 'warn' : 'ok';
  const nDone = running ? A.routeStops(running.id).filter(s => s.done).length : 0;
  const nAll = running ? A.routeStops(running.id).length : 0;
  const gain = todayGross(ctx, running), km = (running?.km || 0) / 1000;
  const perKm = costPerKm(app.pay);

  const rows = [...done, ...pend];
  const shown = all ? rows : [...done.slice(-1), ...pend.slice(0, 2)];   // resumo: última entregue + as próximas duas

  const map = (
    <MapView route={cur} stops={mine} me={app.me} picking={!!app.picking} follow={follow}
      onPick={(la, lo) => void A.placeStop(la, lo)} onDrag={() => setFollow(false)} centerSignal={center} avatar={cfg.avatar} accessory={cfg.accessory} buddy={companionOf(cfg.companion).e} bottomPad={isRun ? sheetH : 0}
      learn={learn} near={isRun ? info.near : null} onRemoveHazard={id => void removeHazard(id)} onRemoveFav={id => void removeFav(id)} />
  );
  const locateBtn = (
    <button className="icon-btn locate" aria-label="Centralizar em mim" onClick={() => { setFollow(true); setCenter(c => c + 1); void A.getPosition(); }}><Icon n="locate" /></button>
  );
  const pickHint = app.picking && (
    <div className="pickhint">📍 Toque no mapa onde fica a parada <button className="ghost" style={{ minHeight: 0, padding: '0 6px', color: 'inherit', textDecoration: 'underline' }} onClick={A.cancelPicking}>cancelar</button></div>
  );

  /* ---------- Corrida em andamento: o mapa ocupa a tela toda ---------- */
  if (isRun && running) {
    return (
      <div className="runview">
        <div className="runmap">{map}</div>
        <div className="runtop">
          <Link href="/ajustes" className="btn icon-btn" aria-label="Configurações"><Icon n="gear" /></Link>
          <span className="chip"><i className={`dot ${sync.online ? '' : 'off'}`} />{sync.online ? 'online' : 'offline'}{app.me ? ' · GPS ativo' : ''}</span>
          <span className="chip">⏱ {fmtClock((now - (running.startedAt || now)) / 1000)} · {fmtDist(running.km || 0)}{info.speedKmh != null ? ` · ${info.speedKmh} km/h` : ''}</span>
        </div>
        <div className="runloc">{locateBtn}</div>
        {pickHint}
        {app.status && !app.picking && <div className="status runstatus" role="status">{app.status}</div>}

        <section ref={setSheetEl} className={`rsheet ${expanded ? 'open' : ''}`}>
          <button className="handle" aria-label={expanded ? 'Recolher' : 'Expandir'} onClick={() => setExpanded(v => !v)} />
          <div className="rowb">
            <div><div className="eyebrow">{running.name} · entrega atual</div><div className="clock">{fmtClock(leg)}</div></div>
            <div style={{ textAlign: 'right' }}>
              {lim > 0 && <span className={`pill ${st === 'ok' ? '' : st}`}>{st === 'ok' ? 'dentro da meta' : st === 'warn' ? 'quase na meta' : 'passou da meta'}</span>}
              <div className="muted" style={{ marginTop: 4 }}>{nDone} de {nAll} entregas · {money(gain)}</div>
            </div>
          </div>
          {game && (
            <div className="gmini" style={{ marginTop: 8 }}>
              <Character cfg={cfg} size={30} buddy />
              <span className="muted">Nv {game.level}</span>
              <div className="xpbar"><i style={{ width: `${game.pct * 100}%` }} /></div>
              {cfg.goals.dayDeliveries > 0 && <span className="muted">🎯 {game.stats.today.n}/{cfg.goals.dayDeliveries}</span>}
              <span className="streak"><Icon n="flame" />{game.stats.curStreak}</span>
            </div>
          )}
          {info.left > 0 && (
            <p className="muted" style={{ marginTop: 6 }}>
              Restam {fmtDist(info.left)} · {fmtDur(info.etaSec)} · chega {hhmm(now + info.etaSec * 1000)}{info.slowNote}
              {running.geo?.learned ? ' · evitando trechos lentos' : ''}
            </p>
          )}
          {next ? (
            <div className="next-in">
              <div className="rowb"><span className="rowb" style={{ justifyContent: 'flex-start' }}><span className="num">{pend.indexOf(next) + 1}</span><span className="eyebrow">Próxima parada</span></span>
                {next.legDur != null && <b className="ok">{hhmm(now + next.legDur * 1000)}</b>}</div>
              <div className="addr">{next.raw}</div>
              <div className="muted">{[next.legDist != null && `em ${fmtDist(next.legDist)}`, next.note, next.sender && '📞 ' + next.sender].filter(Boolean).join(' · ')}</div>
              <div className="btns">
                <a className="btn" target="_blank" rel="noopener" href={`https://www.google.com/maps/dir/?api=1&destination=${next.lat},${next.lon}&travelmode=two-wheeler`}><Icon n="nav" />Navegar</a>
                <button className="primary" onClick={() => void A.markDone(next.id, true)}><Icon n="check" />Marcar entrega</button>
              </div>
            </div>
          ) : <p className="muted" style={{ margin: '10px 0' }}>{pend.length ? 'Localizando as próximas paradas…' : 'Sem paradas pendentes.'}</p>}

          {expanded && (
            <>
              <div className="actions five" style={{ marginTop: 10 }}>
                <button disabled={app.busy} onClick={() => void A.buildRoute()}><span className="ic"><Icon n="refresh" /></span>Recalcular</button>
                <button onClick={() => setHz(true)}><span className="ic" style={{ background: 'var(--warn-soft)', color: 'var(--warn)' }}>⚠</span>Problema</button>
                <button onClick={() => voiceRoute()}><span className="ic">🔊</span>Falar rota</button>
                <button onClick={() => setAdding(true)}><span className="ic"><Icon n="plus" /></span>Adicionar</button>
                <button className="soft-bad" onClick={() => { if (confirm('Finalizar a rota e enviar para o histórico?')) void A.endRoute(); }}><span className="ic" style={{ background: 'var(--bad-soft)', color: 'var(--bad)' }}><Icon n="stop" /></span>Finalizar</button>
              </div>
              <ul className="stops" style={{ marginTop: 10, maxHeight: 190, overflowY: 'auto' }}>
                {rows.map(s => (
                  <li key={s.id} className={`stop ${s.done ? 'done' : ''} ${s.failed ? 'fail' : ''} ${s === next ? 'next-s' : ''}`}>
                    <div className="main" onClick={() => setOpen(open === s.id ? null : s.id)}>
                      <span className="ring">{s.done ? <Icon n="check" /> : pend.indexOf(s) + 1}</span>
                      <div className="txt"><div className="a">{s.raw}</div><div className="m">{meta(s).t}</div></div>
                      <div className="t">{s.done && s.doneAt ? hhmm(s.doneAt) : ''}</div>
                    </div>
                    {open === s.id && (
                      <div className="acts">
                        {s.done ? <button onClick={() => void A.markDone(s.id, false)}>Desfazer</button> : <button className="primary" onClick={() => void A.markDone(s.id, true)}><Icon n="check" />Entregue</button>}
                        {!s.done && <button onClick={() => { A.startPicking(s.id); setExpanded(false); }}><Icon n="pin" />Marcar no mapa</button>}
                        <button onClick={() => { const t = prompt('Corrigir endereço:', s.raw); if (t) void A.editStop(s.id, t); }}>Editar</button>
                        <button className="soft-bad" onClick={() => void A.removeStop(s.id)}><Icon n="trash" /></button>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
              <div className="rowb" style={{ marginTop: 10 }}>
                <div><div className="eyebrow">Resumo até agora</div>
                  <b>{money(gain)}</b>{km > 0.1 && gain > 0 && <span className="ok"> · {money(gain / km)}/km</span>}
                  {perKm > 0 && km > 0.1 && <div className="muted">custo {money(km * perKm)} · líquido {money(gain - km * perKm)}</div>}</div>
              </div>
            </>
          )}
        </section>

        {adding && <AddSheet app={app} target={target} onClose={() => setAdding(false)} onSubmit={submitAdd} />}
        {hz && (
          <div className="overlay" onClick={() => setHz(false)}>
            <div className="sheet" onClick={e => e.stopPropagation()} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <h2>⚠ Marcar problema aqui</h2>
              <p className="muted">As próximas rotas evitam este trecho. Toque num marcador do mapa para remover.</p>
              {Object.entries(HAZARD).map(([k, h]) => (
                <button key={k} onClick={async () => { setHz(false); const at = app.me; if (!at) { A.setStatus('Sem GPS: não consegui marcar o ponto.', 4000); return; } A.setStatus(await addHazard(k, at), 5000); }}>{h.icon} {h.label}</button>
              ))}
              <button className="ghost" onClick={() => setHz(false)}>Cancelar</button>
            </div>
          </div>
        )}
      </div>
    );
  }

  /* ---------- Planejamento ---------- */
  return (
    <Shell running={!!running} action={<button className="dark" onClick={() => setAdding(true)}><Icon n="plus" />Nova rota</button>}>
      {game && <GameCard game={game} cfg={cfg} name={sync.user.name || 'Piloto'} />}
      <div className="mapcard">
        {map}
        {app.me && <span className="chip l"><i className="dot" />GPS ativo</span>}
        {app.city && <span className="chip r">{app.city}</span>}
        {locateBtn}
        {pickHint}
      </div>
      {app.status && !app.picking && <div className="status" role="status">{app.status}</div>}

      {cur && (
        <div className="actions">
          <button disabled={app.busy} onClick={() => void A.buildRoute()}><span className="ic"><Icon n="refresh" /></span>Recalcular</button>
          <button onClick={async () => { await A.getPosition(); setCenter(c => c + 1); }}><span className="ic"><Icon n="pin" /></span>Minha posição</button>
          <button onClick={() => setAll(v => !v)}><span className="ic"><Icon n="list" /></span>Lista</button>
        </div>
      )}

      <div className="sechead"><h2>Rotas atuais</h2></div>
      {!active.length && <div className="panel empty">Nenhuma rota ainda. Toque em “Nova rota”, cole o texto do WhatsApp e a rota é montada sozinha.</div>}
      {active.map(r => {
        const rs = A.routeStops(r.id), feitas = rs.filter(s => s.done).length, em = r.status === 'andamento';
        const saved = r.geo?.baseline ? r.geo.baseline.duration - r.geo.duration : 0;
        const info = [`${rs.length} parada(s)`, feitas ? `${feitas} entregue(s)` : '', r.geo ? `${fmtDist(r.geo.distance)} · ${fmtDur(r.geo.duration)}` : '', saved > 60 ? `⚡ ${fmtDur(saved)} a menos` : ''].filter(Boolean).join(' · ');
        return (
          <section key={r.id} className={`panel rcard ${r.id === app.curId ? 'sel' : ''}`} onClick={() => A.selectRoute(r.id)}>
            <div className="rowb"><b>{r.name}</b><span className={`pill ${em ? '' : 'gray'}`}>{em ? 'Em andamento' : 'Pendente'}</span></div>
            <div className="muted" style={{ marginTop: 4 }}>{info}</div>
            <label style={{ marginTop: 8 }} onClick={e => e.stopPropagation()}>Período trabalhado
              <select value={r.profileId || ''} onChange={e => void A.setRouteProfile(r.id, e.target.value)}>
                {app.profiles.map(p => <option key={p.id} value={p.id}>{profLabel(p)}</option>)}
              </select>
            </label>
            {!em && (
              <div className="btns">
                <button className="primary" disabled={!!running} onClick={e => { e.stopPropagation(); void A.startRoute(r.id); }}><Icon n="play" />Iniciar corrida</button>
                <button className="soft-bad icon-btn" aria-label="Apagar" style={{ borderRadius: 12, width: 46, height: 46 }} onClick={e => { e.stopPropagation(); if (confirm(`Apagar "${r.name}"?`)) void A.deleteRoute(r.id); }}><Icon n="trash" /></button>
              </div>
            )}
          </section>
        );
      })}

      {cur && rows.length > 0 && (
        <>
          <div className="sechead">
            <h2>Paradas da rota<span className="sub">{pend.length} pendente(s){done.length ? `, ${done.length} entregue(s)` : ''}</span></h2>
            {rows.length > 3 && <button className="ghost" style={{ minHeight: 0, padding: 0 }} onClick={() => setAll(v => !v)}>{all ? 'Ver menos' : 'Ver todas'} ›</button>}
          </div>
          <ul className="stops">
            {(all ? rows : pend.slice(0, 5)).map(s => {
              const m = meta(s);
              return (
                <li key={s.id} className={`stop ${s.done ? 'done' : ''} ${s.failed ? 'fail' : ''}`}>
                  <div className="main" onClick={() => setOpen(open === s.id ? null : s.id)}>
                    <span className="ring">{s.done ? <Icon n="check" /> : pend.indexOf(s) + 1}</span>
                    <div className="txt">
                      <div className="a">{s.raw}</div>
                      <div className={`m ${m.bad ? 'f' : ''}`}>{[s.note, m.t].filter(Boolean).join(' · ')}</div>
                    </div>
                    <div className="t">{s.done && s.doneAt ? hhmm(s.doneAt) : ''}</div>
                  </div>
                  {open === s.id && (
                    <div className="acts">
                      {s.done ? <button onClick={() => void A.markDone(s.id, false)}>Desfazer</button> : <button className="primary" onClick={() => void A.markDone(s.id, true)}><Icon n="check" />Entregue</button>}
                      {!s.done && <button onClick={() => A.startPicking(s.id)}><Icon n="pin" />Marcar no mapa</button>}
                      <button onClick={() => { const t = prompt('Corrigir endereço:', s.raw); if (t) void A.editStop(s.id, t); }}>Editar</button>
                      <button className="soft-bad" onClick={() => void A.removeStop(s.id)}><Icon n="trash" /></button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </>
      )}

      {!!active.length && (
        <button className="ghost full" onClick={() => { if (confirm('Apagar as rotas pendentes?')) void A.clearPending(); }}>Limpar rotas pendentes</button>
      )}

      {adding && <AddSheet app={app} target={target} onClose={() => setAdding(false)} onSubmit={submitAdd} />}
    </Shell>
  );
}

function AddSheet({ app, target, onClose, onSubmit }: { app: ReturnType<typeof useApp>; target: ReturnType<typeof A.addTarget>; onClose: () => void; onSubmit: (e: FormEvent<HTMLFormElement>) => void }) {
  return (
    <div className="overlay" onClick={onClose}>
      <form className="sheet" onClick={e => e.stopPropagation()} onSubmit={onSubmit} style={{ gap: 10 }}>
        <h2>{target ? 'Adicionar endereços' : 'Nova rota'}</h2>
        <p className="muted">{target ? `Cole os endereços: eles entram em "${target.name}" e a rota é recalculada.` : 'Cole a mensagem do WhatsApp com os endereços.'}</p>
        {!target && (
          <label>Período de trabalho
            <select name="profile" defaultValue={A.defaultProfileId()}>{app.profiles.map(p => <option key={p.id} value={p.id}>{profLabel(p)}</option>)}</select>
          </label>
        )}
        <textarea name="txt" rows={8} autoFocus placeholder={'[29/10, 21:23] +55 18 99764-0397: Rua das Flores, 123 - Centro\n...'} />
        <label>Cidade / UF padrão<input name="city" defaultValue={app.city} placeholder="Ex.: Birigui - SP" autoComplete="off" /></label>
        <div className="row">
          <button type="button" onClick={onClose}>Cancelar</button>
          <button className="primary">{target ? 'Adicionar' : 'Criar rota'}</button>
        </div>
      </form>
    </div>
  );
}
