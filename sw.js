/* ═══════════════════════════════════════════════════════════════
   SW.JS — HAMRO AFNAI  Service Worker
   Strategy:
   • Admin panel      → NEVER intercepted. Always live network.
   • index.html/shell → network-first, fallback to cache.
   • API/getFile      → network-first, cache successful responses.
   • Stale clearance  → on activate, delete all old caches.
   ═══════════════════════════════════════════════════════════════ */

// 👇 Change this name whenever you update shell files to force all devices
//    to fetch fresh copies and discard the previous cache.
const CACHE_NAME = 'ha-shell-v1';   // fresh start – all previous caches will be wiped

const SHELL = [
  './',
  './index.html',
  './user.html',
  './app.js',
  './chapters-data.js',
  './manifest.json'
  // NOTE: admin.html is deliberately NOT in SHELL – it must never be
  // served from cache, so there's no reason to precache it either.
];

/* Is this request from the admin panel? */
async function isAdminOrigin(request, clientId) {
  const url = new URL(request.url);
  if (url.pathname.endsWith('admin.html')) return true;
  if (!clientId) return false;
  try {
    const client = await self.clients.get(clientId);
    return !!(client && client.url && client.url.includes('admin.html'));
  } catch (e) {
    return false;
  }
}

/* ----- INSTALL: precache the shell and skip waiting (activate immediately) ----- */
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_NAME)
      .then(c => c.addAll(SHELL))
      .catch(err => console.warn('SW install: some files not cached', err))
  );
  self.skipWaiting();  // 👈 forces the new SW to activate right away
});

/* ----- ACTIVATE: delete all old caches and claim all pages ----- */
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();  // 👈 takes control of all open pages immediately
});

/* Remove cached entries not in the current SHELL (e.g., old admin.html leftovers). */
async function clearStaleShellEntries() {
  const cache = await caches.open(CACHE_NAME);
  const keys = await cache.keys();
  const shellAbs = new Set(SHELL.map(p => new URL(p, self.registration.scope).href));
  await Promise.all(keys.map(req => {
    const url = new URL(req.url);
    const isApi = url.hostname.includes('script.google.com'); // leave API entries alone
    if (isApi) return Promise.resolve();
    if (!shellAbs.has(req.url)) {
      return cache.delete(req);
    }
    return Promise.resolve();
  }));
}

/* Listen for clear‑stale message from app.js (optional) */
self.addEventListener('message', e => {
  if (e.data && e.data.type === 'CLEAR_STALE_IF_ONLINE') {
    e.waitUntil ? e.waitUntil(clearStaleShellEntries()) : clearStaleShellEntries();
  }
});

/* ----- FETCH: network-first for everything except admin ----- */
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  e.respondWith((async () => {
    const fromAdmin = await isAdminOrigin(e.request, e.clientId);

    /* ── ADMIN: bypass SW entirely ── */
    if (fromAdmin) {
      return fetch(e.request);
    }

    /* ── API calls: network-first ── */
    if (url.hostname.includes('script.google.com')) {
      const isGetFile = (url.searchParams.get('action') || '').toLowerCase() === 'getfile';
      try {
        const res = await fetch(e.request.clone());
        if (isGetFile && res.ok) {
          const clone = res.clone();
          caches.open(CACHE_NAME).then(c => c.put(e.request, clone));
        }
        clearStaleShellEntries();
        return res;
      } catch (err) {
        if (isGetFile) {
          const cached = await caches.match(e.request);
          if (cached) return cached;
        }
        // Do not return a fabricated offline response—let the page handle the error.
        throw err;
      }
    }

    /* ── App shell: network-first with cache fallback ── */
    try {
      const res = await fetch(e.request.clone(), { cache: 'no-store' });
      if (res.ok) {
        const clone = res.clone();
        caches.open(CACHE_NAME).then(c => c.put(e.request, clone));
      }
      return res;
    } catch (err) {
      const cached = await caches.match(e.request);
      return cached || new Response('Offline', { status: 503 });
    }
  })());
});
