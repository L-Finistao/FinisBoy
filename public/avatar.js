'use strict';

/* Personagem do mapa: o ícone que representa você. Desenhos vistos de cima (apontam para a frente e giram
   conforme a direção do GPS), em SVG: ficam nítidos em qualquer tamanho e funcionam sem internet.
   Escolha em ⚙ Configurações. Usa as globais de app.js (me, meMarker, map, DB). */

const AV_COLORS = ['#FF6B00', '#2563eb', '#16a34a', '#9333ea', '#dc2626', '#FFB400', '#14233C'];
const AV_STROKE = '#14233C';

// Cada desenho cabe em 48 x 48, com a frente para cima. `c` é a cor escolhida.
const AV_KINDS = {
  moto: { label: 'Moto', svg: c => `
    <rect x="21" y="6" width="6" height="11" rx="3" fill="#1f2937"/>
    <rect x="21" y="32" width="6" height="11" rx="3" fill="#1f2937"/>
    <rect x="10" y="14" width="28" height="4" rx="2" fill="${AV_STROKE}"/>
    <rect x="19" y="14" width="10" height="26" rx="5" fill="${c}" stroke="${AV_STROKE}" stroke-width="1.5"/>
    <rect x="16" y="34" width="16" height="10" rx="2" fill="#fff" stroke="${AV_STROKE}" stroke-width="1.5"/>
    <circle cx="24" cy="24" r="6" fill="#fff" stroke="${AV_STROKE}" stroke-width="1.5"/>` },
  carro: { label: 'Carro', svg: c => `
    <rect x="9" y="9" width="6" height="9" rx="2" fill="#1f2937"/><rect x="33" y="9" width="6" height="9" rx="2" fill="#1f2937"/>
    <rect x="9" y="31" width="6" height="9" rx="2" fill="#1f2937"/><rect x="33" y="31" width="6" height="9" rx="2" fill="#1f2937"/>
    <rect x="12" y="4" width="24" height="40" rx="9" fill="${c}" stroke="${AV_STROKE}" stroke-width="1.5"/>
    <path d="M15 17 Q24 12 33 17 L32 22 L16 22 Z" fill="#bfe3ff" stroke="${AV_STROKE}" stroke-width="1"/>
    <rect x="15" y="24" width="18" height="10" rx="2" fill="#fff" opacity=".35"/>
    <path d="M16 36 L32 36 L31 40 L17 40 Z" fill="#bfe3ff" stroke="${AV_STROKE}" stroke-width="1"/>
    <circle cx="16" cy="6.5" r="1.8" fill="#FFE27A"/><circle cx="32" cy="6.5" r="1.8" fill="#FFE27A"/>` },
  nave: { label: 'Nave', svg: c => `
    <path d="M24 2 L30 20 L44 34 L44 40 L30 36 L27 44 L21 44 L18 36 L4 40 L4 34 L18 20 Z" fill="${c}" stroke="${AV_STROKE}" stroke-width="1.5" stroke-linejoin="round"/>
    <path d="M24 8 L27 22 L24 26 L21 22 Z" fill="#bfe3ff" stroke="${AV_STROKE}" stroke-width="1"/>
    <path d="M4 34 L18 20 L18 36 L4 40 Z" fill="#000" opacity=".12"/><path d="M44 34 L30 20 L30 36 L44 40 Z" fill="#000" opacity=".12"/>
    <path d="M21 44 L24 49 L27 44 Z" fill="#FFB400"/>` },
  ufo: { label: 'Disco voador', svg: c => `
    <ellipse cx="24" cy="26" rx="21" ry="12" fill="#cbd5e1" stroke="${AV_STROKE}" stroke-width="1.5"/>
    <ellipse cx="24" cy="26" rx="14" ry="7" fill="${c}" stroke="${AV_STROKE}" stroke-width="1.2"/>
    <ellipse cx="24" cy="19" rx="8" ry="9" fill="#bfe3ff" stroke="${AV_STROKE}" stroke-width="1.2"/>
    <circle cx="9" cy="27" r="2" fill="#FFE27A"/><circle cx="24" cy="35" r="2" fill="#FFE27A"/><circle cx="39" cy="27" r="2" fill="#FFE27A"/>` },
  foguete: { label: 'Foguete', svg: c => `
    <path d="M24 2 C33 10 34 22 32 34 L16 34 C14 22 15 10 24 2 Z" fill="#fff" stroke="${AV_STROKE}" stroke-width="1.5"/>
    <path d="M16 26 L7 40 L17 36 Z M32 26 L41 40 L31 36 Z" fill="${c}" stroke="${AV_STROKE}" stroke-width="1.5" stroke-linejoin="round"/>
    <circle cx="24" cy="17" r="5" fill="#bfe3ff" stroke="${AV_STROKE}" stroke-width="1.2"/>
    <path d="M24 2 C28 6 30 10 31 14 L17 14 C18 10 20 6 24 2 Z" fill="${c}"/>
    <path d="M19 34 L24 47 L29 34 Z" fill="#FFB400" stroke="#FF6B00" stroke-width="1"/>` },
  ponto: { label: 'Ponto', svg: c => `
    <circle cx="24" cy="24" r="20" fill="${c}" opacity=".25"/><circle cx="24" cy="24" r="9" fill="${c}" stroke="#fff" stroke-width="3"/>` },
};

