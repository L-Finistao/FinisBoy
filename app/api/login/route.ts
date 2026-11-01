import bcrypt from 'bcryptjs';
import { sql, serverHint } from '../../../lib/db';
import { json, sessionCookie } from '../../../lib/session';

// Hash qualquer: gasta o mesmo tempo quando o e-mail não existe (não revela quem tem conta).
const DUMMY = bcrypt.hashSync('sem-conta', 10);

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const mail = String(body?.email || '').trim().toLowerCase();
  try {
    const [u] = await sql`select id, email, name, password_hash from users where lower(email) = ${mail}`;
    const ok = await bcrypt.compare(String(body?.password || ''), u ? u.password_hash : DUMMY);
    if (!u || !ok) return json({ error: 'E-mail ou senha incorretos.' }, 401);
    return json({ user: { id: u.id, email: u.email, name: u.name } }, 200, { 'Set-Cookie': await sessionCookie(u.id) });
  } catch (e) {
    console.error(e);
    return json({ error: 'Não foi possível entrar. ' + serverHint(e) }, 500);
  }
}
