import { neon } from '@neondatabase/serverless';
import { SignJWT, jwtVerify } from 'jose';

export const sql = neon(process.env.DATABASE_URL);

const COOKIE = 'fb_session';
const DAYS = 30;
const key = () => new TextEncoder().encode(process.env.JWT_SECRET);

export const json = (res, code, body) => res.status(code).json(body);

export async function startSession(res, userId) {
  const token = await new SignJWT({})
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime(`${DAYS}d`)
    .sign(key());
  res.setHeader('Set-Cookie', `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${DAYS * 86400}`);
}

export function endSession(res) {
  res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`);
}

// Devolve o id do usuário logado (ou null). O id vem sempre do cookie assinado, nunca do que o cliente envia.
export async function userId(req) {
  const m = /(?:^|;\s*)fb_session=([^;]+)/.exec(req.headers.cookie || '');
  if (!m) return null;
  try {
    const { payload } = await jwtVerify(m[1], key());
    return payload.sub || null;
  } catch { return null; }
}

export function needPost(req, res) {
  if (req.method === 'POST') return true;
  res.setHeader('Allow', 'POST');
  json(res, 405, { error: 'Método não permitido.' });
  return false;
}
