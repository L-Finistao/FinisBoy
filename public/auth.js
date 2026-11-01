'use strict';

/* Login e backup diário na conta (banco no Neon, via /api).
   - Os dados vivem no aparelho (IndexedDB); o app funciona sem internet e nada é baixado sozinho.
   - Uma vez por dia (ou no botão "Fazer backup agora") o que mudou é enviado para a conta. "Restaurar da nuvem" é manual.
   - O servidor só entrega ao usuário do login os dados dele.
   Carregado ANTES de app.js; usa as globais DB, $ e esc (resolvidas só na hora de usar). */

const BACKUP_MS = 24 * 3600 * 1000;                          // intervalo do backup automático
const SYNC_STORES = new Set(['stops', 'deliveries', 'expenses', 'routes', 'tracks']);
// Configurações (kv) que vão para a conta. O pacote offline e o cache de endereços ficam só no aparelho.
const SYNC_KV = new Set(['profiles', 'lastProfile', 'pay', 'target', 'city', 'learnOn', 'keepOn', 'voice', 'avatar', 'hazards', 'devzones', 'speedmap']);
const BATCH_BYTES = 800 * 1024;
const MAX_DOC_BYTES = 3.5 * 1024 * 1024;

let authUser = null;
let syncQ = new Map();                                       // "store|id" -> { store, id, del, t }
let syncApplying = false, syncBusy = false, syncSaveTimer = null;
let syncMsg = '', lastBackup = 0;

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
}

async function enqueueAll() {                                // dados que já estavam no aparelho antes do login
  for (const store of SYNC_STORES) for (const o of await DB.allOf(store)) syncQ.set(store + '|' + o.id, { store, id: o.id, del: false, t: Date.now() });
  for (const k of SYNC_KV) if ((await DB.get(k)) !== undefined) syncQ.set('kv|' + k, { store: 'kv', id: k, del: false, t: Date.now() });
  await DB.set('syncq', [...syncQ.values()]);
}

/* ---------- Enviar (backup) e restaurar ---------- */
async function pushChanges() {
  const live = c => c.store === 'tracks' && typeof session !== 'undefined' && session && session.id === c.id;   // trajeto da rota em andamento: envia só no fim
  const due = [...syncQ.values()].filter(c => !live(c));
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

async function pullChanges(force = false) {          // force: restauração manual, o que veio da nuvem vale mais
  let since = force ? 0 : (await DB.get('syncSince')) || 0, applied = 0;
  for (;;) {
    const r = await api('/sync?since=' + since);
    if (r.status === 401) throw Object.assign(new Error('auth'), { auth: true });
    if (!r.ok) throw new Error(r.j.error || 'erro ' + r.status);
    syncApplying = true;
    try {
      for (const ch of r.j.changes) {
        if (!force && syncQ.has(ch.store + '|' + ch.id)) continue;       // alteração local ainda não enviada vale mais
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

const backupDue = () => Date.now() - lastBackup >= BACKUP_MS;

// Envia as alterações para a conta. Automático: no máximo uma vez por dia. manual === true: agora.
async function syncNow(manual = false) {
  if (!authUser || syncBusy || (manual !== true && !backupDue())) return;
  if (!navigator.onLine) { syncMsg = 'Sem internet: o backup será feito quando a conexão voltar.'; syncInfoShow(); return; }
  syncBusy = true;
  try {
    await pushChanges();
    lastBackup = Date.now();
    await DB.set('lastBackup', lastBackup);
    syncMsg = '';
  } catch (e) {
    if (e.auth) { authUser = null; syncMsg = 'Sessão expirada: entre de novo.'; showLogin().then(() => syncNow(true)); }
    else syncMsg = 'Não foi possível fazer o backup agora (' + e.message + '). Tentaremos de novo.';
  } finally { syncBusy = false; syncInfoShow(); }
}

// Traz o backup da nuvem para o aparelho (manual). Itens que só existem aqui são mantidos.
async function restoreCloud() {
  if (!authUser || syncBusy) return;
  if (typeof session !== 'undefined' && session) { alert('Finalize a rota em andamento antes de restaurar.'); return; }
  if (!navigator.onLine) { alert('Sem internet.'); return; }
  const when = lastBackup ? new Date(lastBackup).toLocaleString('pt-BR') : 'nunca feito neste aparelho';
  if (!confirm('Restaurar os dados da nuvem?\n\nO que existir na nuvem substitui a versão deste aparelho (último backup daqui: ' + when + '). O que só existe aqui é mantido.')) return;
  syncBusy = true;
  try {
    const n = await pullChanges(true);
    syncQ = new Map(); await DB.set('syncq', []);
    alert(n ? n + ' item(ns) restaurado(s). O app vai recarregar.' : 'Não há backup na nuvem para esta conta.');
    if (n) location.reload();
  } catch (e) {
    syncMsg = 'Não foi possível restaurar (' + e.message + ').';
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
  $('btnLogout').onclick = logout;
  $('btnSync').onclick = () => syncNow(true);
  $('btnRestore').onclick = restoreCloud;
  window.addEventListener('online', () => syncNow());
  document.addEventListener('visibilitychange', () => { if (!document.hidden) syncNow(); });
  setInterval(() => syncNow(), 30 * 60 * 1000);                // confere de tempos em tempos se já passou um dia
}

function syncInfoShow() {
  const el = document.getElementById('acctInfo');
  if (!el) return;
  const bk = lastBackup ? 'Último backup: ' + new Date(lastBackup).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : 'Nenhum backup feito ainda.';
  el.textContent = authUser ? (authUser.name ? authUser.name + ' · ' : '') + authUser.email + '\n' + bk + (syncMsg ? '\n' + syncMsg : '') : '';
}

async function logout() {
  await syncNow(true);                                         // backup antes de sair
  if (syncQ.size && !confirm(`Há ${syncQ.size} alteração(ões) sem backup na conta. Sair mesmo assim? (os dados continuam neste aparelho)`)) return;
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
      : r.status === 404 ? 'O servidor de contas não está configurado neste endereço (rode com `npm run dev` ou publique na Vercel com o framework Next.js).'
      : r.status >= 500 ? 'O servidor de contas está com problema (' + r.status + '). Veja os logs da Vercel.' : '';
    await showLogin(first ? why : '');
    first = false;
  }

  // Os dados ficam no aparelho. Na primeira vez (ou ao trocar de conta) o que já existe aqui entra no próximo backup.
  const owner = await DB.get('dataOwner');
  lastBackup = (await DB.get('lastBackup')) || 0;
  syncQ = new Map((await DB.get('syncq') || []).map(c => [c.store + '|' + c.id, c]));
  if (owner !== authUser.id || !(await DB.get('backupInit'))) {
    syncQ = new Map(); lastBackup = 0;
    await enqueueAll();
    await DB.set('dataOwner', authUser.id); await DB.set('backupInit', true); await DB.set('lastBackup', 0);
  }
  syncInfoShow();
  setTimeout(syncNow, 3000);                                   // faz o backup se já passou um dia
}
