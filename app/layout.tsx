import type { ReactNode } from 'react';
import './globals.css';
import SwRegister from './SwRegister';

export const metadata = {
  title: 'FinisBoy',
  manifest: '/manifest.json',
  icons: { icon: '/icon-192.png', apple: '/icon-192.png' },
};
export const viewport = { width: 'device-width', initialScale: 1, viewportFit: 'cover', themeColor: '#14221b' };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="pt-BR">
      <body>{children}<SwRegister /></body>
    </html>
  );
}
