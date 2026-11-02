import type { Ticket } from './types';

/* Leitura de comanda por foto, 100% no aparelho: o OCR (Tesseract, em lib/client/ocr.ts) devolve o texto e aqui um leitor de
   regras separa endereço, cliente, itens, bebida, quanto cobrar… Sem IA e sem servidor externo. O OCR erra (papel amassado),
   por isso o app sempre mostra o que leu para a pessoa conferir antes de adicionar. */

export interface OrderScan {
  readable: boolean;
  address: string;                 // linha única: "Rua X, 285 - Bairro - Cidade - UF"
  complement: string; cep: string;
  customer: string; phone: string; notes: string; time: string;
  ticket: Ticket;
  text: string;                    // texto cru do OCR (para a pessoa conferir)
}

const DRINK = /(?<![a-zà-ú])(coca|guaran[aá]|refri\w*|suco\w*|cerveja\w*|[aá]gua|fanta|pepsi|sprite|heineken|brahma|skol|antarctica|itaipava|budweiser|long ?neck|chopp?|h2oh|del ?valle|energ[eé]tico|red ?bull|monster|vinho|drink|soda|mate|ice ?tea|laranja|limonada|600 ?ml|350 ?ml|2 ?l|1,?5 ?l|lata)(?![a-zà-ú])/i;
export const isDrink = (s: string) => DRINK.test(s);

// Linha de endereço que o parseText entende (CEP e complemento vão junto quando existem).
export const scanToText = (s: Pick<OrderScan, 'address' | 'cep' | 'complement'>) =>
  [s.address, s.cep && `CEP: ${s.cep.replace(/^(\d{5})(\d{3})$/, '$1-$2')}`].filter(Boolean).join(' ') + (s.complement ? ` ${s.complement}` : '');

/* ---------- Leitor de regras ---------- */
const MONEY = /(?:R\$\s*)?(-?\d{1,3}(?:\.\d{3})*,\d{2}|-?\d+[.,]\d{2})(?!\d)/;
const toNum = (s: string) => { const n = parseFloat(s.replace(/\.(?=\d{3}\b)/g, '').replace(',', '.')); return isFinite(n) ? n : undefined; };
const money = (line: string) => { const m = MONEY.exec(line.replace(/\s+/g, ' ')); return m ? toNum(m[1]) : undefined; };
const lastMoney = (line: string) => { const all = [...line.replace(/\s+/g, ' ').matchAll(new RegExp(MONEY.source, 'g'))]; return all.length ? toNum(all[all.length - 1][1]) : undefined; };
const fold = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

// Rótulos que encerram um bloco de várias linhas (endereço, observações).
const STOP = /^\s*(observa|obs\b|itens|item\b|complemento|comp\b|bairro|cidade|refer|telefone|tel\b|fone|cliente|forma de pag|pagamento|subtotal|\(?[+=]\)?\s*(subtotal|taxa|total)|total|taxa|desconto|cobrar|valor|data\b|entrega (prevista|feita)|previs|localizador|pedido|\d+\s*x\s)/i;

// Junta as linhas de um endereço quebrado pelo papel: se a linha anterior está "cheia" e a próxima começa em minúscula, a palavra foi cortada.
function joinWrapped(lines: string[]) {
  const max = Math.max(...lines.map(l => l.length));
  let out = '';
  lines.forEach((l, i) => {
    if (!i) { out = l; return; }
    const prev = lines[i - 1];
    const word = /^(de|da|do|das|dos|e|em|no|na|com|para|por|a|o)\b/.test(l);                      // palavra inteira, não pedaço
    const cut = (prev.length >= max - 2 && /^[a-zà-ú]/.test(l) && !/[,;:-]$/.test(prev) && !word) || (/-\s*[A-Z8]$/.test(prev) && /^[A-Z]\b/.test(l));   // "Birigui - S" + "P"
    out += (cut ? '' : ' ') + l;
  });
  return out.replace(/\s+/g, ' ').replace(/-\s*8P\b/, '- SP').trim();      // "SP" lido como "8P"
}

