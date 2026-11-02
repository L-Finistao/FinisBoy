/* Boneco do motoboy: desenhado em SVG a partir de uma "aparência" (look). A mesma função serve para o React (perfil, cartões)
   e para o marcador do mapa (Leaflet). Itens abrem por nível do jogador ou por conquista. */

export interface Unlockable { name: string; lvl: number; ach?: string; e?: string }
export const isUnlocked = (u: Unlockable, level: number, unlockedAch: string[]) => level >= u.lvl && (!u.ach || unlockedAch.includes(u.ach));
export const unlockHint = (u: Unlockable) => (u.ach ? 'conquista' : `nv ${u.lvl}`);

export interface Look { skin: string; hair: string; hairColor: string; outfit: string; helmet: string; glasses: string; bag: string; vehicle: string; vcolor: string }
export const DEFAULT_LOOK: Look = { skin: '#f1c27d', hair: 'curto', hairColor: '#3b2a1a', outfit: '#f0d522', helmet: 'aberto', glasses: '', bag: 'bau', vehicle: 'bike', vcolor: '#e84b31' };

export type Item = Unlockable & { id: string };
export type Swatch = Unlockable & { id: string; color: string };
export const SKINS: Swatch[] = ['#fde2c4', '#f1c27d', '#d9a066', '#b97a4b', '#8d5524', '#5c3a1e'].map(c => ({ id: c, color: c, name: 'Tom de pele', lvl: 1 }));
export const HAIR_COLORS: Swatch[] = [['#1b1b1b', 'Preto'], ['#3b2a1a', 'Castanho'], ['#c2812a', 'Loiro escuro'], ['#e8c26a', 'Loiro'], ['#b03a2e', 'Ruivo'], ['#7c3aed', 'Roxo'], ['#54c5f1', 'Azul']]
  .map(([c, n], i) => ({ id: c, color: c, name: n, lvl: i < 5 ? 1 : 7 }));
export const HAIRS: Item[] = [
  { id: 'curto', name: 'Curto', lvl: 1 }, { id: 'careca', name: 'Careca', lvl: 1 }, { id: 'longo', name: 'Rabo de cavalo', lvl: 1 },
  { id: 'cacheado', name: 'Cacheado', lvl: 2 }, { id: 'moicano', name: 'Moicano', lvl: 5 },
];
export const OUTFITS: Swatch[] = [
  { id: '#f0d522', color: '#f0d522', name: 'Amarelo Turbo', lvl: 1 }, { id: '#e84b31', color: '#e84b31', name: 'Vermelho Nitro', lvl: 1 },
  { id: '#0d0a31', color: '#0d0a31', name: 'Azul Profundo', lvl: 1 }, { id: '#a1d835', color: '#a1d835', name: 'Verde Molusco', lvl: 1 },
  { id: '#54c5f1', color: '#54c5f1', name: 'Ciano', lvl: 3 }, { id: '#f4f5f9', color: '#f4f5f9', name: 'Branco', lvl: 3 },
  { id: '#d4a017', color: '#d4a017', name: 'Ouro', lvl: 10 }, { id: '#9b5de5', color: '#9b5de5', name: 'Neon', lvl: 15 },
];
export const HELMETS: Item[] = [
  { id: 'aberto', name: 'Capacete aberto', lvl: 1 }, { id: 'bone', name: 'Boné', lvl: 1 }, { id: '', name: 'Sem capacete', lvl: 1 },
  { id: 'fechado', name: 'Integral', lvl: 4 }, { id: 'asas', name: 'Alado', lvl: 8 }, { id: 'chamas', name: 'Chamas', lvl: 1, ach: 's7' },
  { id: 'dourado', name: 'Dourado', lvl: 14 },
];
export const GLASSES: Item[] = [{ id: '', name: 'Sem óculos', lvl: 1 }, { id: 'goggles', name: 'Óculos de piloto', lvl: 3 }, { id: 'sol', name: 'Óculos escuros', lvl: 6 }];
export const BAGS: Item[] = [
  { id: '', name: 'Sem bolsa', lvl: 1 }, { id: 'bau', name: 'Baú de entrega', lvl: 1 }, { id: 'mochila', name: 'Mochila', lvl: 5 },
  { id: 'termica', name: 'Bag térmica', lvl: 1, ach: 'd100' },
];
export const VEHICLES: Item[] = [
  { id: 'bike', name: 'Bicicleta', lvl: 1 }, { id: 'scooter', name: 'Scooter', lvl: 3 }, { id: 'moto', name: 'Moto', lvl: 6 },
  { id: 'esportiva', name: 'Esportiva', lvl: 10 }, { id: 'lesma', name: 'Lesma Turbo', lvl: 18 },
];
export const VEHICLE_COLORS: Swatch[] = OUTFITS.map(o => ({ ...o }));

