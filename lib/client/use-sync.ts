'use client';
import { useEffect, useSyncExternalStore } from 'react';
import { useRouter } from 'next/navigation';
import { getState, subscribe, start, type SyncState } from './sync';

const SERVER: SyncState = { user: null, ready: false, online: true, busy: false, pending: 0, lastBackup: 0, minutes: 60, message: '' };

// Estado do backup/conta em qualquer tela. Inicia o motor de sincronização na primeira vez.
export function useSync(): SyncState {
  useEffect(() => { void start(); }, []);
  return useSyncExternalStore(subscribe, getState, () => SERVER);
}

// Telas que exigem login: volta para /entrar quando não há conta.
export function useRequireUser() {
  const s = useSync();
  const router = useRouter();
  useEffect(() => { if (s.ready && !s.user) router.replace('/entrar'); }, [s.ready, s.user, router]);
  return s;
}
