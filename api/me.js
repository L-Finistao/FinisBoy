import { sql, json, userId, endSession } from './_lib.js';

export default async function handler(req, res) {
  const id = await userId(req);
  if (!id) return json(res, 401, { error: 'Não autenticado.' });
  const [u] = await sql`select id, email, name from users where id = ${id}`;
  if (!u) { endSession(res); return json(res, 401, { error: 'Conta não encontrada.' }); }
  json(res, 200, { user: u });
}
