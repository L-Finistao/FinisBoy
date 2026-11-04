'use client';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import { useSync } from '../../lib/client/use-sync';
import { Icon } from './Icon';
import { ThemeToggle } from './ThemeToggle';

const TABS = [
  { href: '/rotas', label: 'Rotas', icon: 'nav' },
  { href: '/dia', label: 'Dia', icon: 'calendar' },
  { href: '/historico', label: 'Histórico', icon: 'history' },
  { href: '/perfil', label: 'Perfil', icon: 'trophy' },
] as const;

function ago(t: number, now: number) {
  if (!t) return '';
  const m = Math.floor((now - t) / 60000);
  return m < 1 ? 'agora' : m < 60 ? `há ${m} min` : `há ${Math.floor(m / 60)} h`;
}

// Cabeçalho + faixa de sincronização + abas. Exige login (volta para /entrar).
export function Shell({ children, action, running = false }: { children: ReactNode; action?: ReactNode; running?: boolean }) {
  const s = useSync();
  const router = useRouter();
  const path = usePathname();
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 30_000); return () => clearInterval(t); }, []);
  useEffect(() => { if (s.ready && !s.user) router.replace('/entrar'); }, [s.ready, s.user, router]);

  if (!s.ready || !s.user) return <div className="app"><p className="empty">Carregando…</p></div>;

  const warn = !s.online || s.pending > 0 || !!s.message;
  const text = !s.online ? 'Sem internet — salvo no aparelho'
    : s.busy ? 'Salvando backup…'
    : s.pending ? `${s.pending} alteração(ões) aguardando backup`
    : 'Tudo sincronizado';

  return (
    <div className="app">
      <header className="hdr">
        <img className="logo" src="/icon-192.png" alt="" />
        <div className="brand">
          <b>TurboSlug</b>
          <small><i className={`dot ${s.online ? '' : 'off'}`} />{s.online ? 'online' : 'offline'}</small>
        </div>
        <ThemeToggle />
        <Link href="/ajustes" className="btn icon-btn" aria-label="Configurações"><Icon n="gear" /></Link>
        {action}
      </header>
      <div className={`syncbar ${warn ? 'warn' : ''}`}>
        <Icon n={s.online ? 'wifi' : 'wifioff'} /><span>{text}</span><span>{ago(s.lastBackup, now)}</span>
      </div>
      <div className="content">{children}</div>
      <div className="tabs">
        <nav>
          {TABS.map(t => (
            <Link key={t.href} href={t.href} className={path === t.href ? 'on' : ''}>
              <Icon n={t.icon} />{t.label}
              {t.href === '/rotas' && running && <i className="badge-dot" />}
            </Link>
          ))}
        </nav>
      </div>
    </div>
  );
}
