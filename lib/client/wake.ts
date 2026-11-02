'use client';
import { useEffect, useState } from 'react';
import { local } from './local-db';

// Mantém a tela acesa durante a rota (opção "keepOn"). O navegador solta o bloqueio ao ir para segundo plano: pede de novo ao voltar.
export function useKeepOn() {
  const [on, setOn] = useState(true);
  useEffect(() => { void local.kvGet<boolean>('keepOn').then(v => setOn(v == null ? true : !!v)); }, []);
  return [on, (v: boolean) => { setOn(v); void local.kvSet('keepOn', v); }] as const;
}

export function useWakeLock(active: boolean) {
  useEffect(() => {
    if (!active || !('wakeLock' in navigator)) return;
    let lock: WakeLockSentinel | null = null, dead = false;
    const ask = async () => {
      if (dead || document.hidden || (lock && !lock.released)) return;
      try { lock = await navigator.wakeLock.request('screen'); } catch { /* sem permissão ou bateria baixa */ }
    };
    void ask();
    document.addEventListener('visibilitychange', ask);
    document.addEventListener('pointerdown', ask);
    return () => { dead = true; document.removeEventListener('visibilitychange', ask); document.removeEventListener('pointerdown', ask); void lock?.release().catch(() => {}); };
  }, [active]);
}
