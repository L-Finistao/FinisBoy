// Leitura do texto do WhatsApp: separa mensagens, remove data/nome/emoji/numeração e extrai rua, CEP, bairro e observações.

export const TOK: Record<string, string> = {
  r: 'rua', av: 'avenida', tv: 'travessa', al: 'alameda', pc: 'praca', pca: 'praca', rod: 'rodovia', est: 'estrada',
  dr: 'doutor', dra: 'doutora', prof: 'professor', profa: 'professora', cel: 'coronel', pres: 'presidente',
  eng: 'engenheiro', gov: 'governador', dep: 'deputado', ver: 'vereador', sta: 'santa', sto: 'santo',
  cap: 'capitao', gen: 'general', mal: 'marechal', jd: 'jardim', vl: 'vila', res: 'residencial', pq: 'parque',
};
export const TYPE_WORDS = new Set(['rua', 'avenida', 'travessa', 'alameda', 'praca', 'rodovia', 'estrada', 'de', 'da', 'do', 'das', 'dos', 'e']);
const COMPL = /\b(apto?|apt|ap|apartamento|bloco|bl|casa|sala|cj|conjunto|torre)\.?\s*\d+\w*|\bfundos\b/gi;

export const norm = (s: string) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
  .replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
export const stripType = (n: string) => norm(n).split(' ').map(t => TOK[t] || t).filter(t => !TYPE_WORDS.has(t)).join(' ');

export interface ParsedAddress {
  sender: string | null; when: string | null;
  raw: string; note: string; cep: string | null; cityGuess: string;
}

const WA_PREFIX = [
  /^\[\d{1,2}:\d{2}(:\d{2})?,\s*\d{1,2}\/\d{1,2}\/\d{2,4}\]\s*[^:]{1,40}:\s*/,   // [10:32, 30/10/2026] Nome:
  /^\d{1,2}\/\d{1,2}\/\d{2,4}[ ,]+\d{1,2}:\d{2}\s*-\s*[^:]{1,40}:\s*/,           // 30/10/2026 10:32 - Nome:
];

function cleanLine(line: string) {
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

function matchHeader(line: string) {
  for (const re of HEADERS) {
    const m = re.exec(line);
    if (m) return { when: `${m[1]} ${m[2]}`, sender: m[3].trim(), rest: line.slice(m[0].length) };
  }
  return null;
}

// Uma mensagem pode ocupar várias linhas (continuação não tem cabeçalho).
function splitMessages(text: string) {
  const msgs: { sender: string | null; when: string | null; lines: string[] }[] = [];
  let cur: (typeof msgs)[number] | null = null;
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

function parseBody(lines: string[]) {
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
    cityGuess = `${main.split(',').pop()!.trim()} - ${uf[2]}`;
  }
  if (bairro) {
    main += ', ' + bairro;
    if (!cityGuess) cityGuess = bairro.split(',').pop()!.trim();
  }
  const partes = main.split(',');
  if (!cityGuess && partes.length >= 3) cityGuess = partes[partes.length - 1].trim();   // "Rua X, 70, Bairro, Cidade"
  return { raw: main, note: [note, ref].filter(Boolean).join(' · '), cep, cityGuess };
}

export function parseText(text: string): ParsedAddress[] {
  return splitMessages(text)
    .map(m => ({ sender: m.sender, when: m.when, ...parseBody(m.lines) }))
    .filter(a => a.raw.length >= 6);
}

// "Rua Piauí, 218, Centro" -> { street, num, rest }
export function splitAddr(raw: string) {
  const t = raw.replace(/\b(?:N[º°]|Nr|Nro)\.?\s*/gi, '').replace(COMPL, ' ').replace(/\s+-\s+/g, ', ');
  const parts = t.split(',').map(x => x.trim()).filter(Boolean);
  let street = parts[0] || '', num: number | null = null;
  const rest: string[] = [];
  for (const p of parts.slice(1)) {
    const m = num == null && /^(\d{1,5})\b\s*(.*)$/.exec(p);
    if (m) { num = parseInt(m[1], 10); if (m[2]) rest.push(m[2]); } else rest.push(p);
  }
  if (num == null) {                                  // "Rua Piauí 218 c sao genaro": número no meio, sem vírgulas
    const m = /^(.*?\D)\s+(\d{1,5})(?:\s+(.*))?$/.exec(street);
    if (m && m[1].trim().split(/\s+/).length >= 2) {   // "Rua 7 de Setembro" não conta
      street = m[1].trim(); num = parseInt(m[2], 10);
      if (m[3]) rest.unshift(m[3]);
    }
  }
  return { street, num, rest: rest.join(' ') };
}
