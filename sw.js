const CACHE_NAME = 'vcard-media-v1';

const rangeResponse = async (response, rangeHeader) => {
  const match = /^bytes=(\d*)-(\d*)$/i.exec(rangeHeader || '');
  if (!match) return response;
  if (!match[1] && !match[2]) return response;
  const buffer = await response.arrayBuffer();
  const size = buffer.byteLength;
  let start = match[1] === '' ? 0 : Number(match[1]);
  let end = match[2] === '' ? size - 1 : Number(match[2]);
  if (match[1] === '') {
    start = Math.max(0, size - end);
    end = size - 1;
  }
  end = Math.min(size - 1, end);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || start > end) {
    return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
  }
  return new Response(buffer.slice(start, end + 1), {
    status: 206,
    statusText: 'Partial Content',
    headers: {
      'Content-Type': response.headers.get('Content-Type') || 'application/octet-stream',
      'Content-Length': String(end - start + 1),
      'Content-Range': `bytes ${start}-${end}/${size}`,
      'Accept-Ranges': 'bytes',
    },
  });
};

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

const reportMediaSource = (event, url, source) => {
  const clientId = event.clientId || event.resultingClientId;
  if (!clientId) return;
  event.waitUntil(self.clients.get(clientId).then((client) => {
    client?.postMessage({ type: 'vcard-media-source', url, source });
  }).catch(() => {}));
};

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);
  const mediaPath = /\/(?:sys|usr)\//i.test(url.pathname);
  const mediaFile = /\.(?:aac|aiff?|avif|flac|gif|jpe?g|m4a|m4v|mov|mp3|mp4|oga|ogg|ogv|opus|png|svg|wav|webm|webp)$/i.test(url.pathname);
  if (request.method !== 'GET' || url.origin !== self.location.origin || !mediaPath || !mediaFile) return;
  event.respondWith((async () => {
    let cached = null;
    try { cached = await (await caches.open(CACHE_NAME)).match(url.href); } catch (_error) { }
    if (cached?.ok && cached.status !== 206 && !cached.headers.has('Content-Range')) {
      try {
        const response = request.headers.has('Range')
          ? await rangeResponse(cached, request.headers.get('Range'))
          : cached;
        reportMediaSource(event, url.href, 'cache');
        return response;
      } catch (_error) { }
    }
    const response = await fetch(request);
    reportMediaSource(event, url.href, 'loaded');
    return response;
  })());
});
