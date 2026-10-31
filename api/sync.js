import { sql, json, userId } from './_lib.js';

const STORES = new Set(['stops', 'deliveries', 'expenses', 'routes', 'tracks', 'kv']);
const PAGE = 60;

// GET  /api/sync?since=<seq>  -> o que mudou no servidor para ESTE usuário
// POST /api/sync { changes: [{ store, id, data, deleted, ts }] } -> grava as mudanças do aparelho (a mais recente vence)
export default async function handler(req, res) {
  const uid = await userId(req);
  if (!uid) return json(res, 401, { error: 'Não autenticado.' });

  if (req.method === 'GET') {
    const since = Number(req.query.since) || 0;
    const rows = await sql`select store, doc_id as id, data, deleted, seq from docs
      where user_id = ${uid} and seq > ${since} order by seq limit ${PAGE}`;
    return json(res, 200, { changes: rows, next: rows.length ? Number(rows[rows.length - 1].seq) : since, more: rows.length === PAGE });
  }

  if (req.method !== 'POST') return json(res, 405, { error: 'Método não permitido.' });
  const list = Array.isArray(req.body && req.body.changes) ? req.body.changes : null;
  if (!list) return json(res, 400, { error: 'Pedido inválido.' });

  const byKey = new Map();                                   // sem repetidos no mesmo lote
  for (const c of list) {
    if (!c || !STORES.has(c.store) || typeof c.id !== 'string' || !c.id || c.id.length > 200) continue;
    byKey.set(c.store + '|' + c.id, {
      store: c.store, id: c.id, data: c.deleted ? null : (c.data ?? null), deleted: !!c.deleted, ts: Math.floor(Number(c.ts)) || 0,
    });
  }
  if (!byKey.size) return json(res, 200, { ok: true, saved: 0 });

  await sql`insert into docs (user_id, store, doc_id, data, deleted, client_ts, seq)
    select ${uid}::uuid, x.store, x.id, x.data, x.deleted, x.ts, nextval('docs_seq')
    from jsonb_to_recordset(${JSON.stringify([...byKey.values()])}::jsonb) as x(store text, id text, data jsonb, deleted boolean, ts bigint)
    on conflict (user_id, store, doc_id) do update
      set data = excluded.data, deleted = excluded.deleted, client_ts = excluded.client_ts, seq = excluded.seq
      where docs.client_ts <= excluded.client_ts`;
  json(res, 200, { ok: true, saved: byKey.size });
}
