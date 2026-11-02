import { collect, dayKey, periodStart, sumSlots, todayGross, type Ctx } from './earnings';
import type { Route, Stop } from './types';

/* Gamificação. Tudo é CALCULADO a partir do que o app já guarda (entregas, rotas, km, ganhos): o mesmo resultado em qualquer
   aparelho, funciona offline e nunca perde pontos. Só a configuração do jogador (apelido, avatar, tema, metas e o que já foi
   comemorado) é gravada, na chave 'game', e vai junto no backup. */

export interface Goals { dayDeliveries: number; dayGain: number; weekDeliveries: number; weekGain: number }
export interface GameCfg {
  nick: string; avatar: string; theme: string; goals: Goals;
  seen?: { level: number; ach: string[] };           // o que já foi comemorado (não repete a festa)
  hitDays: string[];                                  // dias em que a meta diária foi batida (vale 50 XP, gravado na hora)
  challengeDone: Record<string, string>;              // dia -> desafio concluído
}
export const DEFAULT_CFG: GameCfg = {
  nick: '', avatar: '🏍️', theme: 'verde', goals: { dayDeliveries: 10, dayGain: 0, weekDeliveries: 50, weekGain: 0 }, hitDays: [], challengeDone: {},
};

/* ---------- Personalização (desbloqueada por nível) ---------- */
export const AVATARS = [
  { e: '🏍️', lvl: 1 }, { e: '🛵', lvl: 1 }, { e: '🚴', lvl: 2 }, { e: '🦊', lvl: 3 }, { e: '🐆', lvl: 4 },
  { e: '🚀', lvl: 6 }, { e: '🦅', lvl: 8 }, { e: '🔥', lvl: 10 }, { e: '👑', lvl: 15 }, { e: '🐉', lvl: 20 },
];
export const THEMES = [
  { id: 'verde', name: 'Verde', lvl: 1, brand: '#1b8c5a', b600: '#167a4d', soft: '#e3f4ea', ink: '#0f5a38' },
  { id: 'laranja', name: 'Laranja', lvl: 2, brand: '#e8650a', b600: '#c75606', soft: '#fdeadb', ink: '#8a3c04' },
  { id: 'azul', name: 'Azul', lvl: 3, brand: '#2563eb', b600: '#1d4fc4', soft: '#e0eaff', ink: '#173b94' },
  { id: 'roxo', name: 'Roxo', lvl: 5, brand: '#7c3aed', b600: '#6529c4', soft: '#ece3fd', ink: '#4a1f96' },
  { id: 'rosa', name: 'Rosa', lvl: 8, brand: '#db2777', b600: '#b81e62', soft: '#fde1ee', ink: '#8a1448' },
  { id: 'dourado', name: 'Dourado', lvl: 12, brand: '#b7791f', b600: '#96610f', soft: '#fbefd3', ink: '#6b450a' },
];
const TITLES: [number, string][] = [[1, 'Novato'], [3, 'Estafeta'], [5, 'Piloto'], [8, 'Veloz'], [12, 'Mestre das ruas'], [16, 'Rei do asfalto'], [20, 'Lenda'], [30, 'Imortal']];
export const titleOf = (level: number) => [...TITLES].reverse().find(([l]) => level >= l)![1];

/* ---------- Níveis ---------- */
const xpAt = (level: number) => Math.round(80 * (level - 1) ** 1.5);          // XP total para chegar no nível
export function levelInfo(xp: number) {
  let level = Math.floor((xp / 80) ** (1 / 1.5)) + 1;
  while (xpAt(level + 1) <= xp) level++;
  while (level > 1 && xpAt(level) > xp) level--;
  const from = xpAt(level), to = xpAt(level + 1);
  return { level, xp, from, to, into: xp - from, need: to - from, pct: (xp - from) / (to - from) };
}

/* ---------- Estatísticas ---------- */
export interface Stats {
  deliveries: number; routes: number; km: number; curStreak: number; bestStreak: number; fastest: number | null;
  perfectRoutes: number; maxDay: number; night: number; early: number; gainTotal: number; savedMin: number; maxKmDay: number;
  today: { n: number; fast: number; km: number; routes: number; gain: number };
  week: { n: number; gain: number };
}

