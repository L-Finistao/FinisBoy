import bcrypt from 'bcryptjs';
import { sql, json, startSession, needPost } from './_lib.js';

export default async function handler(req, res) {
  if (!needPost(req, res)) return;
  const { email, password, name, code } = req.body || {};
  const mail = String(email || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mail) || mail.length > 200) return json(res, 400, { error: 'E-mail inválido.' });
  if (typeof password !== 'string' || password.length < 8 || password.length > 200) return json(res, 400, { error: 'A senha precisa ter pelo menos 8 caracteres.' });
  if (process.env.SIGNUP_CODE && code !== process.env.SIGNUP_CODE) return json(res, 403, { error: 'Código de convite inválido.', needCode: true });
  const hash = await bcrypt.hash(password, 10);
  try {
    const [u] = await sql`insert into users (email, name, password_hash)
      values (${mail}, ${String(name || '').trim().slice(0, 80)}, ${hash}) returning id, email, name`;
    await startSession(res, u.id);
    json(res, 201, { user: u });
  } catch (e) {
    if (e.code === '23505') return json(res, 409, { error: 'Este e-mail já tem conta. Use Entrar.' });
    console.error(e);
    json(res, 500, { error: 'Não foi possível criar a conta.' });
  }
}
