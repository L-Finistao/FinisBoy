'use strict';

// Leitura do texto do WhatsApp e geocodificação. Usa as globais 'city' e 'me' definidas em app.js.
/* ---------- Interpretação do texto do WhatsApp ---------- */
const WA_PREFIX = [
  /^\[\d{1,2}:\d{2}(:\d{2})?,\s*\d{1,2}\/\d{1,2}\/\d{2,4}\]\s*[^:]{1,40}:\s*/,   // [10:32, 30/10/2026] Nome:
  /^\d{1,2}\/\d{1,2}\/\d{2,4}[ ,]+\d{1,2}:\d{2}\s*-\s*[^:]{1,40}:\s*/,           // 30/10/2026 10:32 - Nome:
];

function cleanLine(line) {
  let l = line.trim();
  for (const re of WA_PREFIX) l = l.replace(re, '');
  l = l.replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}️]/gu, '').trim();
  l = l.replace(/^(\d+\s*[).\-–:]|[-•*])\s*/, '');
  l = l.replace(/^(endere[cç]o|entrega|destino|local|end)\s*[:\-]\s*/i, '');
  return l.trim();
}

// Cabeçalho de mensagem: "[29/10, 21:23] +55 18 99764-0397: ..." ou "29/10/2026 21:23 - Nome: ..."
const HEADERS = [
  /^\[(\d{1,2}\/\d{1,2}(?:\/\d{2,4})?),?\s+(\d{1,2}:\d{2})(?::\d{2})?\]\s*([^:]{1,40}?):\s*/,
  /^(\d{1,2}\/\d{1,2}(?:\/\d{2,4})?),?\s+(\d{1,2}:\d{2})(?::\d{2})?\s*-\s*([^:]{1,40}?):\s*/,
];

function matchHeader(line) {
  for (const re of HEADERS) {
    const m = re.exec(line);
    if (m) return { when: `${m[1]} ${m[2]}`, sender: m[3].trim(), rest: line.slice(m[0].length) };
  }
  return null;
}

// Uma mensagem pode ocupar várias linhas (continuação não tem cabeçalho).
function splitMessages(text) {
  const msgs = [];
  let cur = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const h = matchHeader(line);
    if (h) msgs.push(cur = { sender: h.sender, when: h.when, lines: [h.rest] });
    else if (cur && cur.sender) cur.lines.push(line);
    else msgs.push(cur = { sender: null, when: null, lines: [line] });   // texto sem cabeçalho: 1 linha = 1 endereço
  }
  return msgs;
}

function parseBody(lines) {
  const t = lines.map(cleanLine).filter(Boolean).join(' ').replace(/\s+/g, ' ');
  const cepM = /CEP:?\s*(\d{5})-?(\d{3})/i.exec(t);
  const cep = cepM && cepM[1] + cepM[2] !== '00000000' ? `${cepM[1]}-${cepM[2]}` : null;
  const ref = (/refer[eê]ncia:\s*(.*?)(?=\s*(?:Bairro:|CEP:|\|)|$)/i.exec(t) || [])[1] || '';
  const bairro = (/Bairro:\s*(.*?)(?=\s*(?:CEP:|\|)|$)/i.exec(t) || [])[1] || '';
  let main = t.split(/\s*-?\s*refer[eê]ncia:|\s*Bairro:|\s*\|/i)[0].trim();

  // "..., Birigui - SP Sobrado": o que vem depois da UF é observação (casa, fundos, apto...)
  let note = '', cityGuess = '';
  const uf = /^(.*?)\s-\s([A-Z]{2})\b\s*(.*)$/.exec(main);
  if (uf) {
    main = uf[1];
    note = uf[3];
    cityGuess = `${main.split(',').pop().trim()} - ${uf[2]}`;
  }
  if (bairro) {
    main += ', ' + bairro;
    if (!cityGuess) cityGuess = bairro.split(',').pop().trim();
  }
  const partes = main.split(',');
  if (!cityGuess && partes.length >= 3) cityGuess = partes[partes.length - 1].trim();   // "Rua X, 70, Bairro, Cidade"
  return { raw: main, note: [note, ref].filter(Boolean).join(' · '), cep, cityGuess };
}

function parseText(text) {
  return splitMessages(text)
    .map(m => ({ sender: m.sender, when: m.when, ...parseBody(m.lines) }))
    .filter(a => a.raw.length >= 6);
}