function splitAddress(raw: string, cityHint: string) {
  let t = raw.replace(/\b(?:N[º°]|Nr|Nro|Num)\.?\s*(?=\d)/gi, '').replace(/\s+-\s*$/, '').trim();
  let cep = '';
  t = t.replace(/CEP\s*:?\s*(\d{5})-?(\d{3})?/i, (_, a, b) => { cep = a + (b || ''); return ''; }).trim();
  const city = cityHint.replace(/\s*-\s*[A-Za-z]{2}$/, '').trim();
  let uf = '';
  const um = /(?:^|[\s,-])-?\s*([A-Z]{2})(?=\s*$|\s+[a-zà-ú])/.exec(t);
  if (um) uf = um[1];
  // número: primeiro grupo de dígitos depois do nome da rua
  const m = /^(.*?[^\d,\s][^\d]*?)[,\s]+(\d{1,5})\b\s*[A-Za-z]?\b(.*)$/.exec(t);
  let street = m ? m[1].trim() : t, number = m ? m[2] : '', rest = m ? m[3] : '';
  street = street.replace(/[,\s-]+$/, '');
  // resto: "Bairro, Cidade - UF obs" -> bairro / cidade / UF / complemento
  rest = rest.replace(/^[\s,-]+/, '');
  let hood = '', cityOut = '', note = '';
  const ci = city ? fold(rest).indexOf(fold(city)) : -1;
  if (ci >= 0) {
    hood = rest.slice(0, ci).replace(/[,\s-]+$/, '').trim(); cityOut = city;
    note = rest.slice(ci + city.length).replace(/^[\s,-]*[A-Z]{2}\b/, '').replace(/^[\s,-]+/, '').trim();
  } else {
    const mm = /^(.*?)[,\s-]+([A-Za-zÀ-ú][A-Za-zÀ-ú ]*?)\s*-\s*([A-Z]{2})\b\s*(.*)$/.exec(rest);
    if (mm) { hood = mm[1].replace(/[,\s-]+$/, '').trim(); cityOut = mm[2].trim(); uf = uf || mm[3]; note = mm[4].trim(); } else hood = rest.trim();
  }
  return { street, number, hood, city: cityOut || city, uf, note, cep };
}