const INK = '#0d0a31';
const wheel = (x: number, y: number, r: number) =>
  `<circle cx="${x}" cy="${y}" r="${r}" fill="#1c1a3a"/><circle cx="${x}" cy="${y}" r="${r * 0.55}" fill="#cfd2e6"/><circle cx="${x}" cy="${y}" r="${r * 0.15}" fill="${INK}"/>`;

// Veículo + altura (dy) em que o piloto senta. Desenhado de lado, virado para a direita.
function vehicle(id: string, c: string): { svg: string; dy: number } {
  switch (id) {
    case 'scooter': return { dy: 6, svg: `${wheel(28, 72, 10)}${wheel(98, 72, 10)}
      <path d="M26 72 L40 72 Q44 58 62 58 L88 58 L98 72 Z" fill="${c}" stroke="${INK}" stroke-width="2"/>
      <path d="M90 60 L86 34" stroke="${INK}" stroke-width="4" stroke-linecap="round"/><path d="M80 33 H92" stroke="${INK}" stroke-width="4" stroke-linecap="round"/>
      <rect x="32" y="50" width="26" height="6" rx="3" fill="${INK}"/>` };
    case 'moto': return { dy: 4, svg: `${wheel(26, 70, 14)}${wheel(96, 70, 14)}
      <path d="M96 70 L84 44" stroke="${INK}" stroke-width="3.5" stroke-linecap="round"/><path d="M78 42 H92" stroke="${INK}" stroke-width="4" stroke-linecap="round"/>
      <path d="M38 50 Q52 40 76 46 L86 56 L40 60 Z" fill="${c}" stroke="${INK}" stroke-width="2"/>
      <rect x="44" y="58" width="34" height="10" rx="2" fill="${INK}"/><rect x="28" y="48" width="20" height="5" rx="2.5" fill="${INK}"/>
      <path d="M12 68 H48" stroke="#9aa0b8" stroke-width="3" stroke-linecap="round"/>` };
    case 'esportiva': return { dy: 6, svg: `${wheel(26, 70, 14)}${wheel(98, 70, 14)}
      <path d="M98 70 L88 48" stroke="${INK}" stroke-width="3.5" stroke-linecap="round"/>
      <path d="M26 50 L50 52 Q60 38 84 44 L104 62 L90 64 L44 64 Z" fill="${c}" stroke="${INK}" stroke-width="2"/>
      <path d="M80 44 L90 36 L96 48 Z" fill="#54c5f1" stroke="${INK}" stroke-width="1.5"/>
      <rect x="46" y="60" width="30" height="9" rx="2" fill="${INK}"/><path d="M10 66 H44" stroke="#9aa0b8" stroke-width="3" stroke-linecap="round"/>` };
    case 'lesma': return { dy: -10, svg: `
      <path d="M2 64 L16 58 L12 66 L22 70 L8 72 Z" fill="#f59e0b"/><path d="M6 66 L16 63 L14 68 Z" fill="#fde047"/>
      <path d="M14 76 Q50 66 104 72 Q114 66 110 56 Q108 50 100 52 L96 62 Q60 62 22 66 Z" fill="#a1d835" stroke="${INK}" stroke-width="2"/>
      <path d="M104 54 L102 40 M110 56 L116 44" stroke="${INK}" stroke-width="2.5" stroke-linecap="round"/><circle cx="102" cy="39" r="3" fill="#fff" stroke="${INK}"/><circle cx="116" cy="43" r="3" fill="#fff" stroke="${INK}"/>
      <circle cx="52" cy="52" r="24" fill="${c}" stroke="${INK}" stroke-width="2.5"/><circle cx="52" cy="52" r="15" fill="none" stroke="${INK}" stroke-width="2" opacity=".5"/><circle cx="52" cy="52" r="7" fill="#54c5f1" stroke="${INK}" stroke-width="2"/>` };
    default: return { dy: 0, svg: `${wheel(26, 70, 14)}${wheel(96, 70, 14)}
      <path d="M26 70 L50 70 L64 48 L88 48 L96 70 M50 70 L44 44 M88 48 L84 36" stroke="${c}" stroke-width="3.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
      <path d="M78 35 H92" stroke="${INK}" stroke-width="4" stroke-linecap="round"/><rect x="36" y="42" width="16" height="5" rx="2.5" fill="${INK}"/>` };
  }
}

