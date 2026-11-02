'use client';
import { useEffect, useRef } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { FAV_MIN, HAZARD, LC, isSlowCell, type Learn } from '../../lib/core/learn';
import type { Near } from '../../lib/core/geo';
import type { LatLon, Route, Stop } from '../../lib/core/types';

const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
const pin = (text: string | number, cls = '') => L.divIcon({ className: '', html: `<div class="pin ${cls}">${text}</div>`, iconSize: [28, 28], iconAnchor: [14, 14] });
const meIcon = (e: string, acc = '', buddy = '') => L.divIcon({ className: '', html: `<div class="me">${e}${acc ? `<i class="acc">${acc}</i>` : ''}${buddy ? `<i class="bud">${buddy}</i>` : ''}</div>`, iconSize: [38, 38], iconAnchor: [19, 19] });
const hzIcon = (e: string) => L.divIcon({ className: '', html: `<div class="hz">${e}</div>`, iconSize: [26, 26], iconAnchor: [13, 13] });

interface Props {
  route: Route | null; stops: Stop[]; me: LatLon | null; picking: boolean;
  follow: boolean; onPick: (lat: number, lon: number) => void; onDrag: () => void; centerSignal: number;
  bottomPad?: number; avatar?: string; accessory?: string; buddy?: string;                   // altura coberta pela folha inferior (mapa em tela cheia)
  learn?: Learn; near?: Near | null;                     // aprendizado (problemas, favoritas, trechos lentos) e posição na rota
  onRemoveHazard?: (id: string) => void; onRemoveFav?: (id: string) => void;
}

// Popup com um botão (o Leaflet não renderiza React): cria o elemento e liga o clique.
function popupWithButton(html: string, label: string, onClick: () => void) {
  const box = L.DomUtil.create('div');
  box.innerHTML = html;
  const b = L.DomUtil.create('button', '', box);
  b.textContent = label; b.style.marginTop = '8px';
  b.onclick = onClick;
  return box;
}

