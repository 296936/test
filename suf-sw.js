const CACHE = 'alis-suf-staticrypt-v1';
const REPORT = new URL('/suf.html', self.location.origin).href;

async function cacheReport(cache, response) {
  if (!response.ok || response.redirected ||
      !response.headers.get('content-type')?.includes('text/html')) return;
  const html = await response.clone().text();
  if (html.includes('"staticryptEncryptedMsgUniqueVariableName":')) {
    await cache.put(REPORT, response.clone());
  }
}

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    const response = await fetch(REPORT, {cache: 'reload'});
    await cacheReport(cache, response);
    if (!await cache.match(REPORT)) throw new Error('Encrypted report is unavailable');
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || request.mode !== 'navigate' ||
      url.origin !== self.location.origin || url.pathname !== '/suf.html') return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE).catch(() => null);
    let response;
    try {
      response = await fetch(request, {cache: 'no-cache'});
    } catch {
      return (await cache?.match(REPORT)) || Response.error();
    }
    if (cache && response.ok) {
      await cacheReport(cache, response).catch(() => {});
    } else if (response.status >= 500) {
      return (await cache?.match(REPORT)) || response;
    }
    return response;
  })());
});
