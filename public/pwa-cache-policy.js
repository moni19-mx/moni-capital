// public/pwa-cache-policy.js
// Sprint P4.2.1 (PWA Cache Policy Parity). UNICA fuente de verdad de que
// rutas puede cachear el service worker y cuales son financieras/nunca
// cacheables -- antes de este sprint, public/sw.js reimplementaba (a
// mano, "en la forma mas literal posible") la misma logica que
// lib/pwaCacheStrategy.js, dos archivos que podian divergir sin que nada
// lo detectara salvo disciplina humana. Ahora hay un solo archivo con la
// logica real; los otros dos (lib/pwaCacheStrategy.js y public/sw.js)
// solo lo cargan.
//
// Escrito deliberadamente SIN `import`/`export` (sintaxis de modulo ES)
// para poder cargarse de 2 formas identicas -- ejecutando literalmente
// este mismo archivo, sin volver a duplicar una sola linea de logica en
// ningun lado:
//
// 1. public/sw.js (service worker CLASICO, sin type:"module" -- eso es
//    necesario para soporte real en iOS Safari, que no soporta module
//    service workers de forma confiable) lo carga con importScripts(),
//    la forma nativa de un worker clasico de cargar codigo compartido,
//    soportada por TODOS los navegadores desde siempre.
// 2. lib/pwaCacheStrategy.js (usado por node:test y por cualquier codigo
//    server-side futuro) lo importa como modulo ES por efecto lateral --
//    bajo "type":"module" de package.json, Node trata cualquier archivo
//    .js sin import/export como un modulo ES valido igual (solo sin
//    exports nombrados propios), ejecuta su codigo de nivel superior de
//    todas formas, y este archivo publica su API en
//    globalThis.MoniPwaPolicy en vez de con `export`.
//
// Cambiar la politica de cache financiera SOLO requiere editar ESTE
// archivo -- lib/pwaCacheStrategy.js y public/sw.js ya no tienen logica
// propia que pueda quedar desincronizada.

(function (global) {
  // Cualquier ruta bajo estos prefijos es dinamica/financiera y JAMAS
  // debe servirse desde cache -- network-only real, sin tocar Cache API.
  const NEVER_CACHE_PREFIXES = ["/api/", "/rest/v1/", "/auth/v1/"];

  function isNeverCachePath(pathname) {
    return NEVER_CACHE_PREFIXES.some((p) => pathname.startsWith(p));
  }

  // App shell (index.html): siempre intenta red primero. Cache solo como
  // fallback offline -- servir un index.html viejo puede apuntar a
  // bundles hasheados que ya no existen tras un deploy nuevo.
  function isAppShellPath(pathname) {
    return pathname === "/" || pathname === "/index.html";
  }

  // Bundles de Vite bajo /assets/ llevan hash de contenido en el nombre
  // -- una URL nunca cambia de contenido, cache-first es seguro.
  function isImmutableBuildAsset(pathname) {
    return pathname.startsWith("/assets/");
  }

  // Iconos/manifest: estaticos, no financieros, se sirven
  // stale-while-revalidate (cache-first con refresco en background).
  function isStaticShellAsset(pathname) {
    return (
      pathname.startsWith("/icons/") ||
      pathname === "/manifest.webmanifest" ||
      pathname === "/favicon.ico"
    );
  }

  // Decision final. `options.mode` es el `request.mode` del Fetch API
  // ("navigate" para una navegacion real de pestaña/tab -- click en un
  // link, refresh, deep link -- nunca para un fetch()/XHR de datos).
  // Sprint P4.2.1: esta app no tiene router (start_url "/" siempre es
  // correcto), pero una navegacion real de pestaña a cualquier ruta
  // propia que no matchee nada de arriba debe poder recibir el app
  // shell como fallback offline, igual que "/" -- SOLO despues de
  // descartar network-only (por eso ese check va primero siempre: una
  // navegacion de pestaña a algo bajo /api/ o /rest/v1/, aunque el
  // navegador nunca genera eso en la practica, sigue siendo
  // network-only, nunca app-shell).
  function resolveCacheStrategy(pathname, options) {
    const mode = options && options.mode;
    if (isNeverCachePath(pathname)) return "network-only";
    if (isAppShellPath(pathname)) return "network-first";
    if (isImmutableBuildAsset(pathname)) return "cache-first";
    if (isStaticShellAsset(pathname)) return "stale-while-revalidate";
    if (mode === "navigate") return "network-first";
    return "network-only"; // default seguro: ruta no reconocida, no financiera, no navegacion -> nunca se cachea
  }

  global.MoniPwaPolicy = {
    NEVER_CACHE_PREFIXES,
    isNeverCachePath,
    isAppShellPath,
    isImmutableBuildAsset,
    isStaticShellAsset,
    resolveCacheStrategy,
  };
})(typeof self !== "undefined" ? self : globalThis);
