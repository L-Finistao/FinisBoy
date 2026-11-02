'use client';
import Link from 'next/link';
import { Icon } from './Icon';
import { money } from '../../lib/core/format';
import type { Game, GameCfg } from '../../lib/core/game';

export function Ring({ pct, size = 64, children }: { pct: number; size?: number; children?: React.ReactNode }) {
  const r = (size - 10) / 2, c = 2 * Math.PI * r, p = Math.max(0, Math.min(1, pct));
  return (
    <div style={{ position: 'relative', width: size, height: size }}>
      <svg className="ring-svg" width={size} height={size}>
        <circle className="bg" cx={size / 2} cy={size / 2} r={r} fill="none" strokeWidth="8" />
        <circle className="fg" cx={size / 2} cy={size / 2} r={r} fill="none" strokeWidth="8" strokeDasharray={c} strokeDashoffset={c * (1 - p)} />
      </svg>
      <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', fontWeight: 800, fontSize: size * 0.22 }}>{children ?? `${Math.round(p * 100)}%`}</div>
    </div>
  );
}

// Metas do dia e da semana: só aparecem as que têm valor definido.
export function GoalRings({ game, cfg }: { game: Game; cfg: GameCfg }) {
  const g = cfg.goals, s = game.stats;
  const items = [
    g.dayDeliveries > 0 && { l: 'Entregas hoje', v: `${s.today.n}/${g.dayDeliveries}`, p: s.today.n / g.dayDeliveries },
    g.dayGain > 0 && { l: 'Ganho hoje', v: `${money(s.today.gain)}`, p: s.today.gain / g.dayGain },
    g.weekDeliveries > 0 && { l: 'Entregas na semana', v: `${s.week.n}/${g.weekDeliveries}`, p: s.week.n / g.weekDeliveries },
    g.weekGain > 0 && { l: 'Ganho na semana', v: money(s.week.gain), p: s.week.gain / g.weekGain },
  ].filter(Boolean) as { l: string; v: string; p: number }[];
  if (!items.length) return <p className="muted">Defina suas metas em <Link href="/perfil" style={{ color: 'var(--brand)' }}>Perfil</Link>.</p>;
  return <div className="rings">{items.map(i => <div key={i.l} className="ringbox"><Ring pct={i.p} /><b>{i.v}</b>{i.l}</div>)}</div>;
}

export function XpBar({ game }: { game: Game }) {
  return (
    <div>
      <div className="xpbar"><i style={{ width: `${game.pct * 100}%` }} /></div>
      <div className="rowb muted" style={{ marginTop: 4 }}><span>{game.into} / {game.need} XP</span><span>próximo: nível {game.level + 1}</span></div>
    </div>
  );
}

// Cartão do jogador na tela de Rotas.
export function GameCard({ game, cfg, name }: { game: Game; cfg: GameCfg; name: string }) {
  const ch = game.challenge;
  return (
    <section className="panel gcard">
      <Link href="/perfil" className="rowb" style={{ textDecoration: 'none', gap: 12 }}>
        <span className="avatar">{cfg.avatar}</span>
        <span style={{ flex: 1, minWidth: 0 }}>
          <b style={{ display: 'block' }}>{cfg.nick || name}</b>
          <span className="muted">Nível {game.level} · {game.title}</span>
        </span>
        <span className="streak" title="Dias seguidos com entregas"><Icon n="flame" />{game.stats.curStreak}</span>
      </Link>
      <XpBar game={game} />
      <GoalRings game={game} cfg={cfg} />
      <div className={`chal ${ch.done ? 'done' : ''}`}>
        <span className="ic">{ch.done ? '✅' : ch.icon}</span>
        <span style={{ flex: 1 }}><b>Desafio: {ch.name}</b><div className="muted">{ch.desc} · {Math.min(Math.floor(ch.v), ch.goal)}/{ch.goal}</div></span>
        <b className="ok">+40</b>
      </div>
    </section>
  );
}
