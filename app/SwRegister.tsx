'use client';
import { useEffect } from 'react';

// Registra o service worker (abrir sem internet e guardar os blocos do mapa).
export default function SwRegister() {
  useEffect(() => { if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {}); }, []);
  return null;
}
