import { neon } from '@neondatabase/serverless';
import { SignJWT, jwtVerify } from 'jose';
import { getTokenResponse } from '@vercel/connect';

/* ---------- Banco: Neon pelo Vercel Connect ---------- */
// Sem DATABASE_URL: o app pede ao conector (Vercel Connect) uma credencial do Neon, descobre a conexão do projeto
// pela API do Neon e guarda em memória até a credencial vencer. Com DATABASE_URL definida, ela tem prioridade.
const NEON_CONNECTOR = process.env.NEON_CONNECTOR || 'neon/fiinsboy';
const NEON_API = 'https://console.neon.tech/api/v2';
let cached = null;                                          // { run, exp }

async function neonGet(token, path) {
  const r = await fetch(NEON_API + path, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
  if (!r.ok) throw new Error(`Neon API ${path} → ${r.status}`);
  return r.json();
}

async function resolveConnection() {
  if (process.env.DATABASE_URL) return { uri: process.env.DATABASE_URL, exp: Infinity };
  const tk = await getTokenResponse(NEON_CONNECTOR, { subject: { type: 'app' } });
  const exp = (tk.expiresAt || Date.now() + 5 * 60 * 1000) - 60 * 1000;
  const fromMeta = Object.values(tk.metadata || {}).find(v => typeof v === 'string' && /^postgres(ql)?:\/\//.test(v));
  if (fromMeta) return { uri: fromMeta, exp };               // se o conector já devolver a string de conexão

  const pid = process.env.NEON_PROJECT_ID || tk.metadata?.projectId || tk.metadata?.project_id
    || (await neonGet(tk.token, '/projects?limit=10')).projects?.[0]?.id;
  if (!pid) throw new Error('Nenhum projeto Neon encontrado para este conector.');
  const branches = (await neonGet(tk.token, `/projects/${pid}/branches`)).branches || [];
  const branch = branches.find(b => b.default || b.primary) || branches[0];
  const dbs = (await neonGet(tk.token, `/projects/${pid}/branches/${branch.id}/databases`)).databases || [];
  const db = dbs.find(d => d.name !== 'postgres') || dbs[0];
  const { uri } = await neonGet(tk.token,
    `/projects/${pid}/connection_uri?branch_id=${branch.id}&database_name=${encodeURIComponent(db.name)}&role_name=${encodeURIComponent(db.owner_name)}&pooled=true`);
  return { uri, exp };
}

async function db() {
  if (!cached || Date.now() > cached.exp) {
    const { uri, exp } = await resolveConnection();
    cached = { run: neon(uri), exp };
  }
  return cached.run;
}

// Usado como antes: await sql`select ...`
export const sql = async (strings, ...values) => (await db())(strings, ...values);

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