export function computeStats(ctx: Ctx, stops: Stop[], running: Route | null, targetMin: number): Stats {
  const done = stops.filter(s => s.done && s.doneAt);
  const perDay = new Map<string, number>();
  let fastest: number | null = null, night = 0, early = 0;
  for (const s of done) {
    const k = dayKey(s.doneAt!), h = new Date(s.doneAt!).getHours();
    perDay.set(k, (perDay.get(k) || 0) + 1);
    if (h >= 22 || h < 5) night++;
    if (h >= 5 && h < 7) early++;
    if (s.durSec != null && s.durSec >= 20 && (fastest == null || s.durSec < fastest)) fastest = s.durSec;   // < 20 s: toque sem querer
  }
  const days = [...perDay.keys()].sort();
  let best = 0, run = 0, prev = '';
  for (const d of days) {
    const next = prev ? dayKey(new Date(prev + 'T12:00').getTime() + 86400000) : '';
    run = d === next ? run + 1 : 1;
    best = Math.max(best, run); prev = d;
  }
  // sequência atual: dias seguidos até hoje (ou até ontem, se hoje ainda não teve entrega)
  let cur = 0, d = new Date(); d.setHours(12, 0, 0, 0);
  if (!perDay.has(dayKey(d.getTime()))) d = new Date(d.getTime() - 86400000);
  while (perDay.has(dayKey(d.getTime()))) { cur++; d = new Date(d.getTime() - 86400000); }

  const fin = ctx.routes.filter(r => r.status === 'finalizada');
  const kmByDay = new Map<string, number>();
  let km = 0, saved = 0, perfect = 0;
  for (const r of fin) {
    const k = (r.kmFinal || 0) / 1000;
    km += k; kmByDay.set(dayKey(r.endedAt || 0), (kmByDay.get(dayKey(r.endedAt || 0)) || 0) + k);
    if (r.geo?.baseline) saved += Math.max(0, r.geo.baseline.duration - r.geo.duration) / 60;
    const rs = stops.filter(s => s.routeId === r.id);
    // rota perfeita: 3+ entregas, todas feitas, todas dentro da meta de tempo
    if (targetMin > 0 && rs.length >= 3 && rs.every(s => s.done && s.durSec != null && s.durSec <= targetMin * 60)) perfect++;
  }
  const today = dayKey(Date.now());
  const todayDone = done.filter(s => dayKey(s.doneAt!) === today);
  const kmToday = (kmByDay.get(today) || 0) + (running ? (running.km || 0) / 1000 : 0);
  const wk = periodStart('semana');
  const gainAll = sumSlots([...collect(ctx, 0, Date.now() + 86400000, 'all', running).values()]).gain;
  const gainWeek = sumSlots([...collect(ctx, wk, Date.now() + 86400000, 'all', running).values()]).gain;
  return {
    deliveries: done.length, routes: fin.length, km, curStreak: cur, bestStreak: best, fastest, perfectRoutes: perfect,
    maxDay: Math.max(0, ...perDay.values()), night, early, gainTotal: gainAll, savedMin: saved, maxKmDay: Math.max(0, kmToday, ...kmByDay.values()),
    today: {
      n: todayDone.length, fast: todayDone.filter(s => s.durSec != null && s.durSec < 480).length, km: kmToday,
      routes: fin.filter(r => dayKey(r.endedAt || 0) === today).length, gain: todayGross(ctx, running),
    },
    week: { n: done.filter(s => s.doneAt! >= wk).length, gain: gainWeek },
  };
}

/* ---------- Conquistas ---------- */
export interface Achievement { id: string; name: string; desc: string; icon: string; goal: number; value: (s: Stats) => number }
const A = (id: string, icon: string, name: string, desc: string, goal: number, value: (s: Stats) => number): Achievement => ({ id, icon, name, desc, goal, value });
export const ACHIEVEMENTS: Achievement[] = [
  A('d1', '📦', 'Primeira entrega', 'Faça sua primeira entrega', 1, s => s.deliveries),
  A('d10', '🚀', 'Pegando o ritmo', 'Faça 10 entregas', 10, s => s.deliveries),
  A('d50', '💪', 'Cinquentão', 'Faça 50 entregas', 50, s => s.deliveries),
  A('d100', '💯', 'Centenário', 'Faça 100 entregas', 100, s => s.deliveries),
  A('d500', '🏅', 'Lenda das ruas', 'Faça 500 entregas', 500, s => s.deliveries),
  A('d1000', '👑', 'Mil e uma', 'Faça 1.000 entregas', 1000, s => s.deliveries),
  A('r1', '🏁', 'Primeira rota', 'Finalize uma rota', 1, s => s.routes),
  A('r10', '🗺️', 'Rotineiro', 'Finalize 10 rotas', 10, s => s.routes),
  A('r50', '🧭', 'Veterano', 'Finalize 50 rotas', 50, s => s.routes),
  A('k100', '🛣️', 'Cem na estrada', 'Rode 100 km em rotas', 100, s => s.km),
  A('k500', '🌄', 'Meio milhar', 'Rode 500 km em rotas', 500, s => s.km),
  A('k2000', '🌎', 'Volta ao Brasil', 'Rode 2.000 km em rotas', 2000, s => s.km),
  A('s3', '🔥', 'Em chamas', '3 dias seguidos com entregas', 3, s => s.bestStreak),
  A('s7', '☄️', 'Semana de fogo', '7 dias seguidos com entregas', 7, s => s.bestStreak),
  A('s30', '🌋', 'Imparável', '30 dias seguidos com entregas', 30, s => s.bestStreak),
  A('fast', '⚡', 'Relâmpago', 'Uma entrega em menos de 3 minutos', 1, s => (s.fastest != null && s.fastest <= 180 ? 1 : 0)),
  A('perf1', '🎯', 'Rota perfeita', 'Rota com 3+ entregas, todas dentro da meta de tempo', 1, s => s.perfectRoutes),
  A('perf10', '🏹', 'Atirador de elite', '10 rotas perfeitas', 10, s => s.perfectRoutes),
  A('day10', '📈', 'Dia cheio', '10 entregas em um dia', 10, s => s.maxDay),
  A('day20', '🤯', 'Dia insano', '20 entregas em um dia', 20, s => s.maxDay),
  A('km50', '🏔️', 'Maratonista', 'Rode 50 km em um dia', 50, s => s.maxKmDay),
  A('owl', '🦉', 'Coruja', '10 entregas de madrugada (22h às 5h)', 10, s => s.night),
  A('lark', '🌅', 'Madrugador', '10 entregas entre 5h e 7h', 10, s => s.early),
  A('g500', '💵', 'Primeiros R$ 500', 'Ganhe R$ 500 no total', 500, s => s.gainTotal),
  A('g5000', '💰', 'Cofre cheio', 'Ganhe R$ 5.000 no total', 5000, s => s.gainTotal),
  A('save', '⏱️', 'Mestre da rota', 'Economize 60 min com a ordem otimizada', 60, s => s.savedMin),
];

