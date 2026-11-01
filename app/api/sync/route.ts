import { sql } from '../../../lib/db';
import { json, userId } from '../../../lib/session';

export const dynamic = 'force-dynamic';

const STORES = new Set(['stops', 'deliveries', 'expenses', 'routes', 'tracks', 'kv']);
const PAGE = 60;

// GET  /api/sync?since=<seq>  -> o que mudou no servidor para ESTE usuário
export async function GET(req: Request) {
  const uid = await userId(req);
  if (!uid) return json({ error: 'Não autenticado.' }, 401);
  const since = Number(new URL(req.url).searchParams.get('since')) || 0;
  const rows = await sql`select store, doc_id as id, data, deleted, seq from docs
    where user_id = ${uid} and seq > ${since} order by seq limit ${PAGE}`;
  return json({ changes: rows, next: rows.length ? Number(rows[rows.length - 1].seq) : since, more: rows.length === PAGE });
}

// POST /api/sync { changes: [{ store, id, data, deleted, ts }] } -> grava as mudanças do aparelho (a mais recente vence)
export async function POST(req: Request) {
  const uid = await userId(req);
  if (!uid) return json({ error: 'Não autenticado.' }, 401);
  const body = await req.json().catch(() => null);
  const list: any[] | null = Array.isArray(body?.changes) ? body.changes : null;
  if (!list) return json({ error: 'Pedido inválido.' }, 400);

  const byKey = new Map<string, { store: string; id: string; data: unknown; deleted: boolean; ts: number }>();   // sem repetidos no lote
  for (const c of list) {
    if (!c || !STORES.has(c.store) || typeof c.id !== 'string' || !c.id || c.id.length > 200) continue;
    byKey.set(c.store + '|' + c.id, { store: c.store, id: c.id, data: c.deleted ? null : (c.data ?? null), deleted: !!c.deleted, ts: Math.floor(Number(c.ts)) || 0 });
  }
  if (!byKey.size) return json({ ok: true, saved: 0 });

  await sql`insert into docs (user_id, store, doc_id, data, deleted, client_ts, seq)
    select ${uid}::uuid, x.store, x.id, x.data, x.deleted, x.ts, nextval('docs_seq')
    from jsonb_to_recordset(${JSON.stringify([...byKey.values()])}::jsonb) as x(store text, id text, data jsonb, deleted boolean, ts bigint)
    on conflict (user_id, store, doc_id) do update
      set data = excluded.data, deleted = excluded.deleted, client_ts = excluded.client_ts, seq = excluded.seq
      where docs.client_ts <= excluded.client_ts`;
  return json({ ok: true, saved: byKey.size });
}
