export interface ApiResult<T = any> { ok: boolean; status: number; data: T }

export async function api<T = any>(path: string, method = 'GET', body?: unknown): Promise<ApiResult<T>> {
  // Sem limite de tempo, uma rede ruim deixava o app em "Carregando…" para sempre.
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 12_000);
  let r: Response;
  try {
    r = await fetch('/api' + path, {
      method, credentials: 'same-origin', signal: ctl.signal,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
  } finally { clearTimeout(timer); }
  let data: any = null;
  try { data = await r.json(); } catch { /* resposta sem JSON */ }
  return { ok: r.ok, status: r.status, data: data ?? {} };
}
