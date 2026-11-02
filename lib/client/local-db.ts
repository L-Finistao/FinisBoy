import { SYNC_STORES } from '../shared';

// Banco local (IndexedDB). Mesmo nome e estrutura do app antigo ('motoboy' v4): os dados já salvos no aparelho continuam valendo.
const NAME = 'motoboy', VERSION = 4;
type DocStore = (typeof SYNC_STORES)[number];
type Store = DocStore | 'kv';
type Listener = (store: Store, id: string, deleted: boolean) => void;

let dbp: Promise<IDBDatabase> | null = null;
let listener: Listener | null = null;

export const onLocalChange = (fn: Listener | null) => { listener = fn; };

function open(): Promise<IDBDatabase> {
  return (dbp ??= new Promise((res, rej) => {
    const r = indexedDB.open(NAME, VERSION);
    r.onupgradeneeded = () => {
      const d = r.result;
      for (const n of SYNC_STORES) if (!d.objectStoreNames.contains(n)) d.createObjectStore(n, { keyPath: 'id' });
      if (!d.objectStoreNames.contains('kv')) d.createObjectStore('kv');
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => { dbp = null; rej(r.error); };
  }));
}

const wrap = <T,>(r: IDBRequest<T>) => new Promise<T>((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
async function store(name: Store, write = false) {
  return (await open()).transaction(name, write ? 'readwrite' : 'readonly').objectStore(name);
}

// "silent": grava sem entrar na fila de backup (usado ao restaurar da nuvem e nos dados internos do backup).
export const local = {
  async all<T = any>(name: DocStore): Promise<T[]> { return wrap((await store(name)).getAll()); },
  async get<T = any>(name: DocStore, id: string): Promise<T | undefined> { return wrap((await store(name)).get(id)); },
  async put(name: DocStore, doc: { id: string }, silent = false) {
    await wrap((await store(name, true)).put(doc));
    if (!silent) listener?.(name, doc.id, false);
  },
  async remove(name: DocStore, id: string, silent = false) {
    await wrap((await store(name, true)).delete(id));
    if (!silent) listener?.(name, id, true);
  },
  async kvGet<T = any>(key: string): Promise<T | undefined> { return wrap((await store('kv')).get(key)); },
  async kvSet(key: string, value: unknown, silent = false) {
    await wrap((await store('kv', true)).put(value, key));
    if (!silent) listener?.('kv', key, false);
  },
  async kvDel(key: string, silent = false) {
    await wrap((await store('kv', true)).delete(key));
    if (!silent) listener?.('kv', key, true);
  },
};