/* ---------- Localização de endereços: várias fontes, tolerante a erros de digitação ----------
   1) cache  2) ViaCEP: corrige o nome da rua (e acha o CEP certo)  3) Nominatim: ponto da casa
   4) Photon: busca aproximada  5) CEP (BrasilAPI)  6) pacote offline  */
const lastCall = {};
async function gate(host, ms) {
  const w = (lastCall[host] || 0) + ms - Date.now();
  if (w > 0) await sleep(w);
  lastCall[host] = Date.now();
}

async function getJSON(url, host, ms) {
  for (let i = 0; i < 3; i++) {
    await gate(host, ms);
    const ctl = new AbortController(), tm = setTimeout(() => ctl.abort(), 12000);
    let r;
    try { r = await fetch(url, { signal: ctl.signal }); } finally { clearTimeout(tm); }
    if (r.status === 429 || r.status >= 500) { await sleep(1500 * (i + 1)); continue; }   // servidor ocupado: espera e tenta de novo
    if (r.status === 400 || r.status === 404) return null;
    if (!r.ok) throw new Error(host + ' ' + r.status);
    return r.json();
  }
  throw new Error(host + ' ocupado');
}

const stripType = n => norm(n).split(' ').map(t => TOK[t] || t).filter(t => !TYPE_WORDS.has(t)).join(' ');
const bigrams = t => { const a = new Set(); for (let i = 0; i + 1 < t.length; i++) a.add(t.slice(i, i + 2)); return a; };
function similarity(a, b) {                     // 0..1, tolera letras trocadas (Luís/Luiz, Moreti/Moretti)
  const A = bigrams(a), B = bigrams(b);
  if (!A.size || !B.size) return 0;
  let n = 0;
  for (const x of A) if (B.has(x)) n++;
  return 2 * n / (A.size + B.size);
}

function cityParts(str) {                       // "Birigui - SP" -> { name: 'Birigui', uf: 'SP' }
  const t = String(str || '').trim();
  const m = /^(.*?)[\s,\/-]+([A-Za-z]{2})$/.exec(t);
  return m ? { name: m[1].trim(), uf: m[2].toUpperCase() } : { name: t, uf: '' };
}

// Sem cidade nas configurações nem no endereço, usa a cidade onde você está (pelo GPS): "Rua X, 100" existe em centenas de cidades.
async function ensureAutoCity() {
  if (city || !me || !navigator.onLine) return;
  const ac = geoCache._auto;
  if (ac && haversine(ac, me) < 15000) return;
  try {
    const j = await getJSON(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=10&accept-language=pt-BR&lat=${me.lat}&lon=${me.lon}`, 'nom', 1100);
    const a = j && j.address, iso = a && a['ISO3166-2-lvl4'];
    const name = a && (a.city || a.town || a.municipality || a.village);
    if (name) { geoCache._auto = { lat: me.lat, lon: me.lon, text: iso ? `${name} - ${iso.split('-')[1]}` : name }; saveGeoCache(); }
  } catch { /* sem internet: segue sem cidade */ }
}

function addrFields(s) {
  const a = splitAddr(s.raw);
  const c = cityParts(city || s.cityGuess || (geoCache._auto && geoCache._auto.text));
  const uf = c.uf || geoCache._uf || '';
  let bairro = a.rest;
  if (c.name) bairro = bairro.replace(new RegExp(c.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*$', 'i'), '');
  bairro = bairro.replace(/^[\s\d]+/, '').trim();
  return { street: a.street.replace(/\s+/g, ' ').trim(), num: a.num, bairro, city: c.name, uf };
}

// Acha o nome oficial da rua (e CEP/bairro) mesmo com erro de digitação, usando ViaCEP.
async function resolveStreet(f, userCep) {
  const cands = [];
  const base = stripType(f.street);
  const nb = norm(f.bairro);
  const digits = String(userCep || '').replace(/\D/g, '');
  const score = c => {
    let sc = similarity(base, stripType(c.logradouro));
    if (nb && c.bairro && (norm(c.bairro).includes(nb) || nb.includes(norm(c.bairro)))) sc += 0.15;
    if (digits && c.cep && c.cep.replace(/\D/g, '') === digits) sc += 0.1;
    return sc;
  };
  const pickBest = () => {
    let best = null, bs = 0;
    for (const c of cands) { const sc = score(c); if (sc > bs) { bs = sc; best = c; } }
    return { best, bs };
  };

  if (f.uf && f.city && base.length >= 3) {
    // frase inteira; se não achar, cada palavra (a maior primeiro): uma palavra errada ("Teixrita") não atrapalha as outras
    const words = [...new Set(base.split(' '))].filter(w => w.length >= 3).sort((a, b) => b.length - a.length).slice(0, 3);
    for (const term of [...new Set([base, ...words])]) {
      const list = await getJSON(`https://viacep.com.br/ws/${f.uf}/${encodeURIComponent(norm(f.city))}/${encodeURIComponent(term)}/json/`, 'cep', 150);
      if (Array.isArray(list)) cands.push(...list);
      if (pickBest().bs >= 0.75) break;                    // já achou uma rua bem parecida
    }
  }
  if (digits.length === 8) {
    const c = await getJSON(`https://viacep.com.br/ws/${digits}/json/`, 'cep', 150);
    if (c && !c.erro) cands.push({ ...c, _fromCep: true });
  }
  const { best, bs } = pickBest();
  return best && bs >= 0.6 ? { name: best.logradouro, bairro: best.bairro, cep: String(best.cep || '').replace(/\D/g, '') } : null;
}

