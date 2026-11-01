const CACHE = 'finisboy-v38';
const TILES = 'finisboy-tiles';       // blocos do mapa: sobrevivem às atualizações do app
const MAX_TILES = 8000;

const SHELL = [
  './', './index.html', './style.css', './app.js', './parse.js', './offline.js', './live.js', './auth.js', './avatar.js', './voice.js', './voicenav.js', './earnings.js', './history.js', './manifest.json',
  './icon-192.png', './icon-512.png', './logo.png',
  './vendor/leaflet.js', './vendor/leaflet.css',
  './vendor/images/layers.png', './vendor/images/layers-2x.png',
  './vendor/images/marker-icon.png', './vendor/images/marker-icon-2x.png', './vendor/images/marker-shadow.png',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(
    ks.filter(k => k !== CACHE && k !== TILES).map(k => caches.delete(k))
  )));
  self.clients.claim();
});

let puts = 0;
async function trimTiles(cache) {
  const keys = await cache.keys();
  if (keys.length > MAX_TILES) await Promise.all(keys.slice(0, keys.length - MAX_TILES + 500).map(k => cache.delete(k)));
}

// Mapa: usa o bloco salvo; se não tiver, busca na rede e guarda (tudo que você já viu fica disponível offline).
async function tile(req) {
  const cache = await caches.open(TILES);
  const hit = await cache.match(req.url);
  if (hit) return hit;
  try {
    const res = await fetch(req);
    if (res.ok) {
      await cache.put(req.url, res.clone());
      if (++puts % 100 === 0) trimTiles(cache);
    }
    return res;
  } catch {
    return Response.error();     // sem internet e sem bloco salvo: o mapa fica em branco nesse ponto
  }
}

// Interface: abre do aparelho e atualiza em segundo plano quando há internet.
async function shell(req) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(req, { ignoreSearch: true });
  const net = fetch(req).then(r => { if (r.ok) cache.put(req, r.clone()); return r; }).catch(() => null);
  if (hit) return hit;
  return (await net) || (req.mode === 'navigate' ? cache.match('./index.html') : Response.error());
}

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.pathname.startsWith('/api/')) return;                       // contas e sincronização: sempre direto na rede, nunca em cache
  if (url.hostname === 'tile.openstreetmap.org') e.respondWith(tile(req));
  else if (url.origin === location.origin) e.respondWith(shell(req));
  // Nominatim e OSRM passam direto: o app trata a falta de internet.
});
