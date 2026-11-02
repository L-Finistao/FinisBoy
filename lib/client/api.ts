export interface ApiResult<T = any> { ok: boolean; status: number; data: T }

export async function api<T = any>(path: string, method = 'GET', body?: unknown): Promise<ApiResult<T>> {
  const r = await fetch('/api' + path, {
    method, credentials: 'same-origin',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  let data: any = null;
  try { data = await r.json(); } catch { /* resposta sem JSON */ }
  return { ok: r.ok, status: r.status, data: data ?? {} };
}
