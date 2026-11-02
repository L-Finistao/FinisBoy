'use client';
import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { local } from './local-db';
import { useApp } from './use-app';
import { earningsCtx, session } from './store';
import { computeGame, DEFAULT_CFG, type GameCfg } from '../core/game';

/* Configuração do jogador (apelido, avatar, tema, metas, o que já foi comemorado). O resto (XP, nível, conquistas) é calculado. */

let cfg: GameCfg = DEFAULT_CFG, ready = false;
const subs = new Set<() => void>();
const emit = () => subs.forEach(f => f());
const subscribe = (f: () => void) => { subs.add(f); return () => { subs.delete(f); }; };

async function load() {
  if (ready) return;
  const c = await local.kvGet<Partial<GameCfg>>('game');
  cfg = { ...DEFAULT_CFG, ...c, goals: { ...DEFAULT_CFG.goals, ...c?.goals }, hitDays: c?.hitDays || [], challengeDone: c?.challengeDone || {} };
  ready = true; emit();
}

export async function saveCfg(patch: Partial<GameCfg>) {
  cfg = { ...cfg, ...patch };
  emit();
  await local.kvSet('game', cfg);                       // vai junto no backup
}

export function useGame() {
  const app = useApp();
  useEffect(() => { void load(); }, []);
  const c = useSyncExternalStore(subscribe, () => cfg, () => DEFAULT_CFG);
  const isReady = useSyncExternalStore(subscribe, () => ready, () => false);
  const running = app.routes.find(r => r.status === 'andamento') || null;
  const game = useMemo(
    () => (app.ready && isReady ? computeGame(earningsCtx(), app.stops, running, c, app.target) : null),
    [app.ready, isReady, app.stops, app.routes, app.deliveries, app.expenses, app.profiles, app.target, c], // eslint-disable-line react-hooks/exhaustive-deps
  );
  void session;
  return { cfg: c, ready: isReady && app.ready, game };
}
