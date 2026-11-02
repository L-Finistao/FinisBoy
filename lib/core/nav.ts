import { cumulative, segDist } from './geo';

/* Instruções de rota faladas, curva a curva ("Em 200 metros, vire à direita na Rua X").
   Os passos vêm do OSRM (com nome da rua). Sem OSRM (modo offline) as curvas são achadas pela própria linha da rota. */

export interface Step { at: [number, number]; text: string; m?: number }

const side = (m?: string) => (/left/.test(m || '') ? 'esquerda' : 'direita');
const onSt = (n: string) => (n ? ' na ' + n : '');

// Texto falado de uma manobra do OSRM (null = não vale falar).
function maneuverText(st: any, first: boolean): string | null {
  const m = st.maneuver || {}, n = String(st.name || '').trim(), t = m.type, mod = m.modifier || '', on = onSt(n);
  if (t === 'depart') return first && n ? 'Siga pela ' + n : null;
  if (t === 'arrive') return null;
  if (mod === 'uturn') return 'Faça o retorno';
  if (t === 'roundabout' || t === 'rotary' || t === 'roundabout turn') return m.exit ? `Na rotatória, pegue a ${m.exit}ª saída${on}` : 'Entre na rotatória';
  if (t === 'fork') return `Mantenha-se à ${side(mod)}${on}`;
  if (t === 'on ramp') return `Pegue o acesso à ${side(mod)}${on}`;
  if (t === 'off ramp') return `Pegue a saída à ${side(mod)}${on}`;
  if (t === 'merge') return 'Entre' + (on || ' na via');
  if (t === 'turn' || t === 'end of road' || t === 'new name') {
    if (mod === 'straight') return t === 'new name' ? null : 'Siga em frente' + on;
    if (t === 'new name') return null;
    if (/slight/.test(mod)) return `Curva leve à ${side(mod)}${on}`;
    if (/sharp/.test(mod)) return `Curva fechada à ${side(mod)}${on}`;
    return `Vire à ${side(mod)}${on}`;
  }
  return null;                                  // continue, notification etc.
}

// Junta os passos de todos os trechos numa lista.
export function osrmSteps(legs: any[]): Step[] {
  const out: Step[] = [];
  for (const leg of legs || []) for (const st of leg.steps || []) {
    const text = maneuverText(st, !out.length);
    if (text && st.maneuver && st.maneuver.location) out.push({ at: [st.maneuver.location[1], st.maneuver.location[0]], text });
  }
  return out;
}

// Posição (m) de cada passo ao longo da linha, sempre avançando (a rota pode passar duas vezes pelo mesmo lugar).
export function placeSteps(steps: Step[], coords: number[][]): Step[] {
  const cum = cumulative(coords);
  let from = 0;
  const out: Step[] = [];
  for (const s of steps) {
    const p = { lat: s.at[0], lon: s.at[1] };
    let best: { d: number; t: number; i: number } | null = null;
    for (let i = from; i + 1 < coords.length; i++) {
      const g = segDist(p, coords[i], coords[i + 1]);
      if (!best || g.d < best.d) best = { ...g, i };
      if (g.d < 15) break;
    }
    if (!best || best.d > 60) continue;
    from = best.i;
    out.push({ ...s, m: Math.round(cum[best.i] + best.t * (cum[best.i + 1] - cum[best.i])) });
  }
  return out;
}

// Sem OSRM: acha as curvas pela linha (ângulo entre 30 m antes e 30 m depois), sem nome de rua.
export function stepsFromCoords(coords: number[][]): Step[] {
  const cum = cumulative(coords), out: Step[] = [];
  const bear = (a: number[], b: number[]) => Math.atan2((b[1] - a[1]) * Math.cos(a[0] * Math.PI / 180), b[0] - a[0]) * 180 / Math.PI;
  let last = -1e9;
  for (let i = 1; i < coords.length - 1; i++) {
    let a = i; while (a > 0 && cum[i] - cum[a] < 30) a--;
    let b = i; while (b < coords.length - 1 && cum[b] - cum[i] < 30) b++;
    const d = ((bear(coords[i], coords[b]) - bear(coords[a], coords[i]) + 540) % 360) - 180;
    const ad = Math.abs(d);
    if (ad < 35 || cum[i] - last < 40) continue;
    const dir = d > 0 ? 'direita' : 'esquerda';
    out.push({ m: Math.round(cum[i]), at: [coords[i][0], coords[i][1]], text: ad > 150 ? 'Faça o retorno' : ad < 60 ? 'Curva leve à ' + dir : ad > 120 ? 'Curva fechada à ' + dir : 'Vire à ' + dir });
    last = cum[i];
  }
  return out;
}

export const metersSpoken = (m: number) => (m >= 950 ? (Math.round(m / 100) / 10).toString().replace('.', ',') + ' quilômetros' : Math.max(10, Math.round(m / 10) * 10) + ' metros');
export const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

const stepCache = new WeakMap<object, Step[]>();
export function routeSteps(geo: { coords: number[][]; steps?: Step[] | null }) {
  let s = stepCache.get(geo);
  if (!s) { s = geo.steps && geo.steps.length ? geo.steps : stepsFromCoords(geo.coords); stepCache.set(geo, s); }
  return s;
}

// Qual aviso falar agora (ou null): a próxima manobra com antecedência e de novo quando está perto.
export function nextAnnouncement(steps: Step[], pos: number, speedMs: number, said: Set<string>): string | null {
  const s = steps.find(x => (x.m ?? 0) - pos > -15);
  if (!s) return null;
  const dist = (s.m ?? 0) - pos, id = s.text + '|' + s.at[0].toFixed(4) + ',' + s.at[1].toFixed(4);
  const far = Math.min(400, Math.max(150, (speedMs || 0) * 12));
  if (dist <= 45 && !said.has('b' + id)) { said.add('b' + id); said.add('a' + id); return s.text; }
  if (dist <= far && !said.has('a' + id)) { said.add('a' + id); return `Em ${metersSpoken(dist)}, ${lowerFirst(s.text)}`; }
  return null;
}
