import { haversine, sleep } from './format';
import { norm, splitAddr, stripType } from './text';
import type { LatLon, Precision, Stop } from './types';

/* Localização de endereços: várias fontes, tolerante a erros de digitação.
   1) cache  2) ViaCEP: corrige o nome da rua (e acha o CEP certo)  3) Nominatim: ponto da casa
   4) Photon: busca aproximada  5) CEP (BrasilAPI) */

export interface GeoResult { lat: number; lon: number; label: string; precision: Precision; approx: boolean; src: string }
export interface GeoCtx {
  city: string;                          // cidade/UF padrão das configurações
  me: LatLon | null;                     // posição atual (desempata e limita a busca)
  cache: Record<string, any>;            // endereço -> resultado; guardado no aparelho
  save: () => void;                      // persiste o cache
}

const lastCall: Record<string, number> = {};
async function gate(host: string, ms: number) {
  const w = (lastCall[host] || 0) + ms - Date.now();
  if (w > 0) await sleep(w);
  lastCall[host] = Date.now();
}

async function getJSON(url: string, host: string, ms: number): Promise<any> {
  for (let i = 0; i < 3; i++) {
    await gate(host, ms);
    const ctl = new AbortController(), tm = setTimeout(() => ctl.abort(), 12000);
    let r: Response;
    try { r = await fetch(url, { signal: ctl.signal }); } finally { clearTimeout(tm); }
    if (r.status === 429 || r.status >= 500) { await sleep(1500 * (i + 1)); continue; }   // servidor ocupado: espera e tenta de novo
    if (r.status === 400 || r.status === 404) return null;
    if (!r.ok) throw new Error(host + ' ' + r.status);
    return r.json();
  }
  throw new Error(host + ' ocupado');
}

const bigrams = (t: string) => { const a = new Set<string>(); for (let i = 0; i + 1 < t.length; i++) a.add(t.slice(i, i + 2)); return a; };
function similarity(a: string, b: string) {     // 0..1, tolera letras trocadas (Luís/Luiz, Moreti/Moretti)
  const A = bigrams(a), B = bigrams(b);
  if (!A.size || !B.size) return 0;
  let n = 0;
  for (const x of A) if (B.has(x)) n++;
  return 2 * n / (A.size + B.size);
}

function cityParts(str?: string) {              // "Birigui - SP" -> { name: 'Birigui', uf: 'SP' }
  const t = String(str || '').trim();
  const m = /^(.*?)[\s,/-]+([A-Za-z]{2})$/.exec(t);
  return m ? { name: m[1].trim(), uf: m[2].toUpperCase() } : { name: t, uf: '' };
}

