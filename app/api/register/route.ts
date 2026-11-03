import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { sql, serverHint } from '../../../lib/db';
import { json, sessionCookie } from '../../../lib/session';

const Body = z.object({
  email: z.string().trim().toLowerCase().max(200).regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/, 'E-mail inválido.'),
  password: z.string().min(8, 'A senha precisa ter pelo menos 8 caracteres.').max(200),
  name: z.string().trim().max(80).nullish().transform(v => v ?? ''),
  code: z.string().nullish().transform(v => v ?? undefined),
});

export async function POST(req: Request) {
  const p = Body.safeParse(await req.json().catch(() => null));
  if (!p.success) return json({ error: p.error.issues[0]?.message || 'Dados inválidos.' }, 400);
  const { email, password, name, code } = p.data;
  if (process.env.SIGNUP_CODE && code !== process.env.SIGNUP_CODE) return json({ error: 'Código de convite inválido.', needCode: true }, 403);
  const hash = await bcrypt.hash(password, 10);
  try {
    const [u] = await sql`insert into users (email, name, password_hash) values (${email}, ${name}, ${hash}) returning id, email, name`;
    return json({ user: u }, 201, { 'Set-Cookie': await sessionCookie(u.id) });
  } catch (e: any) {
    if (e.code === '23505') return json({ error: 'Este e-mail já tem conta. Use Entrar.' }, 409);
    console.error(e);
    return json({ error: 'Não foi possível criar a conta. ' + serverHint(e) }, 500);
  }
}
