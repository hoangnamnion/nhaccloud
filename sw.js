// Service Worker for AmbiMusic PRO PWA
const CACHE_NAME = 'ambimusic-cache-v4';
const ASSETS_TO_CACHE = ['./', './index.html', './style.css', './app.js', './manifest.json', './icon.svg'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS_TO_CACHE)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  // Chỉ xử lý GET cùng origin; bỏ qua Telegram API, font, blob và request Range của audio
  if (req.method !== 'GET' || url.origin !== self.location.origin || req.headers.has('range')) return;
  // Không bao giờ cache API của server (danh sách bài, stream nhạc, ảnh bìa)
  if (url.pathname.startsWith('/api/')) return;

  // Network-first: luôn lấy bản mới khi có mạng, rớt mạng thì dùng cache (offline vẫn chạy)
  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req).then((hit) => hit || caches.match('./index.html')))
  );
});
