import { json, endSession, needPost } from './_lib.js';

export default async function handler(req, res) {
  if (!needPost(req, res)) return;
  endSession(res);
  json(res, 200, { ok: true });
}
