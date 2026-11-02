// Registros guardados no aparelho (IndexedDB) e no backup. Mesmos campos do app antigo.
import type { Step } from './nav';

export type RouteStatus = 'pendente' | 'andamento' | 'finalizada';
export type Precision = 'house' | 'street' | 'cep' | 'manual';
export type LatLon = { lat: number; lon: number };

export interface RouteGeo {
  coords: [number, number][];
  distance: number;
  duration: number;
  approx: boolean;
  baseline: { duration: number; distance: number } | null;
  steps?: Step[] | null;             // manobras para a voz (curva a curva)
  learned?: boolean;                 // a rota fugiu de trechos lentos aprendidos
}

export interface Route {
  id: string; name: string; createdAt: number; status: RouteStatus;
  km: number; kmPlan?: number; kmFinal?: number; kmSrc?: 'gps' | 'plan';
  startedAt?: number; legStartedAt?: number; endedAt?: number;
  lastPt?: LatLon | null; profileId?: string;
  geo?: RouteGeo | null;
}

export interface Stop {
  id: string; routeId: string;
  raw: string; note: string; cep: string | null; cityGuess: string;
  sender: string | null; when: string | null; addedAt: number;
  lat: number | null; lon: number | null; label?: string;
  done: boolean; doneAt?: number; durSec?: number; order: number;
  failed?: boolean; approx?: boolean; src?: string; precision?: Precision;
  legDist?: number | null; legDur?: number | null;
}

export interface Delivery { id: string; routeId: string; doneAt: number }
