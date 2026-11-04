// TurboSlug (Next.js): rede primeiro, com cópia no aparelho para abrir sem internet.
// A versão antiga deste arquivo guardava o app antigo em cache: ao ativar, apaga tudo (menos os blocos do mapa).
const PAGES = 'turboslug-next-v2';
const TILES = 'turboslug-tiles';       // blocos do mapa: sobrevivem às atualizações do app
const MAX_TILES = 8000;

self.addEventListener('install', () => { self.skipWaiting(); });

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== PAGES && k !== TILES) await caches.delete(k);
    await self.clients.claim();
  })());
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

// Páginas e arquivos do app: sempre a versão nova da rede; sem internet, a última que foi aberta.
async function app(req) {
  const cache = await caches.open(PAGES);
  try {
    const res = await fetch(req);
    if (res.ok && !res.redirected) cache.put(req, res.clone());
    return res;
  } catch {
    return (await cache.match(req)) || (req.mode === 'navigate' ? await cache.match('/rotas') : null) || Response.error();
  }
}

// Arquivos do leitor de comanda (OCR, ~9 MB): não mudam, então usa a cópia do aparelho e só busca na rede na primeira vez.
async function asset(req) {
  const cache = await caches.open(PAGES);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok) cache.put(req, res.clone());
  return res;
}

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.pathname.startsWith('/api/')) return;                       // contas e sincronização: sempre direto na rede, nunca em cache
  if (url.hostname === 'tile.openstreetmap.org') e.respondWith(tile(req));
  else if (url.origin === location.origin && url.pathname.startsWith('/ocr/')) e.respondWith(asset(req));
  else if (url.origin === location.origin) e.respondWith(app(req));
  // ViaCEP, Nominatim e OSRM passam direto: o app trata a falta de internet.
});