/* ---------- Desafio do dia (o mesmo para todos os aparelhos no mesmo dia) ---------- */
export interface Challenge { id: string; name: string; desc: string; icon: string; goal: number; value: (s: Stats) => number; unit: string }
export const CHALLENGES: Challenge[] = [
  { id: 'n5', icon: '📦', name: 'Cinco na conta', desc: 'Entregue 5 pedidos hoje', goal: 5, unit: '', value: s => s.today.n },
  { id: 'fast2', icon: '⚡', name: 'Na correria', desc: 'Faça 2 entregas em menos de 8 min cada', goal: 2, unit: '', value: s => s.today.fast },
  { id: 'km15', icon: '🛣️', name: 'Pé na estrada', desc: 'Rode 15 km hoje', goal: 15, unit: ' km', value: s => s.today.km },
  { id: 'route1', icon: '🏁', name: 'Rota fechada', desc: 'Finalize uma rota hoje', goal: 1, unit: '', value: s => s.today.routes },
  { id: 'n8', icon: '🔥', name: 'Dia aquecido', desc: 'Entregue 8 pedidos hoje', goal: 8, unit: '', value: s => s.today.n },
];
export const CHALLENGE_XP = 40, GOAL_XP = 50, ACH_XP = 20;
export function challengeOf(day: string) {
  let h = 0;
  for (const c of day) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return CHALLENGES[h % CHALLENGES.length];
}

/* ---------- Resultado ---------- */
export function computeGame(ctx: Ctx, stops: Stop[], running: Route | null, cfg: GameCfg, targetMin: number) {
  const stats = computeStats(ctx, stops, running, targetMin);
  const done = stops.filter(s => s.done && s.doneAt);
  let xp = 0;
  for (const s of done) {
    xp += 10;
    if (s.durSec != null && targetMin > 0 && s.durSec <= targetMin * 60) xp += 5;     // dentro da meta de tempo
    if (s.durSec != null && s.durSec >= 20 && s.durSec < 300) xp += 5;                // entrega-relâmpago
  }
  xp += stats.routes * 25 + Math.floor(stats.km);
  xp += cfg.hitDays.length * GOAL_XP + Object.keys(cfg.challengeDone).length * CHALLENGE_XP + stats.bestStreak * 5;
  const ach = ACHIEVEMENTS.map(a => { const v = a.value(stats); return { ...a, v, unlocked: v >= a.goal, pct: Math.min(1, v / a.goal) }; });
  xp += ach.filter(a => a.unlocked).length * ACH_XP;
  const lv = levelInfo(xp);
  const today = dayKey(Date.now());
  const ch = challengeOf(today), chV = ch.value(stats);
  const g = cfg.goals;
  const goalHit = (g.dayDeliveries > 0 && stats.today.n >= g.dayDeliveries) || (g.dayGain > 0 && stats.today.gain >= g.dayGain);
  return {
    stats, ...lv, title: titleOf(lv.level), ach, unlockedIds: ach.filter(a => a.unlocked).map(a => a.id),
    challenge: { ...ch, v: chV, done: chV >= ch.goal || cfg.challengeDone[today] === ch.id }, goalHit, today,
  };
}
export type Game = ReturnType<typeof computeGame>;
