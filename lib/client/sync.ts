import { api } from './api';
import { local, onLocalChange } from './local-db';
import { SYNC_STORES, SYNC_KV, DEFAULT_BACKUP_MINUTES, isBackupMinutes, type BackupMinutes, type SyncChange, type User } from '../shared';

/* Semi-offline: o app lê e grava SEMPRE no aparelho (IndexedDB). A conta (Neon) recebe só o backup,
   no intervalo escolhido pelo usuário (5, 10, 15, 60 ou 120 min) ou quando ele toca em "Salvar agora".
   Restaurar da nuvem é sempre manual. */

const BATCH_BYTES = 800 * 1024;
const MAX_DOC_BYTES = 3.5 * 1024 * 1024;
const TICK_MS = 15_000;                                  // de quanto em quanto tempo confere se o backup venceu

interface QItem { store: string; id: string; del: boolean; t: number }
export interface SyncState {
  user: User | null; ready: boolean; online: boolean; busy: boolean;
  pending: number; lastBackup: number; minutes: BackupMinutes; message: string;
}

const SYNC_STORE_SET = new Set<string>(SYNC_STORES);
const SYNC_KV_SET = new Set<string>(SYNC_KV);
const isAuthErr = (e: unknown) => (e as any)?.auth === true;

let state: SyncState = { user: null, ready: false, online: true, busy: false, pending: 0, lastBackup: 0, minutes: DEFAULT_BACKUP_MINUTES, message: '' };
const subs = new Set<() => void>();
let queue = new Map<string, QItem>();
let applying = false, saveTimer: ReturnType<typeof setTimeout> | undefined, tickTimer: ReturnType<typeof setInterval> | undefined;
let skipTrack: (id: string) => boolean = () => false;    // trajeto da rota em andamento só é enviado no fim

const set = (p: Partial<SyncState>) => { state = { ...state, ...p }; subs.forEach(f => f()); };
export const getState = () => state;
export const subscribe = (f: () => void) => { subs.add(f); return () => { subs.delete(f); }; };
export const setLiveTrackGuard = (fn: (id: string) => boolean) => { skipTrack = fn; };

function persistQueue() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => local.kvSet('syncq', [...queue.values()], true), 500);
}

function mark(store: string, id: string, del: boolean) {
  if (applying || !state.user) return;
  if (store === 'kv' ? !SYNC_KV_SET.has(id) : !SYNC_STORE_SET.has(store)) return;
  queue.set(store + '|' + id, { store, id, del, t: Date.now() });
  set({ pending: queue.size });
  persistQueue();
}

async function enqueueAll() {                            // dados que já estavam no aparelho antes do login
  for (const s of SYNC_STORES) for (const o of await local.all(s)) queue.set(s + '|' + o.id, { store: s, id: o.id, del: false, t: Date.now() });
  for (const k of SYNC_KV) if ((await local.kvGet(k)) !== undefined) queue.set('kv|' + k, { store: 'kv', id: k, del: false, t: Date.now() });
  await local.kvSet('syncq', [...queue.values()], true);
}

async function push() {
  const out: { c: QItem; ch: SyncChange }[] = [];
  for (const c of queue.values()) {
    if (c.store === 'tracks' && skipTrack(c.id)) continue;
    let data: unknown = null;
    if (!c.del) {
      data = c.store === 'kv' ? await local.kvGet(c.id) : await local.get(c.store as (typeof SYNC_STORES)[number], c.id);
      if (data === undefined) { queue.delete(c.store + '|' + c.id); continue; }   // já não existe: nada a enviar
    }
    out.push({ c, ch: { store: c.store, id: c.id, data, deleted: c.del, ts: c.t } });
  }
  let batch: typeof out = [], size = 0;
  const flush = async () => {
    if (!batch.length) return;
    const r = await api('/sync', 'POST', { changes: batch.map(x => x.ch) });
    if (r.status === 401) throw Object.assign(new Error('auth'), { auth: true });
    if (!r.ok) throw new Error(r.data.error || 'erro ' + r.status);
    for (const x of batch) if (queue.get(x.c.store + '|' + x.c.id) === x.c) queue.delete(x.c.store + '|' + x.c.id);   // mudou no meio: fica na fila
    batch = []; size = 0;
  };
  for (const x of out) {
    const n = JSON.stringify(x.ch).length;
    if (n > MAX_DOC_BYTES) { queue.delete(x.c.store + '|' + x.c.id); console.warn('Registro grande demais para o backup:', x.c.store, x.c.id); continue; }
    if (size + n > BATCH_BYTES) await flush();
    batch.push(x); size += n;
  }
  await flush();
  await local.kvSet('syncq', [...queue.values()], true);
}

async function pull(force: boolean) {                    // force: restauração manual, o que veio da nuvem vale mais
  let since = force ? 0 : (await local.kvGet<number>('syncSince')) || 0, applied = 0;
  for (;;) {
    const r = await api('/sync?since=' + since);
    if (r.status === 401) throw Object.assign(new Error('auth'), { auth: true });
    if (!r.ok) throw new Error(r.data.error || 'erro ' + r.status);
    applying = true;
    try {
      for (const ch of r.data.changes as { store: string; id: string; data: any; deleted: boolean }[]) {
        if (!force && queue.has(ch.store + '|' + ch.id)) continue;           // alteração local ainda sem backup vale mais
        if (ch.store === 'kv') {
          if (!SYNC_KV_SET.has(ch.id)) continue;
          if (ch.deleted) await local.kvDel(ch.id, true); else await local.kvSet(ch.id, ch.data, true);
        } else if (SYNC_STORE_SET.has(ch.store)) {
          const s = ch.store as (typeof SYNC_STORES)[number];
          if (ch.deleted) await local.remove(s, ch.id, true); else await local.put(s, ch.data, true);
        } else continue;
        applied++;
      }
    } finally { applying = false; }
    since = r.data.next;
    await local.kvSet('syncSince', since, true);
    if (!r.data.more) break;
  }
  return applied;
}