export function parseComanda(text: string, cityHint = ''): OrderScan {
  const lines = text.split(/\r?\n/).map(l => l.replace(/[|_¦]+/g, ' ').replace(/\s+/g, ' ').trim().replace(/^[Il1]\s*[xX]\s+/, '1x ')).filter(l => l.length > 0);   // OCR lê "1x" como "Ix"
  const find = (re: RegExp) => lines.findIndex(l => re.test(l));
  const flat = lines.join('\n');

  const platform = /ifood/i.test(flat) ? 'iFood' : /99\s?food/i.test(flat) ? '99Food' : /sischef/i.test(flat) ? 'Sischef' : /anota\s?ai/i.test(flat) ? 'Anota AI' : /keeta/i.test(flat) ? 'Keeta' : '';
  const orderNo = (/pedido\s*:?\s*#?\s*(\d{3,})/i.exec(flat) || /^#\s*(\d{3,})\s*$/m.exec(flat) || [])[1] || '';

  // endereço: bloco depois do rótulo "Endereço"
  const STREET = /\b(rua|r\.|avenida|av\.?|travessa|alameda|pra[cç]a|rodovia|estrada|vila|jardim)\s+\S+/i;
  let ai = find(/endere[cç]o|endere.o/i);
  if (ai < 0 || !STREET.test(lines.slice(ai, ai + 2).join(' '))) { const si = lines.findIndex(l => STREET.test(l)); if (si >= 0) ai = si; }
  let rawAddr = '';
  if (ai >= 0) {
    const sm = STREET.exec(lines[ai]);
    const first = (sm ? lines[ai].slice(sm.index) : lines[ai].replace(/^.*?endere[cç]o(\s+p\/?\s*entrega)?\s*[:;.]?\s*/i, '')).replace(/^[^\wÀ-ú]+/, '');
    const block = first ? [first] : [];
    for (let i = ai + 1; i < lines.length && block.length < 4; i++) { if (STOP.test(lines[i])) break; block.push(lines[i]); }
    rawAddr = joinWrapped(block);
  }
  // formato com rótulos separados (iFood): Bairro:, Cidade:, Comp:
  const lab = (re: RegExp) => { const l = lines.find(x => re.test(x)); return l ? l.replace(re, '').trim() : ''; };
  const hoodL = lab(/^\W*bairro\s*[:;]\s*/i), compL = lab(/^\W*comp(lemento)?\s*[:;.]\s*/i);
  let cityL = lab(/^\W*cidade\s*[:;]\s*/i);
  const a = splitAddress(rawAddr, cityHint);
  if (cityL) {
    const cm = /^(.*?)\s*[-–=]\s*([A-Z]{2})\b/.exec(cityL);
    if (cm) { a.city = cm[1].trim(); a.uf = cm[2]; } else { a.city = (/^[A-Za-zÀ-ú ]+/.exec(cityL) || [''])[0].trim(); a.uf = a.uf || (/([A-Z]{2})\s*$/.exec(cityHint) || [])[1] || ''; }
    const cp = /CEP\s*:?\s*(\d{5})-?(\d{3})/i.exec(cityL + ' ' + lines.join(' '));
    if (cp) a.cep = cp[1] + cp[2];
  }
  if (hoodL) a.hood = hoodL;
  a.hood = a.hood.replace(/[^\wÀ-ú .'-]/g, ' ').replace(/\s+\S{1,2}$/, '').replace(/\s+/g, ' ').trim();     // lixo do OCR no fim do bairro
  const complement = [compL, a.note].filter(Boolean).join(' · ');
  if (a.cep && /^0+$/.test(a.cep)) a.cep = '';
  const address = [[a.street, a.number].filter(Boolean).join(', '), a.hood, a.city, a.uf].filter(Boolean).join(' - ');

  // cliente / telefone
  let customer = lab(/^\W*cliente\s*[:;]\s*/i);
  const ni = find(/^#\s*\d{3,}\s*$/);
  if (!customer && ni >= 0 && lines[ni + 1] && /[a-zà-ú]{2}/i.test(lines[ni + 1]) && !/entrega|pedido/i.test(lines[ni + 1])) customer = lines[ni + 1].replace(/^\W+/, '');
  const efi = find(/entrega feita/i);
  if (!customer && efi > 0 && /^[A-Za-zÀ-ú][A-Za-zÀ-ú .,'-]{1,30}$/.test(lines[efi - 1])) customer = lines[efi - 1];
  const zi = find(/^0?800[\s\d-]+/);
  if (!customer && zi > 0) customer = lines[zi - 1];
  const ph = /(?:fone|telefone|tel)\s*[:;.]?\s*(\(?\d{2,3}\)?[\s\d.-]{7,})/i.exec(flat);
  const phone = ph ? ph[1].trim().replace(/\s+/g, ' ') : '';

  // itens: entre "ITENS" e o primeiro total/taxa; senão, linhas "1x Nome"
  const items: string[] = [];
  const ii = find(/^\W*itens/i);
  const itemRe = /^(\d+)[.)]?\s*[xX]?\s+(.+?)(?:\s+(?:R\$\s*)?\d+[.,]\d{2})?\s*$/;
  const END = /\b(sub\s*total|sutitota|total|taxa|desconto|forma de pag|pagamento|valor|obs)/i;
  let startI = ii >= 0 ? ii + 1 : lines.findIndex(l => /^\d+\s*[xX]\s+\S/.test(l));
  if (startI >= 0) {
    for (let i = startI; i < lines.length; i++) {
      const l = lines[i];
      if (END.test(l)) break;
      const m = itemRe.exec(l.replace(/^[^\w]+/, ''));
      if (m && !/^(?:\d{1,2})$/.test(m[2])) items.push(`${m[1]}x ${m[2].replace(/\s+\d[\d.,]*(\s+\S{0,4})?$/, '').trim()}`);   // tira preço/lixo no fim
      else if (items.length && /^[a-z0-9À-ú]/i.test(l) && !/R\$/.test(l)) items[items.length - 1] += ' ' + l;   // continuação (nome quebrado em 2 linhas)
      else if (!items.length && ii >= 0 && /[a-zà-ú]{3}/i.test(l)) items.push(l);
    }
  }
  const drinks = items.filter(isDrink);

  // valores
  const totalLine = lines.find(l => /(total do pedido|valor total|\(=\)\s*total)/i.test(l)) || lines.find(l => /^\W*total\b/i.test(l));
  let total = totalLine ? lastMoney(totalLine) : undefined;
  const feeLine = lines.find(l => /taxa de entrega|taxa entrega/i.test(l));
  const fee = feeLine ? lastMoney(feeLine) : undefined;
  const cobrar = lines.find(l => /cobrar\s+d[oa]\s+cliente/i.test(l));
  const payLine = lines.find(l => /forma de pagamento|pagamento via|pagamento realizado|pago/i.test(l));
  const card = /m[aá]quina|maquinin|levar\s+\S*\s*cart/i.test(flat);
  const paidOnline = /pagamento\s+realiz|pago\s+online|online\s*[—–-]\s*\w+|\bvia\s+(ifood|99\s?food)|pago\s+via/i.test(flat);
  let collect: number | undefined = cobrar ? lastMoney(cobrar) : undefined;
  const payCtx = payLine ? (lines[lines.indexOf(payLine) + 1] || '') + ' ' + payLine : '';
  if (paidOnline) collect = 0;                                   // já pago pelo app: nada a cobrar na porta
  else if (collect == null && (card || /pix|dinheiro|troco|cr[eé]dito|d[eé]bito/i.test(payCtx))) collect = total;
  if (total == null) { const pl = lines.findIndex(l => /forma de pagamento/i.test(l)); const v = pl >= 0 ? lines.slice(pl, pl + 3).map(lastMoney).find(x => x != null) : undefined; total = v; if (collect == null && card) collect = v; }
  let pay = '';
  if (payLine) {
    const i = lines.indexOf(payLine);
    pay = /forma de pagamento/i.test(payLine) ? (lines[i + 1] || '').replace(MONEY, '').replace(/R\$/, '').trim() : payLine.replace(MONEY, '').replace(/R\$\s*/, '').replace(/^\W+|\W+$/g, '').trim();
  }
  if (!pay && cobrar) pay = '';

  // observações do cliente
  const oi = find(/serva[cç][oõ]es|^\W*obs\b/i);
  const notes: string[] = [];
  if (oi >= 0) for (let i = oi + 1; i < lines.length && notes.length < 4; i++) {
    if (STOP.test(lines[i]) || /R\$/.test(lines[i])) break;
    const l = lines[i].replace(/^\S\s+/, '');                                    // letra solta no começo = lixo do OCR
    if (!/^cancelar/i.test(l) && !/^(sistema|www)/i.test(l) && /[a-zà-ú]{4}/i.test(l)) notes.push(l);   // "Cancelar apenas o que está em falta" é texto fixo do app
  }
  const noteText = joinWrapped(notes);
  const time = (/previs[aã]o de entrega\s*:?\s*([^\n]+)/i.exec(flat) || /entrega prevista\s*:?\s*(\d{1,2}:\d{2})/i.exec(flat) || [])[1] || '';
  const nextLine = (/previs[aã]o de entrega\s*:?\s*\n\s*([^\n]+)/i.exec(flat) || [])[1] || '';

  return {
    readable: !!a.street,
    address, complement, cep: a.cep, customer: customer.replace(/[^\wÀ-ú .'-]/g, '').trim(), phone, notes: noteText, time: (time.trim() || nextLine.trim()),
    ticket: {
      no: orderNo || undefined, platform: platform || undefined, customer: customer || undefined,
      items, drinks, hasDrink: drinks.length > 0, total, fee, collect, pay: pay || undefined, card: card || undefined,
    },
    text,
  };
}