const hasHouse = r => !!(r.address && r.address.house_number);

function pickResult(list, bairros, cityTxt) {
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

async function nominatim(q) {
  let url = 'https://nominatim.openstreetmap.org/search?format=jsonv2&addressdetails=1&limit=5&countrycodes=br&accept-language=pt-BR&q=' + encodeURIComponent(q);
  if (me) url += `&viewbox=${me.lon - 0.5},${me.lat + 0.5},${me.lon + 0.5},${me.lat - 0.5}`;
  return (await getJSON(url, 'nom', 1100)) || [];
}

const mk = (lat, lon, label, precision, src = 'online') => ({ lat, lon, label, precision, approx: precision !== 'house', src });

async function geocodeOnline(s, f) {
  const canon = await resolveStreet(f, s.cep);
  const street = canon ? canon.name : f.street.replace(/^R\.\s*/i, 'Rua ').replace(/^Av\.\s*/i, 'Avenida ');
  const bairros = [f.bairro, canon && canon.bairro].filter(Boolean);
  const where = [f.city, f.uf].filter(Boolean).join(', ');

  // Nominatim: tenta com número; sem resultado, só a rua
  for (const q of [...new Set([[street, f.num, where].filter(Boolean).join(', '), [street, where].filter(Boolean).join(', ')])]) {
    const pick = pickResult(await nominatim(q), bairros, f.city);
    if (pick) {
      const iso = pick.address && pick.address['ISO3166-2-lvl4'];
      if (iso && !geoCache._uf) geoCache._uf = iso.split('-')[1];
      return mk(+pick.lat, +pick.lon, pick.display_name, hasHouse(pick) ? 'house' : 'street');
    }
  }

  // Photon: busca aproximada (aceita nomes parecidos)
  const pq = [street, f.city].filter(Boolean).join(', ');
  const ph = await getJSON(`https://photon.komoot.io/api/?limit=5&q=${encodeURIComponent(pq)}${me ? `&lat=${me.lat}&lon=${me.lon}` : ''}`, 'photon', 400);
  const feats = ((ph && ph.features) || []).filter(x => (x.properties.countrycode || 'BR') === 'BR');
  const fc = feats.find(x => !f.city || norm(x.properties.city || x.properties.county || '').includes(norm(f.city))) || null;
  if (fc && similarity(stripType(street), stripType(fc.properties.name || '')) >= 0.6) {
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

async function geocode(s) {
  const f = addrFields(s);
  const key = 'g|' + stripType(f.street) + '|' + (f.num ?? '') + '|' + norm(f.bairro) + '|' + norm(f.city);
  if (geoCache[key]) return geoCache[key];

  let netErr = null, res = null;
  if (navigator.onLine) {
    try { res = await geocodeOnline(s, f); } catch (e) { netErr = e; }
  } else netErr = new Error('offline');
  if (res) { geoCache[key] = res; saveGeoCache(); return res; }

  const off = offlineGeocode(s);                                      // sem internet (ou nada achado online)
  if (off) return off;
  if (netErr && !packReady()) throw netErr;                           // tenta de novo quando a internet voltar
  return null;
}
