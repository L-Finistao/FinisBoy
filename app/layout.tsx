import type { ReactNode } from 'react';

// As telas ainda estão no app atual (public/index.html); as rotas React entram aqui conforme forem migradas.
export const metadata = { title: 'FinisBoy' };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="pt-BR">
      <body>{children}</body>
    </html>
  );
}
