// عامل الخدمة: يحفظ ملفات الواجهة لتعمل نقطة البيع دون اتصال. طلبات /api لا تُحفظ أبدًا.
const CACHE = 'frs-shell-v40';
const SHELL = ['/', '/index.html', '/css/app.css', '/icon.svg', '/manifest.webmanifest', '/js/app.js', '/js/lib.js', '/js/offline.js',
  '/js/pages/dashboard.js', '/js/pages/pos.js', '/js/pages/docs.js', '/js/pages/purchases.js', '/js/pages/cash.js', '/js/pages/stock.js',
  '/js/pages/reps.js', '/js/pages/masters.js', '/js/pages/addstock.js', '/js/pages/reports.js', '/js/pages/admin.js'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k.startsWith('frs-') && k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return;
  // الشبكة أولاً للحصول على آخر نسخة، والمحفوظ عند الانقطاع
  e.respondWith(fetch(e.request).then((res) => {
    if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
    return res;
  }).catch(() => caches.match(e.request).then((r) => r || (e.request.mode === 'navigate' ? caches.match('/index.html') : Response.error()))));
});