let avatar = { kind: 'moto', color: '#FF6B00' };
let meHeading = 0;

const avatarSvg = (a, size) => `<svg viewBox="0 0 48 48" width="${size}" height="${size}" aria-hidden="true">${(AV_KINDS[a.kind] || AV_KINDS.moto).svg(a.color)}</svg>`;

async function avatarInit() {
  const a = await DB.get('avatar');
  if (a && AV_KINDS[a.kind]) avatar = { kind: a.kind, color: AV_COLORS.includes(a.color) ? a.color : avatar.color };
}

// Ícone do mapa: só o desenho gira (o marcador fica parado), para a direção do GPS apontar a frente do veículo.
function avatarIcon() {
  const rot = avatar.kind === 'ponto' || avatar.kind === 'ufo' ? 0 : meHeading;
  return L.divIcon({
    className: '', iconSize: [44, 44], iconAnchor: [22, 22],
    html: `<div class="avatar" style="transform:rotate(${rot}deg)">${avatarSvg(avatar, 44)}</div>`,
  });
}

function avatarRefresh() {
  if (typeof meMarker !== 'undefined' && meMarker) meMarker.setIcon(avatarIcon());
}

/* ---------- Painel de configuração ---------- */
let avatarDraft = null;

function avatarEditorRender() {
  const d = avatarDraft;
  $('avKinds').innerHTML = Object.entries(AV_KINDS).map(([k, v]) =>
    `<button type="button" class="av-kind ${k === d.kind ? 'on' : ''}" data-kind="${k}" title="${v.label}">${avatarSvg({ kind: k, color: d.color }, 44)}<span>${v.label}</span></button>`).join('');
  $('avColors').innerHTML = AV_COLORS.map(c =>
    `<button type="button" class="av-color ${c === d.color ? 'on' : ''}" data-color="${c}" style="background:${c}" aria-label="Cor ${c}"></button>`).join('');
}

function avatarEditorOpen() {
  avatarDraft = { ...avatar };
  avatarEditorRender();
}

function avatarEditorSave() {
  if (!avatarDraft) return;
  avatar = { ...avatarDraft };
  DB.set('avatar', avatar);
  avatarRefresh();
}

function avatarBind() {
  $('avKinds').onclick = e => { const b = e.target.closest('[data-kind]'); if (b) { avatarDraft.kind = b.dataset.kind; avatarEditorRender(); } };
  $('avColors').onclick = e => { const b = e.target.closest('[data-color]'); if (b) { avatarDraft.color = b.dataset.color; avatarEditorRender(); } };
}
