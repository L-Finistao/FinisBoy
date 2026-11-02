'use client';
import { useEffect, useState, type FormEvent } from 'react';
import { BACKUP_OPTIONS, type BackupMinutes } from '../../lib/shared';
import { backupNow, restoreFromCloud, setBackupMinutes, signOut, forceSignOut } from '../../lib/client/sync';
import { useRequireUser } from '../../lib/client/use-sync';
import { useApp } from '../../lib/client/use-app';
import * as A from '../../lib/client/store';
import { newId, money } from '../../lib/core/format';
import { MODE_LABEL, costParts, costPerKm, newProfile, parseMoney, type Pay, type Profile } from '../../lib/core/earnings';
import { Shell } from '../_components/Shell';
import { Icon } from '../_components/Icon';

const label = (m: number) => (m < 60 ? `${m} minutos` : m === 60 ? '1 hora' : `${m / 60} horas`);
const when = (t: number) => (t ? new Date(t).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : 'nenhum ainda');
const txt = (n: number) => (n ? String(n).replace('.', ',') : '');
const COST_FIELDS: { k: keyof Pay; l: string; ph: string }[] = [
  { k: 'fuelPrice', l: 'Gasolina (R$ por litro)', ph: '6,00' }, { k: 'kmPerL', l: 'Consumo (km por litro)', ph: '35' },
  { k: 'oilPrice', l: 'Óleo (R$ por troca)', ph: '40,00' }, { k: 'oilKm', l: 'Troca de óleo a cada (km)', ph: '1000' },
];

