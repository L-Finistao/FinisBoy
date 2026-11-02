'use client';
import { useState } from 'react';
import { useRequireUser } from '../../lib/client/use-sync';
import { saveCfg, useGame } from '../../lib/client/game';
import { Shell } from '../_components/Shell';
import { Icon } from '../_components/Icon';
import { GoalRings, XpBar } from '../_components/Game';
import { fmtClock, money } from '../../lib/core/format';
import { fmtKm, parseMoney } from '../../lib/core/earnings';
import { AVATARS, THEMES, type Goals } from '../../lib/core/game';

const num = (v: string) => Math.max(0, Math.round(parseMoney(v)));

export default function Perfil() {
  const sync = useRequireUser();
  const { cfg, ready, game } = useGame();
  const [nick, setNick] = useState<string | null>(null);

  if (!sync.ready || !sync.user || !ready || !game) return <div className="app"><p className="empty">Carregando…</p></div>;

  const s = game.stats, unlocked = game.ach.filter(a => a.unlocked);
  const setGoal = (k: keyof Goals, v: string) => void saveCfg({ goals: { ...cfg.goals, [k]: num(v) } });
  const GOALS: { k: keyof Goals; l: string; ph: string }[] = [
    { k: 'dayDeliveries', l: 'Entregas por dia', ph: '10' }, { k: 'dayGain', l: 'Ganho por dia (R$)', ph: '150' },
    { k: 'weekDeliveries', l: 'Entregas por semana', ph: '50' }, { k: 'weekGain', l: 'Ganho por semana (R$)', ph: '800' },
  ];
  const ch = game.challenge;

  return (
    <Shell>
      <section className="panel gcard">
        <div className="rowb" style={{ gap: 14 }}>
          <span className="avatar big">{cfg.avatar}</span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <input value={nick ?? cfg.nick} placeholder={sync.user.name || 'Seu apelido'} maxLength={20}
              onChange={e => setNick(e.target.value)} onBlur={() => { if (nick != null) { void saveCfg({ nick: nick.trim() }); setNick(null); } }}
              style={{ fontWeight: 800, fontSize: '1.15rem', padding: '6px 8px' }} />
            <div className="muted" style={{ marginTop: 4 }}>Nível {game.level} · {game.title}</div>
          </div>
          <div className="streak" style={{ flexDirection: 'column', fontSize: '1.2rem' }}><Icon n="flame" />{s.curStreak}<small style={{ color: 'var(--muted)', fontWeight: 500 }}>dias</small></div>
        </div>
        <XpBar game={game} />
        <div className="grid3">
          <div className="stat"><small>Entregas</small><b>{s.deliveries}</b></div>
          <div className="stat"><small>Rotas</small><b>{s.routes}</b></div>
          <div className="stat"><small>Km</small><b>{fmtKm(s.km)}</b></div>
          <div className="stat"><small>Melhor sequência</small><b>{s.bestStreak} dias</b></div>
          <div className="stat"><small>Mais rápida</small><b>{s.fastest != null ? fmtClock(s.fastest) : '—'}</b></div>
          <div className="stat"><small>XP total</small><b className="g">{game.xp}</b></div>
        </div>
      </section>

      <section className={`chal panel ${ch.done ? 'done' : ''}`} style={{ background: 'var(--brand-soft)' }}>
        <span className="ic" style={{ fontSize: '2rem' }}>{ch.done ? '✅' : ch.icon}</span>
        <div style={{ flex: 1 }}>
          <div className="eyebrow">Desafio do dia · +40 XP</div>
          <b>{ch.name}</b><div className="muted">{ch.desc}</div>
          <div className="xpbar" style={{ marginTop: 6 }}><i style={{ width: `${Math.min(1, ch.v / ch.goal) * 100}%` }} /></div>
        </div>
        <b>{Math.min(Math.floor(ch.v), ch.goal)}/{ch.goal}</b>
      </section>

      <div className="sechead"><h2>Metas</h2></div>
      <section className="panel" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <GoalRings game={game} cfg={cfg} />
        <p className="muted">Bata a meta do dia e ganhe <b>+50 XP</b>. Deixe em branco ou 0 para desligar uma meta.</p>
        <div className="two">
          {GOALS.map(g => (
            <label key={g.k}>{g.l}
              <input inputMode="numeric" placeholder={g.ph} defaultValue={cfg.goals[g.k] || ''} onBlur={e => setGoal(g.k, e.target.value)} />
            </label>
          ))}
        </div>
        <p className="muted">Hoje: {s.today.n} entrega(s) · {money(s.today.gain)} · {fmtKm(s.today.km)}</p>
      </section>

      <div className="sechead"><h2>Conquistas<span className="sub">{unlocked.length} de {game.ach.length}</span></h2></div>
      <div className="achgrid">
        {[...game.ach].sort((a, b) => Number(b.unlocked) - Number(a.unlocked) || b.pct - a.pct).map(a => (
          <div key={a.id} className={`ach ${a.unlocked ? '' : 'locked'}`} title={a.desc}>
            <span className="ic">{a.icon}</span>
            <b>{a.name}</b>
            <span>{a.unlocked ? 'Conquistada!' : a.desc}</span>
            {!a.unlocked && <div className="bar"><i className="g" style={{ width: `${a.pct * 100}%` }} /></div>}
            {!a.unlocked && <span>{Math.floor(a.v)}/{a.goal}</span>}
          </div>
        ))}
      </div>

      <div className="sechead"><h2>Personalizar<span className="sub">Desbloqueie subindo de nível</span></h2></div>
      <section className="panel" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div className="eyebrow">Avatar (aparece no mapa)</div>
        <div className="pick">
          {AVATARS.map(a => {
            const lock = game.level < a.lvl;
            return <button key={a.e} className={`${cfg.avatar === a.e ? 'sel' : ''} ${lock ? 'lock' : ''}`} disabled={lock} onClick={() => void saveCfg({ avatar: a.e })} aria-label={`Avatar ${a.e}`}>
              {lock ? <Icon n="lock" /> : a.e}{lock && <small>nv {a.lvl}</small>}</button>;
          })}
        </div>
        <div className="eyebrow">Tema de cores</div>
        <div className="pick">
          {THEMES.map(t => {
            const lock = game.level < t.lvl;
            return <button key={t.id} className={`sw ${cfg.theme === t.id ? 'sel' : ''} ${lock ? 'lock' : ''}`} disabled={lock} style={{ background: t.brand, borderColor: cfg.theme === t.id ? 'var(--ink)' : 'transparent' }}
              onClick={() => void saveCfg({ theme: t.id })}>{lock ? <Icon n="lock" /> : t.name}{lock && <small>nv {t.lvl}</small>}</button>;
          })}
        </div>
      </section>

      <section className="panel muted">
        <div className="eyebrow">Como ganhar XP</div>
        <p>📦 10 por entrega · ⏱️ +5 se dentro da meta de tempo · ⚡ +5 se em menos de 5 min · 🏁 25 por rota finalizada · 🛣️ 1 por km · 🏆 50 por meta do dia · 🎯 40 por desafio · 🏅 20 por conquista · 🔥 5 por dia da sua melhor sequência.</p>
      </section>
    </Shell>
  );
}
