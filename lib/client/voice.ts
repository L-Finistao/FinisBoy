'use client';
import { useSyncExternalStore } from 'react';
import { local } from './local-db';

/* Assistente de voz: fala avisos durante a rota e escuta comandos ("Turbo, entrega feita").
   Usa o que o navegador já tem (speechSynthesis e SpeechRecognition), sem biblioteca nem servidor nosso. */

export interface VoiceCfg { speak: boolean; listen: boolean; nav: boolean }
const DEFAULT: VoiceCfg = { speak: true, listen: false, nav: true };

let cfg: VoiceCfg = DEFAULT, loaded = false;
const subs = new Set<() => void>();
const emit = () => subs.forEach(f => f());
const subscribe = (f: () => void) => { subs.add(f); return () => { subs.delete(f); }; };

export const getVoice = () => cfg;
export async function loadVoice() {
  if (loaded) return;
  loaded = true;
  cfg = { ...DEFAULT, ...((await local.kvGet<Partial<VoiceCfg>>('voice')) || {}) };
  emit();
  // celulares só liberam a fala depois de um toque na tela
  document.addEventListener('pointerdown', () => { try { speechSynthesis.speak(new SpeechSynthesisUtterance('')); } catch { /* sem síntese */ } }, { once: true });
}
export async function saveVoice(p: Partial<VoiceCfg>) {
  cfg = { ...cfg, ...p };
  emit();
  if (!cfg.speak) shutUp();
  if (!cfg.listen) stopListening();
  await local.kvSet('voice', cfg);
}
export const useVoiceCfg = () => useSyncExternalStore(subscribe, () => cfg, () => DEFAULT);

export const voiceSupport = () => ({
  speak: typeof window !== 'undefined' && 'speechSynthesis' in window,
  listen: typeof window !== 'undefined' && !!((window as any).SpeechRecognition || (window as any).webkitSpeechRecognition),
});

/* ---------- Fala ---------- */
const saidAt: Record<string, number> = {};
let lastSaid = '', speakingUntil = 0;
export const lastSpoken = () => lastSaid;
export const isSpeaking = () => Date.now() < speakingUntil;

export function say(text: string, key?: string, urgent = false) {
  if (!cfg.speak || typeof speechSynthesis === 'undefined' || !text) return;
  const now = Date.now();
  if (key) { if (now - (saidAt[key] || 0) < 20000) return; saidAt[key] = now; }   // não repete o mesmo aviso em sequência
  lastSaid = text;
  if (urgent) { try { speechSynthesis.cancel(); } catch { /* sem síntese */ } }
  try {
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'pt-BR'; u.rate = 1.05;
    u.onend = () => { speakingUntil = Date.now() + 700; };
    speakingUntil = now + 60000;                                   // enquanto fala, não escuta (evita ouvir a si mesmo)
    speechSynthesis.speak(u);
  } catch { speakingUntil = 0; }                                   // sem síntese de voz neste navegador
}
export function shutUp() { try { speechSynthesis.cancel(); } catch { /* sem síntese */ } speakingUntil = 0; }

/* ---------- Escuta contínua (só com a rota iniciada) ---------- */
let recog: any = null, want = false, fails = 0, timer: ReturnType<typeof setTimeout> | undefined;
let handler: ((text: string) => void) | null = null, onError: ((msg: string) => void) | null = null;
export const isListening = () => want;
export const useVoiceListening = () => useSyncExternalStore(subscribe, () => want, () => false);

function begin() {
  const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
  if (recog || !SR) return;
  const r = new SR();
  r.lang = 'pt-BR'; r.continuous = true; r.interimResults = false; r.maxAlternatives = 1;
  r.onresult = (e: any) => {
    for (let i = e.resultIndex; i < e.results.length; i++) if (e.results[i].isFinal && !isSpeaking()) handler?.(e.results[i][0].transcript);
    fails = 0;
  };
  r.onerror = (e: any) => {
    if (e.error === 'not-allowed' || e.error === 'service-not-allowed') { want = false; onError?.('🎙 Microfone bloqueado: libere nas permissões do site para usar a voz.'); }
  };
  r.onend = () => {                                                // o navegador encerra sozinho de tempos em tempos: reinicia
    recog = null;
    if (!want) return;
    fails++;
    clearTimeout(timer);
    timer = setTimeout(begin, Math.min(8000, 300 * fails * fails));
  };
  recog = r;
  try { r.start(); } catch { recog = null; }
}

export function startListening(onText: (t: string) => void, onErr?: (m: string) => void) {
  handler = onText; onError = onErr || null;
  if (want) return;
  want = true; fails = 0; emit(); begin();
}
export function stopListening() {
  want = false;
  clearTimeout(timer);
  if (recog) { try { recog.stop(); } catch { /* já parado */ } recog = null; }
  emit();
}
