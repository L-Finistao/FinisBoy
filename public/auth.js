'use strict';

/* Login e sincronização com a conta (banco no Neon, via /api).
   - O app continua funcionando sem internet: tudo é gravado no aparelho (IndexedDB) e enviado quando há conexão.
   - Cada usuário só enxerga os próprios dados: o servidor filtra pelo login e o aparelho troca de dados ao trocar de conta.
   Carregado ANTES de app.js; usa as globais DB, $ e esc (resolvidas só na hora de usar). */

const SYNC_STORES = new Set(['stops', 'deliveries', 'expenses', 'routes', 'tracks']);
// Configurações (kv) que vão para a conta. O pacote offline e o cache de endereços ficam só no aparelho.
const SYNC_KV = new Set(['profiles', 'lastProfile', 'pay', 'target', 'city', 'learnOn', 'keepOn', 'voice', 'avatar', 'hazards', 'devzones', 'speedmap']);
const KV_MIN_MS = { speedmap: 5 * 60 * 1000 };               // o mapa de velocidades muda a cada instante e é pesado
const BATCH_BYTES = 800 * 1024;
const MAX_DOC_BYTES = 3.5 * 1024 * 1024;

let authUser = null;
let syncQ = new Map();                                       // "store|id" -> { store, id, del, t }
let syncApplying = false, syncBusy = false, syncTimer = null, syncSaveTimer = null;
const lastKvPush = {};
let syncMsg = '';

