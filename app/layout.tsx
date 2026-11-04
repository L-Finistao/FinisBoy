import type { ReactNode } from 'react';
import './globals.css';
import SwRegister from './SwRegister';
import GameLayer from './_components/GameLayer';

export const metadata = {
  title: 'TurboSlug',
  manifest: '/manifest.json',
  icons: { icon: '/icon-192.png', apple: '/icon-192.png' },
};
export const viewport = { width: 'device-width', initialScale: 1, viewportFit: 'cover', themeColor: '#ffffff' };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="pt-BR" suppressHydrationWarning>
      <head><script dangerouslySetInnerHTML={{ __html: "try{if(localStorage.getItem('theme')==='dark')document.documentElement.dataset.theme='dark'}catch(e){}" }} /></head>
      <body>{children}<SwRegister /><GameLayer /></body>
    </html>
  );
}