// Sem cidade nas configurações nem no endereço, usa a cidade onde você está (pelo GPS): "Rua X, 100" existe em centenas de cidades.
export async function ensureAutoCity(ctx: GeoCtx) {
  const me = ctx.me;
  if (ctx.city || !me || !navigator.onLine) return;
  const ac = ctx.cache._auto;
  if (ac && haversine(ac, me) < 15000) return;
  try {
    const j = await getJSON(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=10&accept-language=pt-BR&lat=${me.lat}&lon=${me.lon}`, 'nom', 1100);
    const a = j && j.address, iso = a && a['ISO3166-2-lvl4'];
    const name = a && (a.city || a.town || a.municipality || a.village);
    if (name) { ctx.cache._auto = { lat: me.lat, lon: me.lon, text: iso ? `${name} - ${iso.split('-')[1]}` : name }; ctx.save(); }
  } catch { /* sem internet: segue sem cidade */ }
}

interface Fields { street: string; num: number | null; bairro: string; city: string; uf: string }

function addrFields(s: Pick<Stop, 'raw' | 'cityGuess'>, ctx: GeoCtx): Fields {
  const a = splitAddr(s.raw);
  const c = cityParts(ctx.city || s.cityGuess || (ctx.cache._auto && ctx.cache._auto.text));
  const uf = c.uf || ctx.cache._uf || '';
  let bairro = a.rest;
  if (c.name) bairro = bairro.replace(new RegExp(c.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*$', 'i'), '');
  bairro = bairro.replace(/^[\s\d]+/, '').trim();
  return { street: a.street.replace(/\s+/g, ' ').trim(), num: a.num, bairro, city: c.name, uf };
}

interface ViaCep { logradouro: string; bairro: string; cep: string; localidade?: string; uf?: string }

// Acha o nome oficial da rua (e CEP/bairro) mesmo com erro de digitação, usando ViaCEP.
async function resolveStreet(f: Fields, userCep: string | null) {
  const cands: ViaCep[] = [];
  const base = stripType(f.street);
  const nb = norm(f.bairro);
  const digits = String(userCep || '').replace(/\D/g, '');
  const score = (c: ViaCep) => {
    let sc = similarity(base, stripType(c.logradouro));
    if (nb && c.bairro && (norm(c.bairro).includes(nb) || nb.includes(norm(c.bairro)))) sc += 0.15;
    if (digits && c.cep && c.cep.replace(/\D/g, '') === digits) sc += 0.1;
    return sc;
  };
  const pickBest = () => {
    let best: ViaCep | null = null, bs = 0;
    for (const c of cands) { const sc = score(c); if (sc > bs) { bs = sc; best = c; } }
    return { best, bs };
  };

  if (f.uf && f.city && base.length >= 3) {
    // frase inteira; se não achar, cada palavra (a maior primeiro): uma palavra errada ("Teixrita") não atrapalha as outras
    const words = [...new Set(base.split(' '))].filter(w => w.length >= 3).sort((a, b) => b.length - a.length).slice(0, 3);
    for (const term of new Set([base, ...words])) {
      const list = await getJSON(`https://viacep.com.br/ws/${f.uf}/${encodeURIComponent(norm(f.city))}/${encodeURIComponent(term)}/json/`, 'cep', 150);
      if (Array.isArray(list)) cands.push(...list);
      if (pickBest().bs >= 0.75) break;                    // já achou uma rua bem parecida
    }
  }
  if (digits.length === 8) {
    const c = await getJSON(`https://viacep.com.br/ws/${digits}/json/`, 'cep', 150);
    if (c && !c.erro) cands.push(c);
  }
  const { best, bs } = pickBest();
  return best && bs >= 0.6 ? { name: best.logradouro, bairro: best.bairro, cep: String(best.cep || '').replace(/\D/g, '') } : null;
}

type NomResult = { lat: string; lon: string; display_name: string; address?: Record<string, string> };
const hasHouse = (r: NomResult) => !!(r.address && r.address.house_number);

function pickResult(list: NomResult[], bairros: string[], cityTxt: string, me: LatLon | null) {
  let l = list;
  if (cityTxt) {
    const f = l.filter(r => norm(r.display_name).includes(norm(cityTxt)));
    if (f.length) l = f;
  } else if (me) l = [...l].sort((x, y) => haversine(me, { lat: +x.lat, lon: +x.lon }) - haversine(me, { lat: +y.lat, lon: +y.lon }));
  for (const b of bairros) {
    const nb = norm(b);
    const hit = nb && l.find(r => norm(r.display_name).includes(nb));
    if (hit) return hit;
  }
  return l.find(hasHouse) || l[0] || null;
}

async function nominatim(q: string, me: LatLon | null): Promise<NomResult[]> {
  let url = 'https://nominatim.openstreetmap.org/search?format=jsonv2&addressdetails=1&limit=5&countrycodes=br&accept-language=pt-BR&q=' + encodeURIComponent(q);
  if (me) url += `&viewbox=${me.lon - 0.5},${me.lat + 0.5},${me.lon + 0.5},${me.lat - 0.5}`;
  return (await getJSON(url, 'nom', 1100)) || [];
}

const mk = (lat: number, lon: number, label: string, precision: Precision, src = 'online'): GeoResult => ({ lat, lon, label, precision, approx: precision !== 'house', src });

// CEP válido: 8 dígitos e não tudo zero (00000-000 é preenchimento de formulário).
const validCep = (c: unknown) => { const d = String(c || '').replace(/\D/g, ''); return d.length === 8 && !/^0+$/.test(d) ? d : ''; };

