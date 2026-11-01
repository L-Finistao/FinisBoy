import { neon } from '@neondatabase/serverless';
import { getTokenResponse } from '@vercel/connect';

/* Banco: Neon. Com DATABASE_URL usa ela; sem, pede uma credencial ao Vercel Connect, descobre a conexão do projeto
   pela API do Neon e guarda em memória até a credencial vencer. */
const NEON_CONNECTOR = process.env.NEON_CONNECTOR || 'neon/fiinsboy';
const NEON_API = 'https://console.neon.tech/api/v2';

type Runner = ReturnType<typeof neon>;
let cached: { run: Runner; exp: number } | null = null;

async function neonGet(token: string, path: string) {
  const r = await fetch(NEON_API + path, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
  if (!r.ok) throw new Error(`Neon API ${path} → ${r.status}`);
  return r.json();
}

async function resolveConnection(): Promise<{ uri: string; exp: number }> {
  if (process.env.DATABASE_URL) return { uri: process.env.DATABASE_URL, exp: Infinity };
  const tk: any = await getTokenResponse(NEON_CONNECTOR, { subject: { type: 'app' } });
  const exp = (tk.expiresAt || Date.now() + 5 * 60 * 1000) - 60 * 1000;
  const fromMeta = Object.values(tk.metadata || {}).find(v => typeof v === 'string' && /^postgres(ql)?:\/\//.test(v as string));
  if (fromMeta) return { uri: fromMeta as string, exp };

  const pid = process.env.NEON_PROJECT_ID || tk.metadata?.projectId || tk.metadata?.project_id
    || (await neonGet(tk.token, '/projects?limit=10')).projects?.[0]?.id;
  if (!pid) throw new Error('Nenhum projeto Neon encontrado para este conector.');
  const branches = (await neonGet(tk.token, `/projects/${pid}/branches`)).branches || [];
  const branch = branches.find((b: any) => b.default || b.primary) || branches[0];
  const dbs = (await neonGet(tk.token, `/projects/${pid}/branches/${branch.id}/databases`)).databases || [];
  const db = dbs.find((d: any) => d.name !== 'postgres') || dbs[0];
  const { uri } = await neonGet(tk.token,
    `/projects/${pid}/connection_uri?branch_id=${branch.id}&database_name=${encodeURIComponent(db.name)}&role_name=${encodeURIComponent(db.owner_name)}&pooled=true`);
  return { uri, exp };
}

async function conn(): Promise<Runner> {
  if (!cached || Date.now() > cached.exp) {
    const { uri, exp } = await resolveConnection();
    cached = { run: neon(uri), exp };
  }
  return cached.run;
}

// Usado como antes: await sql`select ...`
export const sql = async (strings: TemplateStringsArray, ...values: unknown[]): Promise<any[]> =>
  (await conn())(strings, ...values) as unknown as Promise<any[]>;

// Diz ao usuário (sem vazar segredos) o que provavelmente está errado no servidor; o detalhe completo vai para os logs.
export function serverHint(e: any): string {
  const m = String((e && e.message) || e);
  if (e && e.code === '42P01') return 'O banco ainda não tem as tabelas: rode o db/schema.sql no Neon.';
  if (/JWT_SECRET|zero-length key|Key must be/i.test(m) || !process.env.JWT_SECRET) return 'Falta a variável JWT_SECRET na Vercel (Settings → Environment Variables) e um novo deploy.';
  if (/connector|connect|token|Neon API|projeto Neon|ENOTFOUND|ECONN|fetch failed|password authentication/i.test(m)) return 'Não consegui conectar ao banco Neon (' + m.slice(0, 120) + ').';
  return 'Erro no servidor: ' + m.slice(0, 120);
}
