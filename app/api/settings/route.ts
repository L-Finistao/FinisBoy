import { sql, serverHint } from '../../../lib/db';
import { json, userId } from '../../../lib/session';
import { isBackupMinutes, DEFAULT_BACKUP_MINUTES } from '../../../lib/shared';

export const dynamic = 'force-dynamic';

// GET /api/settings -> { backupMinutes }
export async function GET(req: Request) {
  const uid = await userId(req);
  if (!uid) return json({ error: 'Não autenticado.' }, 401);
  try {
    const [u] = await sql`select backup_minutes from users where id = ${uid}`;
    return json({ backupMinutes: u?.backup_minutes ?? DEFAULT_BACKUP_MINUTES });
  } catch (e) {
    console.error(e);
    return json({ error: serverHint(e) }, 500);
  }
}

// PUT /api/settings { backupMinutes: 5|10|15|60|120 }
export async function PUT(req: Request) {
  const uid = await userId(req);
  if (!uid) return json({ error: 'Não autenticado.' }, 401);
  const body = await req.json().catch(() => null);
  if (!isBackupMinutes(body?.backupMinutes)) return json({ error: 'Intervalo inválido.' }, 400);
  try {
    await sql`update users set backup_minutes = ${body.backupMinutes} where id = ${uid}`;
    return json({ backupMinutes: body.backupMinutes });
  } catch (e) {
    console.error(e);
    return json({ error: serverHint(e) }, 500);
  }
}
