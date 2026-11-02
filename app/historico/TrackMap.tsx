'use client';
import { useEffect, useRef } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { SPEED_COLORS, speedRuns, type Segment, type TrackPt } from '../../lib/core/track';
import type { Stop } from '../../lib/core/types';

const pin = (t: string | number) => L.divIcon({ className: '', html: `<div class="pin">${t}</div>`, iconSize: [28, 28], iconAnchor: [14, 14] });

// Trajeto feito, colorido pela velocidade, com as entregas numeradas. "focus" destaca uma parte.
export default function TrackMap({ pts, stops, focus }: { pts: TrackPt[]; stops: Stop[]; focus: Segment | null }) {
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const layer = useRef<L.LayerGroup | null>(null);

  useEffect(() => {
    const m = L.map(el.current!, { zoomControl: false }).setView([-14.2, -51.9], 4);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' }).addTo(m);
    layer.current = L.layerGroup().addTo(m);
    map.current = m;
    return () => { m.remove(); map.current = null; };
  }, []);

  useEffect(() => {
    const m = map.current, g = layer.current;
    if (!m || !g) return;
    g.clearLayers();
    const bounds: [number, number][] = [];
    const dim = !!focus;
    for (const r of speedRuns(pts)) {
      L.polyline(r.pts, { color: SPEED_COLORS[r.band], weight: 5, opacity: dim ? 0.3 : 0.9, interactive: false }).addTo(g);
      bounds.push(...r.pts);
    }
    if (focus && focus.sub.length > 1) {
      const line = focus.sub.map(p => [p[0], p[1]] as [number, number]);
      L.polyline(line, { color: '#14221b', weight: 8, opacity: 0.35, interactive: false }).addTo(g);
      for (const r of speedRuns(focus.sub)) L.polyline(r.pts, { color: SPEED_COLORS[r.band], weight: 5, opacity: 1, interactive: false }).addTo(g);
    }
    stops.filter(s => s.lat != null && s.doneAt).sort((a, b) => a.doneAt! - b.doneAt!).forEach((s, i) => {
      L.marker([s.lat!, s.lon!], { icon: pin(i + 1) }).bindPopup(s.raw.replace(/</g, '&lt;')).addTo(g);
      bounds.push([s.lat!, s.lon!]);
    });
    const target = focus && focus.sub.length > 1 ? focus.sub.map(p => [p[0], p[1]] as [number, number]) : bounds;
    if (target.length) m.fitBounds(target, { padding: [30, 30], maxZoom: 17 });
  }, [pts, stops, focus]);

  return <div ref={el} className="map" />;
}