const due = () => Date.now() - state.lastBackup >= state.minutes * 60_000;

// Salva no banco. Automático: só se o intervalo venceu e há algo novo. manual: agora.
export async function backupNow(manual = false) {
  if (!state.user || state.busy) return;
  if (!manual && (!queue.size || !due())) return;
  if (!navigator.onLine) { set({ message: 'Sem internet: o backup será feito quando a conexão voltar.' }); return; }
  set({ busy: true });
  try {
    await push();
    const t = Date.now();
    await local.kvSet('lastBackup', t, true);
    set({ lastBackup: t, pending: queue.size, message: '' });
  } catch (e) {
    if (isAuthErr(e)) set({ user: null, message: 'Sessão expirada: entre de novo.' });
    else set({ message: 'Não foi possível fazer o backup agora (' + (e as Error).message + '). Tentaremos de novo.' });
  } finally { set({ busy: false }); }
}

// Traz o backup da nuvem para o aparelho. Itens que só existem aqui são mantidos. Retorna quantos itens vieram.
export async function restoreFromCloud(): Promise<number> {
  if (!state.user || state.busy) return 0;
  if (!navigator.onLine) throw new Error('Sem internet.');
  set({ busy: true });
  try {
    const n = await pull(true);
    queue = new Map(); await local.kvSet('syncq', [], true);
    set({ pending: 0, message: '' });
    return n;
  } catch (e) {
    set({ message: 'Não foi possível restaurar (' + (e as Error).message + ').' });
    throw e;
  } finally { set({ busy: false }); }
}

// Muda o intervalo: vale na conta (todos os aparelhos) e fica uma cópia local para funcionar offline.
export async function setBackupMinutes(minutes: BackupMinutes) {
  set({ minutes });
  await local.kvSet('backupMinutes', minutes, true);
  try {
    const r = await api('/settings', 'PUT', { backupMinutes: minutes });
    if (r.ok) await local.kvDel('minutesDirty', true);
    else set({ message: r.data.error || 'Não foi possível salvar o intervalo na conta.' });
  } catch {
    set({ message: 'Sem internet: o intervalo vale neste aparelho e será salvo na conta depois.' });
    await local.kvSet('minutesDirty', true, true);
  }
}

async function syncMinutes() {
  try {
    if (await local.kvGet('minutesDirty')) {
      const r = await api('/settings', 'PUT', { backupMinutes: state.minutes });
      if (r.ok) await local.kvDel('minutesDirty', true);
      return;
    }
    const r = await api('/settings');
    if (r.ok && isBackupMinutes(r.data.backupMinutes)) { set({ minutes: r.data.backupMinutes }); await local.kvSet('backupMinutes', r.data.backupMinutes, true); }
  } catch { /* offline: fica o valor local */ }
}

async function attach(user: User) {
  // Os dados vivem no aparelho. Na primeira vez (ou ao trocar de conta) o que já existe aqui entra no próximo backup.
  state.user = user;
  const owner = await local.kvGet('dataOwner');
  let last = (await local.kvGet<number>('lastBackup')) || 0;
  queue = new Map(((await local.kvGet<QItem[]>('syncq')) || []).map(c => [c.store + '|' + c.id, c]));
  if (owner !== user.id || !(await local.kvGet('backupInit'))) {
    queue = new Map(); last = 0;
    await enqueueAll();
    await local.kvSet('dataOwner', user.id, true); await local.kvSet('backupInit', true, true); await local.kvSet('lastBackup', 0, true);
  }
  set({ lastBackup: last, pending: queue.size });
  void syncMinutes();
}

// Descobre o usuário (a conta lembrada no aparelho permite abrir sem internet).
export async function start(): Promise<void> {
  if (state.ready) return;
  onLocalChange(mark);
  let user = (await local.kvGet<User>('authUser')) ?? null;
  try {
    const r = await api('/me');
    if (r.ok) { user = r.data.user; await local.kvSet('authUser', user, true); }
    else if (r.status === 401) { user = null; await local.kvSet('authUser', null, true); }
  } catch { /* sem internet */ }

  const m = await local.kvGet('backupMinutes');
  set({ minutes: isBackupMinutes(m) ? m : DEFAULT_BACKUP_MINUTES, online: navigator.onLine });
  if (user) await attach(user);
  set({ user, ready: true });

  window.addEventListener('online', () => { set({ online: true }); void backupNow(); });
  window.addEventListener('offline', () => set({ online: false }));
  document.addEventListener('visibilitychange', () => { if (document.hidden) void backupNow(); });   // ao sair do app, salva se já venceu
  tickTimer ??= setInterval(() => { void backupNow(); }, TICK_MS);
}

export async function signedIn(user: User) {             // chamado depois de entrar/criar conta
  await local.kvSet('authUser', user, true);
  await attach(user);
  set({ user, message: '' });
}

export async function forceSignOut() {                   // os dados continuam neste aparelho
  try { await api('/logout', 'POST'); } catch { /* sem internet: o cookie expira sozinho */ }
  await local.kvSet('authUser', null, true);
  set({ user: null, pending: 0 });
}

export async function signOut() {
  await backupNow(true);                                 // backup antes de sair
  if (queue.size) throw new Error(`Há ${queue.size} alteração(ões) sem backup na conta.`);
  await forceSignOut();
}
