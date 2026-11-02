import type { ReactNode } from 'react';
import './globals.css';

// As telas ainda estão no app atual (public/index.html); as rotas React entram aqui conforme forem migradas.
export const metadata = { title: 'FinisBoy' };
export const viewport = { width: 'device-width', initialScale: 1 };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="pt-BR">
      <body>{children}</body>
    </html>
  );
}
