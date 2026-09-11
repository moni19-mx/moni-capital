// public/sw.js
// Sprint P4.2 (PWA Foundation), actualizado en Sprint P4.2.1 (Cache
// Policy Parity). Service worker minimo, escrito a mano (sin
// vite-plugin-pwa/Workbox). La politica de que se cachea y que no --
// antes duplicada aqui a mano -- ahora vive en un unico lugar:
// public/pwa-cache-policy.js, cargado con importScripts() (la forma
// nativa de un service worker CLASICO de compartir codigo, soportada en
// todos los navegadores -- se evita to type:"module" a proposito, sin
// soporte confiable en iOS Safari). Este archivo nunca vuelve a decidir
// por si mismo si una ruta es cacheable: solo ejecuta la estrategia que
// resolveCacheStrategy() ya decidio.

importScripts("/pwa-cache-policy.js");

const CACHE_VERSION = "moni-capital-shell-v1";

self.addEventListener("install", () => {
  // Intencionalmente vacio: nada que precachear en install. El app
  // shell (index.html + /assets/*) se cachea de forma perezosa la
  // primera vez que se visita, no de antemano -- evita duplicar aqui la
  // lista de bundles hasheados que Vite genera en cada build.
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k)))
    )
  );
});

self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") {
    self.skipWaiting();
  }
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return; // POST/PUT/PATCH/DELETE (todas las escrituras) nunca pasan por el SW

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // nunca intercepta terceros (Supabase, Binance, FMP, Google Fonts, etc.)

  const strategy = self.MoniPwaPolicy.resolveCacheStrategy(url.pathname, { mode: req.mode });

  if (strategy === "network-only") return; // financiero/desconocido: dejar pasar tal cual, jamas tocar Cache API
  if (strategy === "network-first") { event.respondWith(networkFirst(req)); return; }
  if (strategy === "cache-first") { event.respondWith(cacheFirst(req)); return; }
  if (strategy === "stale-while-revalidate") { event.respondWith(staleWhileRevalidate(req)); return; }
});

async function networkFirst(req) {
  try {
    const fresh = await fetch(req);
    const cache = await caches.open(CACHE_VERSION);
    cache.put(req, fresh.clone());
    return fresh;
  } catch (err) {
    const cached = await caches.match(req);
    if (cached) return cached;
    throw err;
  }
}

async function cacheFirst(req) {
  const cached = await caches.match(req);
  if (cached) return cached;
  const fresh = await fetch(req);
  const cache = await caches.open(CACHE_VERSION);
  cache.put(req, fresh.clone());
  return fresh;
}

async function staleWhileRevalidate(req) {
  const cache = await caches.open(CACHE_VERSION);
  const cached = await cache.match(req);
  const networkPromise = fetch(req)
    .then((fresh) => {
      cache.put(req, fresh.clone());
      return fresh;
    })
    .catch(() => null);
  return cached || (await networkPromise) || fetch(req);
}