/* ---------- Chamadas à API ---------- */
async function api(path, method = 'GET', body) {
  const r = await fetch('/api' + path, {
    method, credentials: 'same-origin',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  let j = null;
  try { j = await r.json(); } catch { /* resposta sem JSON */ }
  return { ok: r.ok, status: r.status, j: j || {} };
}

/* ---------- Fila de alterações (chamada por app.js a cada gravação local) ---------- */
function syncMark(store, id, del) {
  if (syncApplying || !authUser) return;
  if (store === 'kv' ? !SYNC_KV.has(id) : !SYNC_STORES.has(store)) return;
  syncQ.set(store + '|' + id, { store, id, del: !!del, t: Date.now() });
  clearTimeout(syncSaveTimer);
  syncSaveTimer = setTimeout(() => DB.set('syncq', [...syncQ.values()]), 1000);
  clearTimeout(syncTimer);
  syncTimer = setTimeout(syncNow, 15000);
}

async function enqueueAll() {                                // dados que já estavam no aparelho antes do login
  for (const store of SYNC_STORES) for (const o of await DB.allOf(store)) syncQ.set(store + '|' + o.id, { store, id: o.id, del: false, t: Date.now() });
  for (const k of SYNC_KV) if ((await DB.get(k)) !== undefined) syncQ.set('kv|' + k, { store: 'kv', id: k, del: false, t: Date.now() });
  await DB.set('syncq', [...syncQ.values()]);
}

async function wipeLocal() {                                 // outra conta neste aparelho: começa limpo
  syncApplying = true;
  try {
    for (const store of SYNC_STORES) for (const o of await DB.allOf(store)) await DB.delOf(store, o.id);
    for (const k of [...SYNC_KV, 'syncq', 'syncSince', 'authUser']) await DB.delOf('kv', k);
  } finally { syncApplying = false; }
  syncQ = new Map();
}

/* ---------- Enviar e baixar ---------- */
async function pushChanges() {
  const now = Date.now();
  const live = c => c.store === 'tracks' && typeof session !== 'undefined' && session && session.id === c.id;   // trajeto da rota em andamento: envia só no fim
  const due = [...syncQ.values()].filter(c => !live(c) && (c.store !== 'kv' || now - (lastKvPush[c.id] || 0) >= (KV_MIN_MS[c.id] || 0)));
  const out = [];
  for (const c of due) {
    let data = null;
    if (!c.del) {
      data = c.store === 'kv' ? await DB.get(c.id) : await DB.getOf(c.store, c.id);
      if (data === undefined) { syncQ.delete(c.store + '|' + c.id); continue; }       // já não existe: nada a enviar
    }
    out.push({ c, ch: { store: c.store, id: c.id, data, deleted: c.del, ts: c.t } });
  }
  let batch = [], size = 0;
  const flush = async () => {
    if (!batch.length) return;
    const r = await api('/sync', 'POST', { changes: batch.map(x => x.ch) });
    if (r.status === 401) throw Object.assign(new Error('auth'), { auth: true });
    if (!r.ok) throw new Error(r.j.error || 'erro ' + r.status);
    for (const x of batch) {
      if (syncQ.get(x.c.store + '|' + x.c.id) === x.c) syncQ.delete(x.c.store + '|' + x.c.id);   // se mudou de novo no meio, fica na fila
      if (x.c.store === 'kv') lastKvPush[x.c.id] = Date.now();
    }
    batch = []; size = 0;
  };
  for (const x of out) {
    const n = JSON.stringify(x.ch).length;
    if (n > MAX_DOC_BYTES) { syncQ.delete(x.c.store + '|' + x.c.id); console.warn('Registro grande demais para sincronizar:', x.c.store, x.c.id); continue; }
    if (size + n > BATCH_BYTES) await flush();
    batch.push(x); size += n;
  }
  await flush();
  await DB.set('syncq', [...syncQ.values()]);
}

async function pullChanges() {
  let since = (await DB.get('syncSince')) || 0, applied = 0;
  for (;;) {
    const r = await api('/sync?since=' + since);
    if (r.status === 401) throw Object.assign(new Error('auth'), { auth: true });
    if (!r.ok) throw new Error(r.j.error || 'erro ' + r.status);
    syncApplying = true;
    try {
      for (const ch of r.j.changes) {
        if (syncQ.has(ch.store + '|' + ch.id)) continue;                 // alteração local ainda não enviada vale mais
        if (ch.store === 'kv') { if (!SYNC_KV.has(ch.id)) continue; if (ch.deleted) await DB.delOf('kv', ch.id); else await DB.set(ch.id, ch.data); }
        else if (SYNC_STORES.has(ch.store)) { if (ch.deleted) await DB.delOf(ch.store, ch.id); else await DB.putOf(ch.store, ch.data); }
        else continue;
        applied++;
      }
    } finally { syncApplying = false; }
    since = r.j.next;
    await DB.set('syncSince', since);
    if (!r.j.more) break;
  }
  return applied;
}

async function syncNow(manual = false) {
  if (!authUser || syncBusy) return;
  if (!navigator.onLine) { syncMsg = 'Sem internet: as alterações serão enviadas quando a conexão voltar.'; syncInfoShow(); return; }
  syncBusy = true;
  try {
    await pushChanges();
    const n = await pullChanges();
    syncMsg = 'Sincronizado às ' + new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) + (syncQ.size ? ` · ${syncQ.size} pendente(s)` : '');
    if (n && typeof session !== 'undefined' && !session) { location.reload(); return; }   // dados novos de outro aparelho
    if (n) syncMsg += ' · dados novos de outro aparelho: reabra o app depois da rota';
  } catch (e) {
    if (e.auth) { authUser = null; syncMsg = 'Sessão expirada: entre de novo.'; showLogin().then(() => syncNow()); }
    else syncMsg = 'Não foi possível sincronizar agora (' + e.message + '). Tentaremos de novo.';
  } finally { syncBusy = false; syncInfoShow(); }
}

/* ---------- Tela de login ---------- */
let loginMode = 'login';
let loginDone = null;

function loginRender() {
  const reg = loginMode === 'register';
  $('authTitle').textContent = reg ? 'Criar conta' : 'Entrar';
  $('authNameWrap').hidden = !reg;
  $('authSubmit').textContent = reg ? 'Criar conta' : 'Entrar';
  $('authSwitch').textContent = reg ? 'Já tenho conta' : 'Criar conta nova';
  $('authPass').autocomplete = reg ? 'new-password' : 'current-password';
}

function showLogin(msg = '') {
  const dlg = $('authDlg');
  $('authErr').textContent = msg;
  loginRender();
  if (!dlg.open) dlg.showModal();
  return new Promise(res => { loginDone = res; });
}

async function loginSubmit(e) {
  e.preventDefault();
  const reg = loginMode === 'register', btn = $('authSubmit');
  $('authErr').textContent = '';
  btn.disabled = true;
  try {
    const r = await api(reg ? '/register' : '/login', 'POST', {
      email: $('authEmail').value, password: $('authPass').value, name: $('authName').value, code: $('authCode').value,
    });
    if (!r.ok) {
      if (r.j.needCode) $('authCodeWrap').hidden = false;
      $('authErr').textContent = r.j.error || (r.status === 404 ? 'O servidor de contas não está configurado.' : 'Erro ao entrar (' + r.status + ').');
      return;
    }
    authUser = r.j.user;
    await DB.set('authUser', authUser);
    $('authPass').value = '';
    $('authDlg').close();
    if (loginDone) { loginDone(); loginDone = null; }
  } catch {
    $('authErr').textContent = 'Sem conexão com o servidor. Conecte-se à internet para entrar.';
  } finally { btn.disabled = false; }
}

function authBind() {
  $('authForm').onsubmit = loginSubmit;
  $('authSwitch').onclick = () => { loginMode = loginMode === 'login' ? 'register' : 'login'; $('authErr').textContent = ''; loginRender(); };
  $('authDlg').addEventListener('cancel', e => e.preventDefault());          // não dá para fechar sem entrar
  $('btnSync').onclick = () => syncNow(true);
  $('btnLogout').onclick = logout;
  window.addEventListener('online', () => syncNow());
  document.addEventListener('visibilitychange', () => { if (document.hidden) syncNow(); });
  setInterval(() => syncNow(), 60000);
}

function syncInfoShow() {
  const el = document.getElementById('acctInfo');
  if (el) el.textContent = authUser ? `${authUser.name ? authUser.name + ' · ' : ''}${authUser.email}${syncMsg ? '\n' + syncMsg : ''}` : '';
}

async function logout() {
  await syncNow();
  if (syncQ.size && !confirm(`Há ${syncQ.size} alteração(ões) que ainda não foram enviadas para a conta e podem ser perdidas. Sair mesmo assim?`)) return;
  try { await api('/logout', 'POST'); } catch { /* sem internet: o cookie expira sozinho */ }
  await DB.set('authUser', null);
  location.reload();
}

/* ---------- Entrada: chamada por app.js antes de carregar os dados ---------- */
async function authGate() {
  authBind();
  authUser = (await DB.get('authUser')) || null;               // conta lembrada (permite abrir sem internet)
  let r = null;
  try { r = await api('/me'); } catch { /* sem internet */ }
  if (r && r.ok) { authUser = r.j.user; await DB.set('authUser', authUser); }
  else if (r && r.status === 401) { authUser = null; await DB.set('authUser', null); }
  let first = true;
  while (!authUser) {                                          // obrigatório entrar (a primeira vez precisa de internet)
    const why = !r ? 'Sem conexão com o servidor. Conecte-se à internet para entrar.'
      : r.status === 404 ? 'O servidor de contas não está configurado neste endereço (rode com `vercel dev` ou publique na Vercel).'
      : r.status >= 500 ? 'O servidor de contas está com problema (' + r.status + '). Veja os logs da Vercel.' : '';
    await showLogin(first ? why : '');
    first = false;
  }

  const owner = await DB.get('dataOwner');
  syncQ = new Map((await DB.get('syncq') || []).map(c => [c.store + '|' + c.id, c]));
  if (owner && owner !== authUser.id) { await wipeLocal(); await DB.set('authUser', authUser); }   // os dados deste aparelho eram de outra conta
  if (!owner) await enqueueAll();                              // primeiro login: leva os dados do aparelho para a conta
  await DB.set('dataOwner', authUser.id);

  try {
    syncMsg = '';
    await pushChanges();
    await pullChanges();                                       // traz os dados da conta antes de o app carregar o estado
  } catch (e) { if (e.auth) authUser = null; }                 // sem internet: segue com o que tem no aparelho
  syncInfoShow();
  setTimeout(syncNow, 3000);
}
