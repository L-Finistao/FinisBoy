'use client';
import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { api } from '../../lib/client/api';
import { signedIn } from '../../lib/client/sync';
import { useSync } from '../../lib/client/use-sync';

export default function Entrar() {
  useSync();
  const router = useRouter();
  const [register, setRegister] = useState(false);
  const [needCode, setNeedCode] = useState(false);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setErr(''); setBusy(true);
    try {
      const r = await api(register ? '/register' : '/login', 'POST', {
        email: f.get('email'), password: f.get('password'), name: f.get('name'), code: f.get('code'),
      });
      if (!r.ok) {
        if (r.data.needCode) setNeedCode(true);
        setErr(r.data.error || `Erro ao entrar (${r.status}).`);
        return;
      }
      await signedIn(r.data.user);
      router.replace('/rotas');
    } catch {
      setErr('Sem conexão com o servidor. Conecte-se à internet para entrar.');
    } finally { setBusy(false); }
  }

  return (
    <main className="auth"><div className="card">
      <img className="logo" src="/icon-192.png" alt="" />
      <h1 className="title">{register ? 'Criar conta' : 'Entrar no TurboSlug'}</h1>
      <form onSubmit={submit}>
        {register && <label>Nome<input name="name" autoComplete="name" /></label>}
        <label>E-mail<input name="email" type="email" required autoComplete="email" /></label>
        <label>Senha<input name="password" type="password" required minLength={8} autoComplete={register ? 'new-password' : 'current-password'} /></label>
        {needCode && <label>Código de convite<input name="code" /></label>}
        {err && <p className="err" role="alert">{err}</p>}
        <button className="primary" disabled={busy}>{register ? 'Criar conta' : 'Entrar'}</button>
      </form>
      <button className="ghost" type="button" onClick={() => { setRegister(!register); setErr(''); }}>
        {register ? 'Já tenho conta' : 'Criar conta nova'}
      </button>
    </div></main>
  );
}
