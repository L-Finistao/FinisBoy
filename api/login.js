import bcrypt from 'bcryptjs';
import { sql, json, startSession, needPost, serverHint } from './_lib.js';

// Hash qualquer: gasta o mesmo tempo quando o e-mail não existe (não revela quem tem conta).
const DUMMY = bcrypt.hashSync('sem-conta', 10);

export default async function handler(req, res) {
  if (!needPost(req, res)) return;
  const { email, password } = req.body || {};
  const mail = String(email || '').trim().toLowerCase();
  try {
    const [u] = await sql`select id, email, name, password_hash from users where lower(email) = ${mail}`;
    const ok = await bcrypt.compare(String(password || ''), u ? u.password_hash : DUMMY);
    if (!u || !ok) return json(res, 401, { error: 'E-mail ou senha incorretos.' });
    await startSession(res, u.id);
    json(res, 200, { user: { id: u.id, email: u.email, name: u.name } });
  } catch (e) {
    console.error(e);
    json(res, 500, { error: 'Não foi possível entrar. ' + serverHint(e) });
  }
}
