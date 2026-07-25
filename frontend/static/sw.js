const CACHE_PREFIX = 'travelplan-v1';
const ASSET_CACHE = CACHE_PREFIX + '-assets';
const PAGE_CACHE = CACHE_PREFIX + '-pages';

const PAGE_PATTERNS = [
  /^\/plans\/\d+$/,              
  /^\/plans\/\d+\/timeline$/,    
  /^\/plans\/\d+\/navigation$/,  
];

const STATIC_EXT = ['.css', '.js', '.png', '.svg', '.ico', '.json'];

function isStaticAsset(url) {
  return STATIC_EXT.some(ext => url.pathname.endsWith(ext));
}

function isTargetPage(url) {
  return PAGE_PATTERNS.some(p => p.test(url.pathname));
}

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(k => k.startsWith('travelplan-') && k !== ASSET_CACHE && k !== PAGE_CACHE)
          .map(k => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (url.origin !== location.origin) return;

  if (isTargetPage(url)) {
    event.respondWith(networkFirst(event.request, PAGE_CACHE));
  } else if (isStaticAsset(url)) {
    event.respondWith(cacheFirst(event.request, ASSET_CACHE));
  }
});

async function networkFirst(request, cacheName) {
  try {
    const res = await fetch(request);
    const cache = await caches.open(cacheName);
    cache.put(request, res.clone());
    return res;
  } catch {
    const cached = await caches.match(request);
    if (cached) return cached;
    return new Response('Offline', { status: 503 });
  }
}

async function cacheFirst(request, cacheName) {
  const cached = await caches.match(request);
  if (cached) return cached;
  try {
    const res = await fetch(request);
    const cache = await caches.open(cacheName);
    cache.put(request, res.clone());
    return res;
  } catch {
    return new Response('Offline', { status: 503 });
  }
}
