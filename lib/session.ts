import { SignJWT, jwtVerify } from 'jose';
import { NextResponse } from 'next/server';

const COOKIE = 'fb_session';
const DAYS = 30;
const key = () => new TextEncoder().encode(process.env.JWT_SECRET);
const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';   // localhost (http) não aceita Secure

export const json = (body: unknown, status = 200, headers?: Record<string, string>) => NextResponse.json(body, { status, headers });

export async function sessionCookie(userId: string): Promise<string> {
  const token = await new SignJWT({}).setProtectedHeader({ alg: 'HS256' }).setSubject(userId).setIssuedAt().setExpirationTime(`${DAYS}d`).sign(key());
  return `${COOKIE}=${token}; Path=/; HttpOnly${secure}; SameSite=Lax; Max-Age=${DAYS * 86400}`;
}

export const clearCookie = () => `${COOKIE}=; Path=/; HttpOnly${secure}; SameSite=Lax; Max-Age=0`;

// Id do usuário logado (ou null). Vem sempre do cookie assinado, nunca do que o cliente envia.
export async function userId(req: Request): Promise<string | null> {
  const m = /(?:^|;\s*)fb_session=([^;]+)/.exec(req.headers.get('cookie') || '');
  if (!m) return null;
  try { return (await jwtVerify(m[1], key())).payload.sub || null; } catch { return null; }
}
