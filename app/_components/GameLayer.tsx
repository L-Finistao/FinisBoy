'use client';
import { useEffect, useRef, useState } from 'react';
import { useSync } from '../../lib/client/use-sync';
import { saveCfg, useGame } from '../../lib/client/game';
import { ACH_XP, BOND_NAMES, CHALLENGE_XP, GOAL_XP, THEMES, bondInfo, companionOf, titleOf } from '../../lib/core/game';

type Party = { id: string; icon: string; kicker: string; title: string; text: string };

// Tema escolhido, "+XP" a cada ponto ganho e comemoração (nível, conquista, meta, desafio) com confete.
export default function GameLayer() {
  const sync = useSync();
  const { cfg, ready, game } = useGame();
  const prevXp = useRef<number | null>(null);
  const [toasts, setToasts] = useState<{ id: number; text: string }[]>([]);
  const [queue, setQueue] = useState<Party[]>([]);

  // tema
  useEffect(() => {
    const t = THEMES.find(x => x.id === cfg.theme) || THEMES[0], s = document.documentElement.style;
    if (t.id === 'turbo') { s.removeProperty('--brand'); s.removeProperty('--brand-600'); }   // padrão: cores do CSS (claro/escuro)
    else { s.setProperty('--brand', t.brand); s.setProperty('--brand-600', t.b600); }           // soft/ink são derivados no CSS
  }, [cfg.theme]);

  // +XP
  const xp = game?.xp ?? null;
  useEffect(() => {
    if (xp == null || !sync.user) return;
    if (prevXp.current != null && xp > prevXp.current) {
      const id = Date.now(), d = xp - prevXp.current;
      setToasts(t => [...t, { id, text: `+${d} XP` }]);
      setTimeout(() => setToasts(t => t.filter(x => x.id !== id)), 2200);
    }
    prevXp.current = xp;
  }, [xp, sync.user]);

  // registra meta do dia / desafio e comemora o que é novo
  useEffect(() => {
    if (!ready || !game || !sync.user) return;
    const patch: Partial<typeof cfg> = {}, party: Party[] = [];
    if (game.goalHit && !cfg.hitDays.includes(game.today)) {
      patch.hitDays = [...cfg.hitDays, game.today];
      party.push({ id: 'goal' + game.today, icon: '🏆', kicker: 'Meta do dia batida!', title: 'Você arrasou hoje', text: `+${GOAL_XP} XP de bônus` });
    }
    if (game.challenge.done && cfg.challengeDone[game.today] !== game.challenge.id) {
      patch.challengeDone = { ...cfg.challengeDone, [game.today]: game.challenge.id };
      party.push({ id: 'ch' + game.today, icon: game.challenge.icon, kicker: 'Desafio do dia concluído', title: game.challenge.name, text: `+${CHALLENGE_XP} XP` });
    }
    // laço com o companheiro ativo: cada entrega nova conta como estrada compartilhada
    const total = game.stats.deliveries;
    if (cfg.bondMark == null) patch.bondMark = total;
    else if (total !== cfg.bondMark) {
      patch.bondMark = total;
      if (total > cfg.bondMark) {
        const before = cfg.bonds[cfg.companion] || 0, now = before + total - cfg.bondMark, c = companionOf(cfg.companion);
        patch.bonds = { ...cfg.bonds, [cfg.companion]: now };
        const lv = bondInfo(now).level;
        if (lv > bondInfo(before).level) party.push({ id: `bd${c.id}${lv}`, icon: c.e, kicker: 'Amizade subiu de nível', title: `Você e ${c.name} agora são ${BOND_NAMES[lv - 1]}`, text: `${now} entregas juntos` });
      }
    }
    if (!cfg.seen) patch.seen = { level: game.level, ach: game.unlockedIds };      // primeira vez: não comemora o que já existia
    else {
      const newAch = game.ach.filter(a => a.unlocked && !cfg.seen!.ach.includes(a.id));
      if (game.level > cfg.seen.level) party.push({ id: 'lv' + game.level, icon: '⭐', kicker: `Nível ${game.level}`, title: `Você agora é ${titleOf(game.level)}`, text: 'Veja o que foi desbloqueado em Perfil: novos avatares, acessórios, molduras e companheiros.' });
      for (const a of newAch) party.push({ id: 'ac' + a.id, icon: a.icon, kicker: 'Conquista desbloqueada', title: a.name, text: `${a.desc} · +${ACH_XP} XP` });
      if (game.level !== cfg.seen.level || newAch.length) patch.seen = { level: Math.max(game.level, cfg.seen.level), ach: [...new Set([...cfg.seen.ach, ...game.unlockedIds])] };
    }
    if (party.length) setQueue(q => [...q, ...party]);
    if (Object.keys(patch).length) void saveCfg(patch);
  }, [ready, game, cfg, sync.user]);

  const cur = queue[0];
  return (
    <>
      <div className="toasts" aria-live="polite">{toasts.map(t => <div key={t.id} className="xp">{t.text}</div>)}</div>
      {cur && (
        <div className="overlay party" onClick={() => setQueue(q => q.slice(1))}>
          <div className="confetti" aria-hidden="true">
            {Array.from({ length: 40 }, (_, i) => <i key={i} style={{ left: `${(i * 37) % 100}%`, background: ['#f0d522', '#a1d835', '#54c5f1', '#e84b31', '#92b6dd'][i % 5], animationDelay: `${(i % 10) * 0.12}s`, animationDuration: `${2.2 + (i % 5) * 0.4}s` }} />)}
          </div>
          <div className="partycard" onClick={e => e.stopPropagation()}>
            <div className="bigicon">{cur.icon}</div>
            <div className="eyebrow">{cur.kicker}</div>
            <div className="title">{cur.title}</div>
            <p className="muted">{cur.text}</p>
            <button className="primary full" onClick={() => setQueue(q => q.slice(1))}>{queue.length > 1 ? `Continuar (${queue.length - 1} mais)` : 'Continuar'}</button>
          </div>
        </div>
      )}
    </>
  );
}
