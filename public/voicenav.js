'use strict';

/* Instruções de rota faladas, curva a curva ("Em 200 metros, vire à direita na Rua X").
   Os passos vêm do OSRM (com nome da rua). Sem OSRM (modo offline) as curvas são achadas pela própria linha da rota.
   Usa say/voice de voice.js e as globais de live.js/app.js na hora de executar. */

const side = m => (/left/.test(m || '') ? 'esquerda' : 'direita');
const onSt = n => (n ? ' na ' + n : '');

// Texto falado de uma manobra do OSRM (null = não vale falar).
function maneuverText(st, first) {
  const m = st.maneuver || {}, n = (st.name || '').trim(), t = m.type, mod = m.modifier || '', on = onSt(n);
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

// Junta os passos de todos os trechos numa lista [{ at:[lat,lon], text }].
function osrmSteps(legs) {
  const out = [];
  for (const leg of legs || []) for (const st of leg.steps || []) {
    const text = maneuverText(st, !out.length);
    if (text && st.maneuver && st.maneuver.location) out.push({ at: [st.maneuver.location[1], st.maneuver.location[0]], text });
  }
  return out;
}

// Posição (m) de cada passo ao longo da linha, sempre avançando (a rota pode passar duas vezes pelo mesmo lugar).
function placeSteps(steps, coords) {
  const cum = cumulative(coords);
  let from = 0;
  const out = [];
  for (const s of steps) {
    const p = { lat: s.at[0], lon: s.at[1] };
    let best = null;
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
function stepsFromCoords(coords) {
  const cum = cumulative(coords), out = [];
  const bear = (a, b) => Math.atan2((b[1] - a[1]) * Math.cos(a[0] * Math.PI / 180), b[0] - a[0]) * 180 / Math.PI;
  let last = -1e9;
  for (let i = 1; i < coords.length - 1; i++) {
    let a = i; while (a > 0 && cum[i] - cum[a] < 30) a--;
    let b = i; while (b < coords.length - 1 && cum[b] - cum[i] < 30) b++;
    const d = ((bear(coords[i], coords[b]) - bear(coords[a], coords[i]) + 540) % 360) - 180;
    const ad = Math.abs(d);
    if (ad < 35 || cum[i] - last < 40) continue;
    const dir = d > 0 ? 'direita' : 'esquerda';
    out.push({ m: Math.round(cum[i]), at: coords[i], text: ad > 150 ? 'Faça o retorno' : ad < 60 ? 'Curva leve à ' + dir : ad > 120 ? 'Curva fechada à ' + dir : 'Vire à ' + dir });
    last = cum[i];
  }
  return out;
}

const metersSpoken = m => (m >= 950 ? (Math.round(m / 100) / 10).toString().replace('.', ',') + ' quilômetros' : Math.max(10, Math.round(m / 10) * 10) + ' metros');
const lowerFirst = s => s.charAt(0).toLowerCase() + s.slice(1);
let navSaid = new Set(), navStepsFor = null, navSteps = [];

function routeSteps(geo) {
  if (navStepsFor !== geo) { navStepsFor = geo; navSteps = geo.steps && geo.steps.length ? geo.steps : stepsFromCoords(geo.coords); }
  return navSteps;
}

// Chamada a cada posição (liveProgress): avisa a próxima manobra com antecedência e de novo quando está perto.
function voiceNav(geo, near, speedMs) {
  if (!voice.speak || !voice.nav || !geo || !geo.coords || near.d > 80) return;
  const cum = cumulative(geo.coords);
  const pos = cum[near.i] + near.t * (cum[near.i + 1] - cum[near.i]);
  const steps = routeSteps(geo);
  const s = steps.find(x => x.m - pos > -15);
  if (!s) return;
  const dist = s.m - pos, id = s.text + '|' + s.at[0].toFixed(4) + ',' + s.at[1].toFixed(4);
  const far = Math.min(400, Math.max(150, (speedMs || 0) * 12));
  if (dist <= 45 && !navSaid.has('b' + id)) { navSaid.add('b' + id); navSaid.add('a' + id); say(s.text, null, true); }
  else if (dist <= far && !navSaid.has('a' + id)) { navSaid.add('a' + id); say(`Em ${metersSpoken(dist)}, ${lowerFirst(s.text)}`, null, true); }
}

// Fala as próximas manobras de uma vez (botão 🔊 ou "Turbo, falar a rota").
function voiceRoute() {
  const r = session || cur();
  if (!r || !r.geo || !r.geo.coords) { say('Ainda não há rota calculada.'); return; }
  const cum = cumulative(r.geo.coords), total = cum[cum.length - 1];
  let pos = 0;
  if (me) { const n = nearestOnRoute(me, r.geo.coords); if (n.d < 150) pos = cum[n.i] + n.t * (cum[n.i + 1] - cum[n.i]); }
  const left = Math.max(0, total - pos);
  const next = routeSteps(r.geo).filter(s => s.m - pos > -15).slice(0, 5);
  const parts = [`A rota tem ${fmtDist(left)} e ${fmtDur(r.geo.duration * (left / Math.max(total, 1)))}.`];
  let prev = pos;
  for (const s of next) { parts.push(`Siga ${metersSpoken(Math.max(s.m - prev, 10))}, depois ${lowerFirst(s.text)}.`); prev = s.m; }
  if (!next.length) parts.push('Siga em frente até a parada.');
  say(parts.join(' '), null, true);
}
