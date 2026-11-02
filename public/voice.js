'use strict';

/* Assistente de voz: fala avisos durante a rota e escuta comandos ("Turbo, entrega feita").
   Usa o que o navegador já tem (speechSynthesis e SpeechRecognition), sem biblioteca nem servidor nosso.
   Carregado antes de app.js; as globais dele (session, pending, markDone…) só são usadas na hora de executar. */

const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
let voice = { speak: true, listen: true, nav: true };
let recog = null, recogWant = false, recogFails = 0, recogTimer = null;
let awakeUntil = 0, confirmEnd = 0, lastSaid = '', speakingUntil = 0;
const saidAt = {};
const WAKE = /\b(turbo|turbo slug|turboslug|finis|finish|fines|finisboy|finis boy|assistente)\b/;

const plain = t => String(t || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
const spokenAddr = s => String(s.raw || 'endereço sem nome').split(/\s[-–]\s|;|\(/)[0].slice(0, 70);

/* ---------- Fala ---------- */
function say(text, key, urgent) {
  if (!voice.speak || !('speechSynthesis' in window) || !text) return;
  const now = Date.now();
  if (key) { if (now - (saidAt[key] || 0) < 20000) return; saidAt[key] = now; }   // não repete o mesmo aviso em sequência
  lastSaid = text;
  if (urgent) { try { speechSynthesis.cancel(); } catch { /* sem síntese */ } }
  const u = new SpeechSynthesisUtterance(text);
  u.lang = 'pt-BR'; u.rate = 1.05;
  u.onend = () => { speakingUntil = Date.now() + 700; };
  speakingUntil = now + 60000;                                   // enquanto fala, não escuta (evita ouvir a si mesmo)
  speechSynthesis.speak(u);
}

function shutUp() { try { speechSynthesis.cancel(); } catch { /* sem síntese */ } speakingUntil = 0; }

function nextStopText() {
  const n = pending().find(s => s.lat != null) || pending()[0];
  if (!n) return 'Não há paradas pendentes.';
  const d = typeof me !== 'undefined' && me && n.lat != null ? ', a ' + fmtDist(haversine(me, n)) : '';
  return 'Próxima parada: ' + spokenAddr(n) + d + '.';
}

/* ---------- Comandos ---------- */
async function voiceCommand(raw) {
  const t = plain(raw);
  if (!t) return;
  if (confirmEnd > Date.now() && /\b(confirmar|confirma|sim|pode)\b/.test(t)) {
    confirmEnd = 0;
    if (session) await endRoute(true);
    return;
  }
  confirmEnd = 0;
  if (/\b(silencio|silenciar|cala|calar|quieto|para de falar)\b/.test(t)) { shutUp(); return; }
  if (/\brepet/.test(t)) { say(lastSaid || 'Nada para repetir.'); return; }
  if (/\b(ajuda|comandos)\b/.test(t)) { say('Você pode dizer: entrega feita, próxima parada, quanto falta, quantas faltam, quanto ganhei hoje, falar a rota, finalizar rota, repetir ou silêncio.'); return; }
  if (!session) { say('Inicie uma rota para usar os comandos.'); return; }
  if (/\b(finalizar|encerrar|terminar|fechar) (a )?rota\b/.test(t)) { confirmEnd = Date.now() + 10000; say('Diga confirmar para finalizar a rota.'); return; }
  if (/\b(quanto ganhei|ganho|faturei|faturamento)\b/.test(t)) { say('Hoje você ganhou ' + money(todayGross()) + '.'); return; }
  if (/\b(quantas|quantos|faltam|falta quantas)\b/.test(t) && !/quanto falta/.test(t)) {
    const n = pending().length; say(n ? `Faltam ${n} ${n === 1 ? 'entrega' : 'entregas'}.` : 'Não falta nenhuma entrega.'); return;
  }
  if (/\b(quanto falta|quanto tempo|chegada|chego|restam)\b/.test(t)) {
    const e = ($('rbEta').textContent || '').split('·').slice(0, 2).join(', ');
    say(e ? e.replace('restam', 'Restam') + '.' : 'Ainda não sei: aguarde o GPS e a rota.'); return;
  }
  if (/\b(falar|fale|ler|leia|descrever|descreva|diga|dizer) (a )?(rota|caminho)\b/.test(t) || /\b(como chego|qual o caminho)\b/.test(t)) { voiceRoute(); return; }
  if (/\bproxim/.test(t)) { say(nextStopText()); return; }
  if (/\b(entreg(ue|ou|a)|feito|concluida|concluido|entreguei)\b/.test(t)) {
    const n = pending()[0];
    if (!n || curId !== session.id) { say('Não há entrega pendente.'); return; }
    say('Entrega registrada: ' + spokenAddr(n) + '.');
    await markDone(n.id, true);                                  // markDone fala a próxima parada ou o fim da rota
    return;
  }
  say('Não entendi. Diga ajuda para ouvir os comandos.');
}

function onHeard(text) {
  if (Date.now() < speakingUntil) return;                        // era a própria voz do app
  const t = plain(text), now = Date.now();
  const m = WAKE.exec(t);
  if (m) {
    const rest = t.slice(m.index + m[0].length).trim();
    if (!rest) { awakeUntil = now + 8000; if (navigator.vibrate) navigator.vibrate(60); setStatus('🎙 Pode falar…', 3000); return; }
    voiceCommand(rest);
  } else if (now < awakeUntil) { awakeUntil = 0; voiceCommand(t); }
}

/* ---------- Escuta contínua (só com a rota iniciada) ---------- */
function recogStart() {
  if (recog || !SR) return;
  const r = new SR();
  r.lang = 'pt-BR'; r.continuous = true; r.interimResults = false; r.maxAlternatives = 1;
  r.onresult = e => {
    for (let i = e.resultIndex; i < e.results.length; i++) if (e.results[i].isFinal) onHeard(e.results[i][0].transcript);
    recogFails = 0;
  };
  r.onerror = e => {
    if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
      recogWant = false;
      setStatus('🎙 Microfone bloqueado: libere nas permissões do site para usar a voz.', 6000);
    }
  };
  r.onend = () => {                                              // o navegador encerra sozinho de tempos em tempos: reinicia
    recog = null;
    if (!recogWant) return;
    recogFails++;
    clearTimeout(recogTimer);
    recogTimer = setTimeout(recogStart, Math.min(8000, 300 * recogFails * recogFails));
  };
  recog = r;
  try { r.start(); } catch { recog = null; }
}

function recogStop() {
  recogWant = false;
  clearTimeout(recogTimer);
  if (recog) { try { recog.stop(); } catch { /* já parado */ } recog = null; }
}

// Chamada por applySessionUI: liga a escuta ao iniciar a rota e desliga ao finalizar.
function voiceSync() {
  const want = !!SR && voice.listen && !!session;
  if (want && !recogWant) { recogWant = true; recogFails = 0; recogStart(); setStatus('🎙 Escutando. Diga "Turbo, entrega feita" ou "Turbo, ajuda".', 5000); }
  else if (!want && recogWant) recogStop();
}

/* ---------- Configurações ---------- */
async function voiceSave() {
  voice.speak = $('voiceSpeak').checked;
  voice.listen = $('voiceListen').checked;
  voice.nav = $('voiceNav').checked;
  await DB.set('voice', voice);
  if (!voice.speak) shutUp();
  voiceSync();
}

async function voiceInit() {
  voice = { ...voice, ...((await DB.get('voice')) || {}) };
  $('voiceSpeak').checked = voice.speak;
  $('voiceListen').checked = voice.listen;
  $('voiceNav').checked = voice.nav;
  $('voiceNav').onchange = voiceSave;
  $('rbVoice').onclick = voiceRoute;
  $('voiceSpeak').disabled = !('speechSynthesis' in window);
  $('voiceListen').disabled = !SR;
  $('voiceInfo').textContent = !SR ? 'Este navegador não reconhece voz (use o Chrome no Android). Os avisos falados continuam funcionando.' : '';
  $('voiceSpeak').onchange = voiceSave;
  $('voiceListen').onchange = voiceSave;
  // celulares só liberam a fala depois de um toque na tela
  document.addEventListener('pointerdown', () => { try { speechSynthesis.speak(new SpeechSynthesisUtterance('')); } catch { /* sem síntese */ } }, { once: true });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) voiceSync(); });
}
