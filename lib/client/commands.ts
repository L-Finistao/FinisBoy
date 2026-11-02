'use client';
import * as A from './store';
import { spokenAddr, etaText } from './live';
import { lastSpoken, say, shutUp } from './voice';
import { cumulative, nearestOnRoute, posOnRoute } from '../core/geo';
import { fmtDist, fmtDur, money } from '../core/format';
import { todayGross } from '../core/earnings';
import { lowerFirst, metersSpoken, routeSteps } from '../core/nav';

/* Comandos de voz: "Turbo, entrega feita", "Turbo, quanto falta"... */

const WAKE = /\b(turbo|turbo slug|turboslug|finis|finish|fines|finisboy|finis boy|assistente)\b/;
const plain = (t: string) => String(t || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
let awakeUntil = 0, confirmEnd = 0;

// Fala as próximas manobras de uma vez (botão 🔊 ou "Turbo, falar a rota").
export function voiceRoute() {
  const r = A.session() || A.currentRoute();
  if (!r || !r.geo || !r.geo.coords) { say('Ainda não há rota calculada.'); return; }
  const cum = cumulative(r.geo.coords), total = cum[cum.length - 1];
  const me = A.getApp().me;
  let pos = 0;
  if (me) { const n = nearestOnRoute(me, r.geo.coords); if (n.d < 150) pos = posOnRoute(r.geo.coords, n); }
  const left = Math.max(0, total - pos);
  const next = routeSteps(r.geo).filter(s => (s.m ?? 0) - pos > -15).slice(0, 5);
  const parts = [`A rota tem ${fmtDist(left)} e ${fmtDur(r.geo.duration * (left / Math.max(total, 1)))}.`];
  let prev = pos;
  for (const s of next) { parts.push(`Siga ${metersSpoken(Math.max((s.m ?? 0) - prev, 10))}, depois ${lowerFirst(s.text)}.`); prev = s.m ?? prev; }
  if (!next.length) parts.push('Siga em frente até a parada.');
  say(parts.join(' '), undefined, true);
}

async function command(raw: string) {
  const t = plain(raw);
  if (!t) return;
  const run = A.session();
  if (confirmEnd > Date.now() && /\b(confirmar|confirma|sim|pode)\b/.test(t)) { confirmEnd = 0; if (run) await A.endRoute(); return; }
  confirmEnd = 0;
  if (/\b(silencio|silenciar|cala|calar|quieto|para de falar)\b/.test(t)) { shutUp(); return; }
  if (/\brepet/.test(t)) { say(lastSpoken() || 'Nada para repetir.'); return; }
  if (/\b(ajuda|comandos)\b/.test(t)) { say('Você pode dizer: entrega feita, próxima parada, quanto falta, quantas faltam, quanto ganhei hoje, falar a rota, finalizar rota, repetir ou silêncio.'); return; }
  if (!run) { say('Inicie uma rota para usar os comandos.'); return; }
  if (/\b(finalizar|encerrar|terminar|fechar) (a )?rota\b/.test(t)) { confirmEnd = Date.now() + 10000; say('Diga confirmar para finalizar a rota.'); return; }
  if (/\b(quanto ganhei|ganho|faturei|faturamento)\b/.test(t)) { say('Hoje você ganhou ' + money(todayGross(A.earningsCtx(), run)) + '.'); return; }
  if (/\b(quantas|quantos|faltam|falta quantas)\b/.test(t) && !/quanto falta/.test(t)) {
    const n = A.pendingStops(run.id).length; say(n ? `Faltam ${n} ${n === 1 ? 'entrega' : 'entregas'}.` : 'Não falta nenhuma entrega.'); return;
  }
  if (/\b(quanto falta|quanto tempo|chegada|chego|restam)\b/.test(t)) { say(etaText() || 'Ainda não sei: aguarde o GPS e a rota.'); return; }
  if (/\b(falar|fale|ler|leia|descrever|descreva|diga|dizer) (a )?(rota|caminho)\b/.test(t) || /\b(como chego|qual o caminho)\b/.test(t)) { voiceRoute(); return; }
  if (/\bproxim/.test(t)) { say(A.nextStopText()); return; }
  if (/\b(entreg(ue|ou|a)|feito|concluida|concluido|entreguei)\b/.test(t)) {
    const n = A.pendingStops(run.id)[0];
    if (!n) { say('Não há entrega pendente.'); return; }
    say('Entrega registrada: ' + spokenAddr(n) + '.');
    await A.markDone(n.id, true);                                   // markDone fala a próxima parada ou o fim da rota
    return;
  }
  say('Não entendi. Diga ajuda para ouvir os comandos.');
}

// Texto reconhecido: só vale com a palavra de ativação ("Turbo, ...") ou logo depois de dizê-la.
export function onHeard(text: string) {
  const t = plain(text), now = Date.now();
  const m = WAKE.exec(t);
  if (m) {
    const rest = t.slice(m.index + m[0].length).trim();
    if (!rest) { awakeUntil = now + 8000; if (navigator.vibrate) navigator.vibrate(60); A.setStatus('🎙 Pode falar…', 3000); return; }
    void command(rest);
  } else if (now < awakeUntil) { awakeUntil = 0; void command(t); }
}