const hairSvg = (style: string, c: string) => (({
  curto: `<path d="M46 13 Q46 3 56 3 Q66 4 64 13 Q58 8 46 13Z" fill="${c}"/>`,
  longo: `<path d="M46 13 Q46 3 56 3 Q66 4 64 13 Q58 8 46 13Z" fill="${c}"/><path d="M47 10 Q36 12 38 26 Q44 22 48 14Z" fill="${c}"/>`,
  cacheado: `<g fill="${c}"><circle cx="48" cy="9" r="5"/><circle cx="54" cy="4" r="5.5"/><circle cx="61" cy="6" r="5"/><circle cx="64" cy="12" r="4"/><circle cx="46" cy="14" r="4"/></g>`,
  moicano: `<path d="M48 8 L50 -2 L54 5 L57 -3 L61 5 L64 0 L63 9 Z" fill="${c}"/>`,
} as Record<string, string>)[style] || '');

const helmetSvg = (id: string) => (({
  aberto: `<path d="M45 14 Q44 1 56 1 Q67 2 66 14 L45 14Z" fill="#e84b31" stroke="${INK}" stroke-width="1.5"/><path d="M47 15 L47 22" stroke="${INK}" stroke-width="1.5"/>`,
  bone: `<path d="M45 11 Q46 1 56 1 Q65 2 65 11 Z" fill="${INK}"/><path d="M62 10 L76 12 L63 14Z" fill="${INK}"/>`,
  fechado: `<path d="M44 14 Q43 1 56 1 Q68 2 67 16 L65 22 L48 22 Q44 20 44 14Z" fill="${INK}" stroke="#54c5f1" stroke-width="1"/><path d="M55 7 L67 7 L66 15 L55 15Z" fill="#54c5f1"/>`,
  asas: `<path d="M45 14 Q44 1 56 1 Q67 2 66 14 L45 14Z" fill="#e84b31" stroke="${INK}" stroke-width="1.5"/><path d="M46 8 Q32 0 28 -4 Q36 -2 34 4 Q40 2 38 8 Q43 6 46 10Z" fill="#fff" stroke="${INK}" stroke-width="1.2"/>`,
  chamas: `<path d="M45 14 Q44 1 56 1 Q67 2 66 14 L45 14Z" fill="#e84b31" stroke="${INK}" stroke-width="1.5"/><path d="M47 9 Q52 2 56 7 Q58 1 64 6 Q56 12 47 9Z" fill="#fbbf24"/>`,
  dourado: `<path d="M45 14 Q44 1 56 1 Q67 2 66 14 L45 14Z" fill="#f0d522" stroke="${INK}" stroke-width="1.5"/><path d="M50 2 L56 -4 L62 2" fill="#f0d522" stroke="${INK}" stroke-width="1.5"/>`,
} as Record<string, string>)[id] || '');

