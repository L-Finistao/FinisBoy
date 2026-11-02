'use client';
import { useEffect, useRef } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import type { LatLon, Route, Stop } from '../../lib/core/types';

const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
const pin = (text: string | number, cls = '') => L.divIcon({ className: '', html: `<div class="pin ${cls}">${text}</div>`, iconSize: [28, 28], iconAnchor: [14, 14] });
const meIcon = L.divIcon({ className: '', html: '<div class="me">🏍</div>', iconSize: [34, 34], iconAnchor: [17, 17] });

interface Props {
  route: Route | null; stops: Stop[]; me: LatLon | null; picking: boolean;
  follow: boolean; onPick: (lat: number, lon: number) => void; onDrag: () => void; centerSignal: number;
  bottomPad?: number;                    // altura coberta pela folha inferior (mapa em tela cheia)
}

export default function MapView({ route, stops, me, picking, follow, onPick, onDrag, centerSignal, bottomPad = 0 }: Props) {
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const layer = useRef<L.LayerGroup | null>(null);
  const line = useRef<L.Polyline | null>(null);
  const meMk = useRef<L.Marker | null>(null);
  const cb = useRef({ onPick, onDrag, picking });
  cb.current = { onPick, onDrag, picking };
  const fitted = useRef<string | null>(null);

  useEffect(() => {
    const m = L.map(el.current!, { zoomControl: false }).setView(me ? [me.lat, me.lon] : [-14.2, -51.9], me ? 13 : 4);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' }).addTo(m);
    layer.current = L.layerGroup().addTo(m);
    m.on('click', e => { if (cb.current.picking) cb.current.onPick(e.latlng.lat, e.latlng.lng); });
    m.on('dragstart', () => cb.current.onDrag());
    map.current = m;
    const ro = new ResizeObserver(() => m.invalidateSize());   // o mapa cresce para tela cheia ao iniciar a corrida
    ro.observe(el.current!);
    return () => { ro.disconnect(); m.remove(); map.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Paradas e traçado da rota
  useEffect(() => {
    const m = map.current, g = layer.current;
    if (!m || !g) return;
    g.clearLayers();
    line.current?.remove(); line.current = null;
    const bounds: [number, number][] = [];
    if (route) {
      const pend = stops.filter(s => !s.done).sort((a, b) => a.order - b.order);
      for (const s of stops) {
        if (s.lat == null || s.lon == null) continue;
        g.addLayer(L.marker([s.lat, s.lon], { icon: s.done ? pin('✓', 'done') : pin(pend.indexOf(s) + 1) }).bindPopup(esc(s.raw)));
        bounds.push([s.lat, s.lon]);
      }
      if (route.geo) {
        line.current = L.polyline(route.geo.coords, { color: '#FF6B00', weight: 5, opacity: 0.85 }).addTo(m);
        bounds.push(...route.geo.coords);
      }
    }
    // enquadra quando troca de rota ou o traçado muda (não a cada ponto do GPS)
    const sig = route ? route.id + ':' + route.status + ':' + Math.round(bottomPad / 40) + ':' + (route.geo ? route.geo.distance.toFixed(0) : '') + ':' + stops.length : '';
    if (bounds.length && fitted.current !== sig) {
      fitted.current = sig;
      if (me) bounds.push([me.lat, me.lon]);
      m.invalidateSize();
      m.fitBounds(bounds, { paddingTopLeft: [30, 70], paddingBottomRight: [30, 30 + bottomPad], maxZoom: route?.status === 'andamento' ? 16 : 16 });
    }
  }, [route, stops, bottomPad]); // eslint-disable-line react-hooks/exhaustive-deps

  // Posição atual
  useEffect(() => {
    const m = map.current;
    if (!m || !me) return;
    if (!meMk.current) { meMk.current = L.marker([me.lat, me.lon], { icon: meIcon, zIndexOffset: 1000 }).addTo(m); if (!route) m.setView([me.lat, me.lon], 13); }
    else meMk.current.setLatLng([me.lat, me.lon]);
    if (follow && route?.status === 'andamento') m.panTo([me.lat, me.lon]);
  }, [me, follow, route]);

  useEffect(() => { if (centerSignal && me) map.current?.setView([me.lat, me.lon], 15); }, [centerSignal]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { const c = map.current?.getContainer(); if (c) c.style.cursor = picking ? 'crosshair' : ''; }, [picking]);

  return <div ref={el} className="map" />;
}
