'use client';
import { useEffect, useState } from 'react';
import { Icon } from './Icon';

// Liga/desliga o modo escuro. Fica salvo no aparelho; o padrão é o tema claro.
export function ThemeToggle() {
  const [dark, setDark] = useState(false);
  useEffect(() => { setDark(document.documentElement.dataset.theme === 'dark'); }, []);
  function toggle() {
    const next = !dark;
    setDark(next);
    if (next) document.documentElement.dataset.theme = 'dark'; else delete document.documentElement.dataset.theme;
    try { localStorage.setItem('theme', next ? 'dark' : 'light'); } catch { /* armazenamento bloqueado */ }
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', next ? '#0f1420' : '#ffffff');
  }
  return (
    <button type="button" className="btn icon-btn" onClick={toggle} aria-pressed={dark} aria-label={dark ? 'Desligar modo escuro' : 'Ligar modo escuro'}>
      <Icon n={dark ? 'sun' : 'moon'} />
    </button>
  );
}
