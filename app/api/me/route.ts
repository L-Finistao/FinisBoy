import { sql } from '../../../lib/db';
import { json, userId, clearCookie } from '../../../lib/session';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const id = await userId(req);
  if (!id) return json({ error: 'Não autenticado.' }, 401);
  const [u] = await sql`select id, email, name from users where id = ${id}`;
  if (!u) return json({ error: 'Conta não encontrada.' }, 401, { 'Set-Cookie': clearCookie() });
  return json({ user: u });
}