const bagSvg = (id: string) => (({
  bau: `<rect x="20" y="14" width="24" height="25" rx="3" fill="#e84b31" stroke="${INK}" stroke-width="2"/><path d="M20 22 H44" stroke="${INK}" stroke-width="1.5"/>`,
  mochila: `<rect x="31" y="18" width="14" height="24" rx="6" fill="#54c5f1" stroke="${INK}" stroke-width="2"/><path d="M33 28 H43" stroke="${INK}" stroke-width="1.5"/>`,
  termica: `<rect x="16" y="8" width="28" height="30" rx="4" fill="#f0d522" stroke="${INK}" stroke-width="2"/><path d="M16 18 H44" stroke="${INK}" stroke-width="2"/><circle cx="30" cy="28" r="4" fill="#e84b31"/>`,
} as Record<string, string>)[id] || '');

/** SVG completo (string). `height` em px; a largura acompanha a proporção. */
export function riderSvg(look: Partial<Look> = {}, height = 64): string {
  const L = { ...DEFAULT_LOOK, ...look };
  const v = vehicle(L.vehicle, L.vcolor);
  const fullHelmet = ['fechado', 'asas', 'chamas', 'dourado', 'aberto'].includes(L.helmet);
  const hair = !fullHelmet && L.hair ? hairSvg(L.hair, L.hairColor) : '';
  const tail = fullHelmet && L.hair === 'longo' ? hairSvg('longo', L.hairColor) : '';   // rabo de cavalo aparece atrás do capacete
  const face = L.helmet === 'fechado' ? '' : `${L.glasses === 'goggles'
    ? `<path d="M46 11 H55" stroke="${INK}" stroke-width="2"/><rect x="55" y="7.5" width="11" height="7" rx="3.5" fill="#54c5f1" stroke="${INK}" stroke-width="1.5"/>`
    : L.glasses === 'sol' ? `<rect x="55" y="8" width="11" height="6" rx="2" fill="${INK}"/><path d="M47 10 H55" stroke="${INK}" stroke-width="1.5"/>`
    : `<circle cx="60" cy="11" r="1.4" fill="${INK}"/>`}<path d="M58 17 Q61 19 64 16" stroke="${INK}" stroke-width="1.3" fill="none" stroke-linecap="round"/>`;
  const rider = `<g transform="translate(0 ${v.dy})">
    ${bagSvg(L.bag)}
    <path d="M48 42 L64 48 L60 64" stroke="${INK}" stroke-width="7" stroke-linecap="round" stroke-linejoin="round" fill="none"/><circle cx="62" cy="65" r="4" fill="#fff" stroke="${INK}" stroke-width="1.5"/>
    <path d="M40 44 L44 22 Q50 18 58 24 L56 44 Z" fill="${L.outfit}" stroke="${INK}" stroke-width="1.8" stroke-linejoin="round"/>
    <path d="M52 27 L68 34 L80 36" stroke="${INK}" stroke-width="8" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
    <path d="M52 27 L68 34 L80 36" stroke="${L.outfit}" stroke-width="5" stroke-linecap="round" stroke-linejoin="round" fill="none"/><circle cx="81" cy="36" r="3.6" fill="${L.skin}" stroke="${INK}" stroke-width="1.2"/>
    <rect x="52" y="19" width="6" height="6" fill="${L.skin}"/>
    ${tail}
    <circle cx="55" cy="13" r="9" fill="${L.skin}" stroke="${INK}" stroke-width="1.6"/>
    ${hair}${face}${helmetSvg(L.helmet)}
  </g>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-4 -10 128 100" height="${height}" width="${Math.round(height * 1.28)}" aria-hidden="true">${v.svg}${rider}</svg>`;
}
