import { json, clearCookie } from '../../../lib/session';

export async function POST() {
  return json({ ok: true }, 200, { 'Set-Cookie': clearCookie() });
}
