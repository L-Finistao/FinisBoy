'use client';
import { useRef, useState } from 'react';
import { money } from '../../lib/core/format';
import { parseMoney } from '../../lib/core/earnings';
import { isDrink, parseComanda, scanToText, type OrderScan } from '../../lib/core/order';
import { readComanda } from '../../lib/client/ocr';
import type { Ticket } from '../../lib/core/types';

// Chips da comanda (bebida, cobrar, pagamento) usados na lista de paradas e na próxima parada.
export function TicketChips({ t }: { t?: Ticket }) {
  if (!t) return null;
  const pay = t.collect && t.collect > 0 ? `💵 Cobrar ${money(t.collect)}` : t.collect === 0 ? '✅ Pago' : '';
  return (
    <div className="tks">
      {t.hasDrink && <span className="tk drink" title={t.drinks.join(', ')}>🥤 Bebida{t.drinks.length ? `: ${t.drinks.join(', ')}` : ''}</span>}
      {pay && <span className={`tk ${t.collect ? 'bad' : 'good'}`}>{pay}</span>}
      {t.card && <span className="tk bad">💳 Levar maquininha</span>}
    </div>
  );
}

type Extra = { ticket: Ticket; note?: string; sender?: string };

// Botão "📷 Foto da comanda": lê a foto, mostra os dados para conferir/corrigir e só adiciona depois do "Está correto".
export function ScanOrder({ onAdd, city }: { onAdd: (text: string, extra: Extra) => void; city: string }) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [prog, setProg] = useState<{ p: number; label: string } | null>(null);
  const [s, setS] = useState<OrderScan | null>(null);
  const [collect, setCollect] = useState('');

  async function pick(file: File | undefined) {
    if (!file) return;
    setBusy(true); setErr(''); setS(null);
    try {
      const text = await readComanda(file, (p, label) => setProg({ p, label }));
      const sc = parseComanda(text, city);
      if (!sc.readable) setErr('Não consegui achar um endereço nessa foto. Tire outra com mais luz e a comanda inteira, ou digite o endereço.');
      else { setS(sc); setCollect(sc.ticket.collect != null ? String(sc.ticket.collect).replace('.', ',') : ''); }
    } catch (e) { setErr('Não foi possível ler a foto neste aparelho. ' + ((e as Error).message || '')); }
    finally { setBusy(false); setProg(null); if (input.current) input.current.value = ''; }
  }

  const upd = (p: Partial<OrderScan>) => setS(v => v && { ...v, ...p });
  const updT = (p: Partial<Ticket>) => setS(v => v && { ...v, ticket: { ...v.ticket, ...p } });

  function confirm() {
    if (!s || !s.address.trim()) return;
    const c = collect.trim() === '' ? undefined : parseMoney(collect);
    const ticket: Ticket = { ...s.ticket, collect: c, customer: s.customer || undefined };
    onAdd(scanToText(s), { ticket, note: [s.complement, s.notes].filter(Boolean).join(' · ') || undefined, sender: [s.customer, s.phone].filter(Boolean).join(' · ') || undefined });
    setS(null);
  }

  return (
    <div className="scan">
      <input ref={input} type="file" accept="image/*" capture="environment" hidden onChange={e => void pick(e.target.files?.[0])} />
      {!s && <button type="button" className="full" disabled={busy} onClick={() => input.current?.click()}>{busy ? `⏳ ${prog?.label || 'Preparando leitor…'} ${prog ? Math.round(prog.p * 100) + '%' : ''}` : '📷 Foto da comanda'}</button>}
      {err && <p className="err">{err}</p>}
      {s && (
        <div className="scanbox">
          <div className="eyebrow">Lido da comanda{s.ticket.platform ? ` · ${s.ticket.platform}` : ''}{s.ticket.no ? ` · #${s.ticket.no}` : ''} — confira:</div>
          <label>Endereço<input value={s.address} onChange={e => upd({ address: e.target.value })} /></label>
          <div className="two">
            <label>Complemento / referência<input value={s.complement} onChange={e => upd({ complement: e.target.value })} /></label>
            <label>CEP<input value={s.cep} inputMode="numeric" maxLength={9} onChange={e => upd({ cep: e.target.value.replace(/\D/g, '') })} /></label>
            <label>Cliente<input value={s.customer} onChange={e => upd({ customer: e.target.value })} /></label>
            <label>Telefone<input value={s.phone} inputMode="tel" onChange={e => upd({ phone: e.target.value })} /></label>
          </div>
          <label>Itens do pedido (um por linha)
            <textarea rows={Math.min(4, Math.max(2, s.ticket.items.length))} value={s.ticket.items.join('\n')}
              onChange={e => { const items = e.target.value.split('\n').map(x => x.trim()).filter(Boolean), drinks = items.filter(isDrink); updT({ items, drinks, hasDrink: drinks.length > 0 }); }} />
          </label>
          <label className="check"><input type="checkbox" checked={s.ticket.hasDrink} onChange={e => updT({ hasDrink: e.target.checked })} /> 🥤 Tem bebida{s.ticket.drinks.length ? ` (${s.ticket.drinks.join(', ')})` : ''}</label>
          <div className="two">
            <label>Cobrar do cliente (R$)<input value={collect} inputMode="decimal" placeholder="0 = já pago" onChange={e => setCollect(e.target.value)} /></label>
            <label>Pagamento<input value={s.ticket.pay || ''} onChange={e => updT({ pay: e.target.value })} /></label>
          </div>
          <label className="check"><input type="checkbox" checked={!!s.ticket.card} onChange={e => updT({ card: e.target.checked })} /> 💳 Levar maquininha</label>
          <label>Observações<input value={s.notes} onChange={e => upd({ notes: e.target.value })} /></label>
          <details><summary className="muted">Ver texto lido</summary><pre className="muted" style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{s.text}</pre></details>
          <div className="row">
            <button type="button" onClick={() => { setS(null); input.current?.click(); }}>Outra foto</button>
            <button type="button" className="primary" disabled={!s.address.trim()} onClick={confirm}>✓ Está correto — adicionar</button>
          </div>
        </div>
      )}
    </div>
  );
}

