/* NovaList offline support (service worker).
 * Works when the program is opened from a web address (e.g. GitHub Pages), not from a file on disk.
 * - On first visit everything the program needs is saved on the device: the program, the user guide
 *   and all the army data listed in data/manifest.js.
 * - When online, files are always checked with the server (so updates appear straight away) and the saved copy is
 *   refreshed; when offline, the saved copy is used.
 */
const CACHE = 'novalist-v1';
const CORE = [
  './', 'index.html', 'editor.html', 'help.html', 'manifest.webmanifest',
  'css/app.css', 'css/editor.css',
  'js/engine.js', 'js/listio.js', 'js/app.js', 'js/play.js', 'js/bsformat.js', 'js/datacheck.js', 'js/editor.js',
  'data/manifest.js',
  'icons/app-192.png', 'icons/app-512.png', 'icons/app-maskable-512.png', 'icons/apple-touch-icon.png',
  'icons/Disruption.png', 'icons/PriorityAssets.png', 'icons/PurgeTheFoe.png', 'icons/Reconnaissance.png', 'icons/TakeAndHold.png',
];

// everything to save: the core files, every army data file, and the user guide's pictures
async function fileList() {
  const out = new Set(CORE);
  try {
    const m = await (await fetch('data/manifest.js', { cache: 'no-cache' })).text();
    for (const x of m.matchAll(/"file"\s*:\s*"([^"]+)"/g)) out.add('data/' + x[1]);
  } catch (e) { /* offline during install – core files only */ }
  try {
    const h = await (await fetch('help.html', { cache: 'no-cache' })).text();
    for (const x of h.matchAll(/src="((?:help|icons)\/[^"]+)"/g)) out.add(x[1]);
  } catch (e) { /* ignore */ }
  return [...out];
}

async function saveAll() {
  const c = await caches.open(CACHE);
  const list = await fileList();
  // one at a time in small batches, so a slow connection isn't swamped and one failure doesn't stop the rest
  for (let i = 0; i < list.length; i += 6) {
    await Promise.all(list.slice(i, i + 6).map(u => c.add(new Request(u, { cache: 'no-cache' })).catch(() => {})));
  }
}

self.addEventListener('install', (ev) => {
  ev.waitUntil((async () => {
    const c = await caches.open(CACHE);
    await Promise.all(CORE.map(u => c.add(new Request(u, { cache: 'no-cache' })).catch(() => {})));
    self.skipWaiting();
  })());
});

self.addEventListener('activate', (ev) => {
  ev.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== CACHE && k.startsWith('novalist-')) await caches.delete(k);
    await self.clients.claim();
  })());
});

// each page asks for everything to be saved/refreshed in the background once it has loaded.
// Files that haven't changed come back as "not modified", so this is quick after the first time.
let saving = null;
self.addEventListener('message', (ev) => {
  if (ev.data !== 'save-all') return;
  if (!saving) saving = saveAll().finally(() => { saving = null; });
  ev.waitUntil(saving);
});

self.addEventListener('fetch', (ev) => {
  const req = ev.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  ev.respondWith((async () => {
    const c = await caches.open(CACHE);
    try {
      // always ask the server whether the file changed (cheap "not modified" reply when it hasn't),
      // so the phone's browser cache can't hand back an old copy of the program or army data
      const res = await (req.mode === 'navigate' ? fetch(req.url, { cache: 'no-cache', credentials: 'same-origin' }) : fetch(new Request(req, { cache: 'no-cache' })));
      if (res.ok && res.type === 'basic') c.put(req, res.clone()).catch(() => {});
      return res;
    } catch (e) {
      const hit = await c.match(req, { ignoreSearch: true });
      if (hit) return hit;
      if (req.mode === 'navigate') { const page = await c.match(url.pathname.endsWith('/') ? './' : 'index.html'); if (page) return page; }
      throw e;
    }
  })());
});
