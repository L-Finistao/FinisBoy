'use client';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useApp } from '../../../lib/client/use-app';
import { useRequireUser } from '../../../lib/client/use-sync';
import { local } from '../../../lib/client/local-db';
import * as A from '../../../lib/client/store';
import { Shell } from '../../_components/Shell';
import { fmtClock, fmtDist, fmtDur } from '../../../lib/core/format';
import { fmtTime } from '../../../lib/core/earnings';
import { SPEED_COLORS, segmentsOf, type Segment, type TrackPt } from '../../../lib/core/track';

const TrackMap = dynamic(() => import('../TrackMap'), { ssr: false, loading: () => <div className="map" /> });

export default function Trajeto() {
  const sync = useRequireUser();
  const app = useApp();
  const { id } = useParams<{ id: string }>();
  const [pts, setPts] = useState<TrackPt[] | null>(null);
  const [focus, setFocus] = useState<Segment | null>(null);

  useEffect(() => { void local.get<{ pts: TrackPt[] }>('tracks', id).then(t => setPts(t ? t.pts : [])); }, [id]);

  if (!sync.ready || !sync.user || !app.ready || !pts) return <div className="app"><p className="empty">Carregando…</p></div>;

  const r = app.routes.find(x => x.id === id);
  if (!r) return <Shell><div className="panel empty">Rota não encontrada.</div></Shell>;

  const stops = A.routeStops(id);
  const delivered = stops.filter(s => s.done && s.doneAt && s.lat != null).sort((a, b) => a.doneAt! - b.doneAt!);
  const segs = segmentsOf(r, delivered, pts);
  const withPace = segs.filter(s => s.pace != null);
  const avgPace = withPace.length ? withPace.reduce((a, s) => a + s.pace!, 0) / withPace.length : null;

  return (
    <Shell>
      <div className="rowb"><Link href="/historico" className="btn">← Voltar</Link><b>{r.name}</b></div>
      <div className="tmap"><TrackMap pts={pts} stops={stops} focus={focus} /></div>
      {pts.length < 2 && <div className="status">Esta rota não tem trajeto gravado pelo GPS (só rotas feitas neste app gravam o trajeto).</div>}
      <div className="legend">Velocidade:
        {['parado/lento (<5 km/h)', '5–15', '15–30', '>30 km/h'].map((l, i) => <span key={l}><i style={{ background: SPEED_COLORS[i] }} />{l}</span>)}
      </div>

      <div className="sechead"><h2>Parte a parte<span className="sub">{fmtTime(r.startedAt || 0)}–{fmtTime(r.endedAt || 0)} · {segs.length} trecho(s)</span></h2></div>
      <ul className="stops">
        {segs.map(s => {
          const slow = avgPace != null && s.pace != null && s.pace > avgPace * 1.25;
          return (
            <li key={s.n} className={`seg ${focus?.n === s.n ? 'sel' : ''} ${slow ? 'slow' : ''}`} onClick={() => setFocus(focus?.n === s.n ? null : s)}>
              <span className="num">{s.n}</span>
              <div><div className="a">{s.from.label} → {s.to.label}</div>
                <div className="m">{fmtClock(s.dur)} · {s.dist != null ? fmtDist(s.dist) : 'sem GPS'}{s.stopped ? ` · parado ${fmtDur(s.stopped)}` : ''}</div></div>
              <div className="v">{s.kmh != null ? `${s.kmh.toFixed(0)} km/h` : ''}{slow && <div className="m" style={{ color: 'var(--bad)' }}>mais lento</div>}</div>
            </li>
          );
        })}
        {!segs.length && <li className="stop muted">Nenhuma entrega registrada nesta rota.</li>}
      </ul>
    </Shell>
  );
}