export default function MapView({ route, stops, me, picking, follow, onPick, onDrag, centerSignal, bottomPad = 0, avatar = '🏍️', accessory = '', buddy = '', learn, near, onRemoveHazard, onRemoveFav }: Props) {
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const layer = useRef<L.LayerGroup | null>(null);
  const lines = useRef<L.LayerGroup | null>(null);
  const learnLayer = useRef<L.LayerGroup | null>(null);
  const meMk = useRef<L.Marker | null>(null);
  const cb = useRef({ onPick, onDrag, picking, onRemoveHazard, onRemoveFav });
  cb.current = { onPick, onDrag, picking, onRemoveHazard, onRemoveFav };
  const fitted = useRef<string | null>(null);

  useEffect(() => {
    const m = L.map(el.current!, { zoomControl: false, preferCanvas: true }).setView(me ? [me.lat, me.lon] : [-14.2, -51.9], me ? 13 : 4);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' }).addTo(m);
    learnLayer.current = L.layerGroup().addTo(m);
    lines.current = L.layerGroup().addTo(m);
    layer.current = L.layerGroup().addTo(m);
    m.on('click', e => { if (cb.current.picking) cb.current.onPick(e.latlng.lat, e.latlng.lng); });
    m.on('dragstart', () => cb.current.onDrag());
    map.current = m;
    const ro = new ResizeObserver(() => m.invalidateSize());   // o mapa cresce para tela cheia ao iniciar a corrida
    ro.observe(el.current!);
    return () => { ro.disconnect(); m.remove(); map.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Paradas e enquadramento
  useEffect(() => {
    const m = map.current, g = layer.current;
    if (!m || !g) return;
    g.clearLayers();
    const bounds: [number, number][] = [];
    if (route) {
      const pend = stops.filter(s => !s.done).sort((a, b) => a.order - b.order);
      for (const s of stops) {
        if (s.lat == null || s.lon == null) continue;
        g.addLayer(L.marker([s.lat, s.lon], { icon: s.done ? pin('✓', 'done') : pin(pend.indexOf(s) + 1) }).bindPopup(esc(s.raw)));
        bounds.push([s.lat, s.lon]);
      }
      if (route.geo) bounds.push(...route.geo.coords);
    }
    // enquadra quando troca de rota ou o traçado muda (não a cada ponto do GPS)
    const sig = route ? route.id + ':' + route.status + ':' + Math.round(bottomPad / 40) + ':' + (route.geo ? route.geo.distance.toFixed(0) : '') + ':' + stops.length : '';
    if (bounds.length && fitted.current !== sig) {
      fitted.current = sig;
      if (me) bounds.push([me.lat, me.lon]);
      m.invalidateSize();
      m.fitBounds(bounds, { paddingTopLeft: [30, 70], paddingBottomRight: [30, 30 + bottomPad], maxZoom: 16 });
    }
  }, [route, stops, bottomPad]); // eslint-disable-line react-hooks/exhaustive-deps

  // Linha da rota: o que já foi percorrido fica cinza e fino; só o que falta continua laranja, a partir da sua posição
  useEffect(() => {
    const g = lines.current;
    if (!g) return;
    g.clearLayers();
    const coords = route?.geo?.coords;
    if (!coords || coords.length < 2) return;
    if (route!.status === 'andamento' && near && near.d <= 70 && near.i + 1 < coords.length) {
      const a = coords[near.i], b = coords[near.i + 1];
      const at: [number, number] = [a[0] + (b[0] - a[0]) * near.t, a[1] + (b[1] - a[1]) * near.t];
      L.polyline([...coords.slice(0, near.i + 1), at], { color: '#98A2B3', weight: 4, opacity: 0.7, interactive: false }).addTo(g);
      L.polyline([at, ...coords.slice(near.i + 1)], { color: '#e84b31', weight: 5, opacity: 0.85 }).addTo(g);
    } else L.polyline(coords, { color: '#e84b31', weight: 5, opacity: 0.85 }).addTo(g);
  }, [route?.geo, route?.status, route?.id, near?.i, near?.t, near?.d]); // eslint-disable-line react-hooks/exhaustive-deps

  // Aprendizado: problemas marcados, vias favoritas e trechos lentos
  useEffect(() => {
    const g = learnLayer.current;
    if (!g || !learn) return;
    g.clearLayers();
    for (const h of learn.hazards) {
      const spec = HAZARD[h.type];
      if (!spec) continue;
      L.marker([h.lat, h.lon], { icon: hzIcon(spec.icon) })
        .bindPopup(popupWithButton(`<b>${spec.label}</b>`, 'Remover marcação', () => cb.current.onRemoveHazard?.(h.id))).addTo(g);
    }
    for (const z of learn.devZones.filter(x => x.n >= FAV_MIN && x.path && x.path.length > 1)) {
      L.polyline(z.path!, { color: '#16a34a', weight: 6, opacity: 0.6 })
        .bindPopup(popupWithButton(`<b>⭐ Via favorita</b><br>Você ignorou a sugestão aqui ${z.n} vezes.`, 'Remover favorita', () => cb.current.onRemoveFav?.(z.id))).addTo(g);
    }
    if (!learn.on) return;
    let n = 0;
    for (const k in learn.learned) {                       // trechos em que você costuma andar devagar
      if (!isSlowCell(learn.learned[k]) || n++ > 2500) continue;
      const [i, j] = k.split('_').map(Number);
      L.rectangle([[i * LC, j * LC], [(i + 1) * LC, (j + 1) * LC]], { color: '#dc2626', weight: 0, fillOpacity: 0.28, interactive: false }).addTo(g);
    }
  }, [learn]);

  // Posição atual
  useEffect(() => {
    const m = map.current;
    if (!m || !me) return;
    if (!meMk.current) { meMk.current = L.marker([me.lat, me.lon], { icon: meIcon(avatar, accessory, buddy), zIndexOffset: 1000 }).addTo(m); if (!route) m.setView([me.lat, me.lon], 13); }
    else meMk.current.setLatLng([me.lat, me.lon]);
    if (follow && route?.status === 'andamento') m.panTo([me.lat, me.lon]);
  }, [me, follow, route]);

  useEffect(() => { meMk.current?.setIcon(meIcon(avatar, accessory, buddy)); }, [avatar, accessory, buddy]);
  useEffect(() => { if (centerSignal && me) map.current?.setView([me.lat, me.lon], 15); }, [centerSignal]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { const c = map.current?.getContainer(); if (c) c.style.cursor = picking ? 'crosshair' : ''; }, [picking]);

  return <div ref={el} className="map" />;
}