async function geocodeOnline(s: Pick<Stop, 'raw' | 'cep' | 'cityGuess'>, f: Fields, ctx: GeoCtx): Promise<GeoResult | null> {
  const me = ctx.me;
  // Com CEP válido no texto, ele manda: o ViaCEP dá rua, bairro e cidade certos, e a busca usa CEP + número.
  const cepD = validCep(s.cep);
  if (cepD) {
    let c: any = await getJSON(`https://viacep.com.br/ws/${cepD}/json/`, 'cep', 150);
    if (!c || c.erro || !c.logradouro) {                                                     // plano B: BrasilAPI (outras bases de CEP)
      const b = await getJSON(`https://brasilapi.com.br/api/cep/v2/${cepD}`, 'cep', 150).catch(() => null);
      c = b && b.street ? { logradouro: b.street, bairro: b.neighborhood, localidade: b.city, uf: b.state } : null;
    }
    if (c && c.logradouro) {
      const hy = cepD.slice(0, 5) + '-' + cepD.slice(5), cf: Fields = { ...f, street: c.logradouro, city: c.localidade || f.city, uf: c.uf || f.uf, bairro: c.bairro || f.bairro };
      const where = [cf.city, cf.uf].filter(Boolean).join(', ');
      for (const q of [[c.logradouro, f.num, c.bairro, where, hy], [c.logradouro, f.num, where]].map(a => a.filter(Boolean).join(', '))) {
        const pick = pickResult(await nominatim(q, me), [c.bairro].filter(Boolean), cf.city, me);
        if (pick && hasHouse(pick)) return mk(+pick.lat, +pick.lon, pick.display_name, 'house');
      }
      f = cf;                                                                                 // o resto da busca usa a rua/cidade do CEP
    }
  }
  const canon = await resolveStreet(f, s.cep);
  const street = canon ? canon.name : f.street.replace(/^R\.\s*/i, 'Rua ').replace(/^Av\.\s*/i, 'Avenida ');
  const bairros = [f.bairro, canon && canon.bairro].filter(Boolean) as string[];
  const where = [f.city, f.uf].filter(Boolean).join(', ');

  // Nominatim: tenta com número; sem resultado, só a rua
  for (const q of new Set([[street, f.num, where].filter(Boolean).join(', '), [street, where].filter(Boolean).join(', ')])) {
    const pick = pickResult(await nominatim(q, me), bairros, f.city, me);
    if (pick) {
      const iso = pick.address && pick.address['ISO3166-2-lvl4'];
      if (iso && !ctx.cache._uf) ctx.cache._uf = iso.split('-')[1];
      return mk(+pick.lat, +pick.lon, pick.display_name, hasHouse(pick) ? 'house' : 'street');
    }
  }

  // Photon: busca aproximada. Só quando o ViaCEP não confirmou a rua: se confirmou, o Photon acharia outra rua parecida
  // (Waldemar Vicente -> Waldemar Lot) e o ponto certo vem do CEP, logo abaixo.
  const pq = [street, f.city].filter(Boolean).join(', ');
  const ph = canon ? null : await getJSON(`https://photon.komoot.io/api/?limit=5&q=${encodeURIComponent(pq)}${me ? `&lat=${me.lat}&lon=${me.lon}` : ''}`, 'photon', 400);
  const feats = ((ph && ph.features) || []).filter((x: any) => (x.properties.countrycode || 'BR') === 'BR');
  const fc = feats.find((x: any) => !f.city || norm(x.properties.city || x.properties.county || '').includes(norm(f.city))) || null;
  if (fc && similarity(stripType(street), stripType(fc.properties.name || '')) >= 0.8) {
    const [lo, la] = fc.geometry.coordinates;
    return mk(la, lo, `${fc.properties.name}, ${fc.properties.city || ''}`, 'street');
  }

  // CEP: ponto aproximado da região (só usa o CEP se ele combina com a rua)
  const cep = canon && canon.cep ? canon.cep : String(s.cep || '').replace(/\D/g, '');
  if (cep.length === 8) {
    const b = await getJSON(`https://brasilapi.com.br/api/cep/v2/${cep}`, 'cep', 150);
    const c = b && b.location && b.location.coordinates;
    if (c && c.latitude && (canon || similarity(stripType(street), stripType(b.street || '')) >= 0.6)) {
      return mk(+c.latitude, +c.longitude, `CEP ${cep}${b.street ? ' – ' + b.street : ''}`, 'cep');
    }
  }
  return null;
}

// Devolve o ponto do endereço (ou null se não achou). Lança erro se não há internet para consultar.
export async function geocode(s: Pick<Stop, 'raw' | 'cep' | 'cityGuess'>, ctx: GeoCtx): Promise<GeoResult | null> {
  const f = addrFields(s, ctx);
  const key = 'g2|' + stripType(f.street) + '|' + (f.num ?? '') + '|' + norm(f.bairro) + '|' + norm(f.city) + '|' + validCep(s.cep);
  if (ctx.cache[key]) return ctx.cache[key];
  if (!navigator.onLine) throw new Error('offline');
  const res = await geocodeOnline(s, f, ctx);
  if (res) { ctx.cache[key] = res; ctx.save(); }
  return res;
}