export default function Ajustes() {
  const s = useRequireUser();
  const app = useApp();
  const [note, setNote] = useState('');
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [cost, setCost] = useState<Record<string, string>>({});
  const [target, setTarget] = useState('15');
  const [city, setCity] = useState('');
  const [saved, setSaved] = useState(false);

  // carrega os valores salvos uma vez, quando o app termina de ler o aparelho
  useEffect(() => {
    if (!app.ready) return;
    setProfiles(app.profiles.map(p => ({ ...p })));
    setCost({ ...Object.fromEntries([...COST_FIELDS.map(f => f.k), 'otherKm'].map(k => [k, txt(app.pay[k as keyof Pay] as number)])) });
    setTarget(String(app.target)); setCity(app.city);
  }, [app.ready]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!s.ready || !s.user || !app.ready) return <div className="app"><p className="empty">Carregando…</p></div>;

  const payNow: Pay = { ...app.pay, ...Object.fromEntries(Object.keys(cost).map(k => [k, parseMoney(cost[k] || '')])) } as Pay;
  const parts = costParts(payNow), perKm = costPerKm(payNow);
  const upd = (i: number, p: Partial<Profile>) => setProfiles(list => list.map((x, j) => (j === i ? { ...x, ...p } : x)));

  async function save(e: FormEvent) {
    e.preventDefault();
    await A.saveProfiles(profiles.map((p, i) => ({ ...p, name: p.name.trim() || `Período ${i + 1}` })));
    await A.savePay(payNow);
    await A.setTarget(Math.max(0, parseInt(target, 10) || 0));
    await A.setCity(city.trim());
    setSaved(true); setTimeout(() => setSaved(false), 2500);
  }

  async function restore() {
    if (!confirm('Restaurar os dados da nuvem?\n\nO que existir na nuvem substitui a versão deste aparelho. O que só existe aqui é mantido. A página será recarregada.')) return;
    try {
      const n = await restoreFromCloud();
      setNote(n ? `${n} item(ns) restaurado(s).` : 'Não há backup na nuvem para esta conta.');
      if (n) setTimeout(() => location.reload(), 800);
    } catch (e) { setNote((e as Error).message); }
  }

  async function exit() {
    try { await signOut(); }
    catch (e) {
      if (!confirm(`${(e as Error).message} Sair mesmo assim? (os dados continuam neste aparelho)`)) return;
      await forceSignOut();
    }
  }

  const col = { display: 'flex', flexDirection: 'column', gap: 12 } as const;

  return (
    <Shell running={!!A.session()}>
      <section className="panel" style={col}>
        <div><div className="eyebrow">Conta</div><div className="title">{s.user.name || s.user.email}</div>{s.user.name && <p className="muted">{s.user.email}</p>}</div>
      </section>

      <section className="panel" style={col}>
        <div><div className="eyebrow">Backup</div><p className="muted">Os dados ficam no aparelho e funcionam sem internet. O banco recebe uma cópia no intervalo escolhido.</p></div>
        <label>Salvar no banco a cada
          <select value={s.minutes} onChange={e => void setBackupMinutes(Number(e.target.value) as BackupMinutes)}>
            {BACKUP_OPTIONS.map(m => <option key={m} value={m}>{label(m)}</option>)}
          </select>
        </label>
        <p className="muted">Último backup: {when(s.lastBackup)} · aguardando: {s.pending}</p>
        {s.message && <p className="warn" role="status">{s.message}</p>}
        {note && <p role="status">{note}</p>}
        <div className="row">
          <button className="primary" disabled={s.busy} onClick={() => void backupNow(true)}><Icon n="refresh" />{s.busy ? 'Salvando…' : 'Salvar agora'}</button>
          <button disabled={s.busy} onClick={() => void restore()}>Restaurar</button>
        </div>
      </section>

      <form style={{ display: 'contents' }} onSubmit={save}>
        <section className="panel" style={col}>
          <div><div className="eyebrow">Períodos de trabalho</div>
            <p className="muted">Cadastre cada período com o local e como é pago. Ex.: <b>Manhã</b>, fixo R$ 100; <b>Noite</b>, fixo R$ 35 + R$ 5 por entrega. Com o horário preenchido, o app escolhe o período sozinho ao criar uma rota.</p></div>
          {profiles.map((p, i) => (
            <div key={p.id} className="prof">
              <div className="two">
                <label>Nome<input value={p.name} onChange={e => upd(i, { name: e.target.value })} placeholder="Manhã" /></label>
                <label>Local<input value={p.local} onChange={e => upd(i, { local: e.target.value })} placeholder="Onde trabalha" /></label>
              </div>
              <label>Como é pago
                <select value={p.mode} onChange={e => upd(i, { mode: e.target.value as Profile['mode'] })}>
                  {Object.entries(MODE_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                </select></label>
              <div className="two">
                {p.mode !== 'entrega' && <label>Fixo por dia (R$)<input inputMode="decimal" value={txt(p.fixed)} onChange={e => upd(i, { fixed: parseMoney(e.target.value) })} placeholder="100,00" /></label>}
                {p.mode !== 'fixo' && <label>Por entrega (R$)<input inputMode="decimal" value={txt(p.perDelivery)} onChange={e => upd(i, { perDelivery: parseMoney(e.target.value) })} placeholder="5,00" /></label>}
              </div>
              <div className="two">
                <label>Horário: das<input type="time" value={p.from} onChange={e => upd(i, { from: e.target.value })} /></label>
                <label>até<input type="time" value={p.to} onChange={e => upd(i, { to: e.target.value })} /></label>
              </div>
              {profiles.length > 1 && <button type="button" className="soft-bad" onClick={() => setProfiles(l => l.filter((_, j) => j !== i))}>Remover este período</button>}
            </div>
          ))}
          <button type="button" onClick={() => setProfiles(l => [...l, newProfile(newId(), `Período ${l.length + 1}`)])}><Icon n="plus" />Adicionar período</button>
        </section>

        <section className="panel" style={col}>
          <div className="eyebrow">Custo da moto por km</div>
          <div className="two">
            {COST_FIELDS.map(f => <label key={f.k}>{f.l}<input inputMode="decimal" placeholder={f.ph} value={cost[f.k] || ''} onChange={e => setCost(c => ({ ...c, [f.k]: e.target.value }))} /></label>)}
          </div>
          <label>Outros custos (R$ por km): pneus, corrente, revisão<input inputMode="decimal" placeholder="0,00" value={cost.otherKm || ''} onChange={e => setCost(c => ({ ...c, otherKm: e.target.value }))} /></label>
          <p className="muted">{perKm ? <><b>{money(perKm)}/km</b> (gasolina {money(parts.fuel)} + óleo {money(parts.oil)}{parts.other ? ` + outros ${money(parts.other)}` : ''})</> : 'Preencha para ver o custo por km.'}</p>
        </section>

        <section className="panel" style={col}>
          <div className="eyebrow">Corrida</div>
          <label>Tempo médio de entrega desejado (minutos)<input type="number" min={0} max={240} inputMode="numeric" value={target} onChange={e => setTarget(e.target.value)} /></label>
          <p className="muted">O cronômetro fica verde, amarelo (80% da meta) e vermelho (estourou). Use 0 para desligar.</p>
          <label>Cidade / UF padrão<input value={city} onChange={e => setCity(e.target.value)} placeholder="Ex.: Birigui - SP" autoComplete="off" /></label>
        </section>

        <button className="primary full">{saved ? '✓ Salvo' : 'Salvar configurações'}</button>
      </form>

      <button className="soft-bad full" onClick={() => void exit()}>Sair da conta</button>
    </Shell>
  );
}
