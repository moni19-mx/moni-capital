// public/sw.js
// Sprint P4.2 (PWA Foundation). Service worker minimo, escrito a mano
// (sin vite-plugin-pwa/Workbox) para que TODA la logica de que se
// cachea y que no quepa en un solo archivo auditable, en vez de
// depender de la configuracion implicita de runtime caching de una
// libreria. Justificacion: el requisito no-negociable de este sprint es
// "REAL FINANCIAL DATA > CONVENIENCE" -- ningun endpoint dinamico
// (Supabase REST, /api/*) puede quedar cacheado nunca. Auditar "el
// service worker nunca toca /api/ ni /rest/v1/" es mas simple sobre un
// archivo propio de ~80 lineas que sobre una config de Workbox con
// estrategias de runtime caching generadas.
//
// Las 4 estrategias de abajo replican exactamente la logica pura y
// probada de lib/pwaCacheStrategy.js (ver tests/pwaCacheStrategy.test.js)
// -- un service worker no puede importar ese modulo directamente sin
// convertir el registro a type:"module" con menos soporte de navegador,
// asi que la logica se duplica aqui a proposito, en la forma mas
// literal posible, para que un diff entre ambos archivos sea trivial de
// revisar.

const CACHE_VERSION = "moni-capital-shell-v1";

const NEVER_CACHE_PREFIXES = ["/api/", "/rest/v1/", "/auth/v1/"];

function isNeverCachePath(pathname) {
  return NEVER_CACHE_PREFIXES.some((p) => pathname.startsWith(p));
}
function isAppShellPath(pathname) {
  return pathname === "/" || pathname === "/index.html";
}
function isImmutableBuildAsset(pathname) {
  return pathname.startsWith("/assets/");
}
function isStaticShellAsset(pathname) {
  return (
    pathname.startsWith("/icons/") ||
    pathname === "/manifest.webmanifest" ||
    pathname === "/favicon.ico"
  );
}

// No self.skipWaiting() automatico en install: un SW nuevo se queda
// "waiting" hasta que la app, con el usuario ya avisado por el banner
// "Hay una nueva version" (ver src/App.jsx), mande el postMessage
// SKIP_WAITING de abajo. Evita reemplazar el SW activo (y su version de
// JS/CSS) mientras el usuario esta a mitad de un flujo como Smart
// Import.
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
  if (req.method !== "GET") return; // POST/PUT/DELETE (todas las escrituras) nunca pasan por el SW

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // nunca intercepta terceros (Binance, FMP, etc.)

  const pathname = url.pathname;

  // Financiero/dinamico: dejar pasar tal cual, jamas tocar Cache API.
  if (isNeverCachePath(pathname)) return;

  if (isAppShellPath(pathname)) {
    event.respondWith(networkFirst(req));
    return;
  }
  if (isImmutableBuildAsset(pathname)) {
    event.respondWith(cacheFirst(req));
    return;
  }
  if (isStaticShellAsset(pathname)) {
    event.respondWith(staleWhileRevalidate(req));
    return;
  }
  // Default seguro: cualquier ruta no reconocida no se cachea.
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
