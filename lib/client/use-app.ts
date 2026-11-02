'use client';
import { useEffect, useSyncExternalStore } from 'react';
import { DEFAULT_PAY } from '../core/earnings';
import { getApp, subscribeApp, init, type AppState } from './store';

const SERVER: AppState = { ready: false, routes: [], stops: [], deliveries: [], curId: null, me: null, city: '', pay: DEFAULT_PAY, target: 15, profiles: [], expenses: [], lastProfile: null, busy: false, status: '', picking: null };

export function useApp(): AppState {
  useEffect(() => { void init(); }, []);
  return useSyncExternalStore(subscribeApp, getApp, () => SERVER);
}
