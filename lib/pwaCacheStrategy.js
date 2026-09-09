// lib/pwaCacheStrategy.js
// Sprint P4.2 (PWA Foundation). Clasificacion PURA de que puede cachear
// el service worker (public/sw.js) y que NUNCA puede tocar.
//
// Principio de este sprint: REAL FINANCIAL DATA > CONVENIENCE. El
// service worker jamas debe convertirse en una fuente de verdad
// financiera -- eso rompe el sistema OK/STALE/ERROR/NEVER_LOADED de
// lib/dataSourceState.js (Sprint P0.1), que depende de que cada fetch()
// realmente toque la red para poder distinguir "dato fresco" de "dato
// viejo mostrado a proposito". Un cache-first en un endpoint financiero
// haria que ese fetch() siempre "tenga exito" con datos potencialmente
// obsoletos, indistinguibles de datos frescos.
//
// Estas funciones no tocan Cache API, no tocan self/caches -- son
// puras (string -> boolean) para poder probarlas con node:test igual
// que el resto del proyecto, sin un entorno de browser/service worker.

// Cualquier ruta bajo estos prefijos es dinamica/financiera y JAMAS debe
// sevirse desde cache. El service worker debe hacer network-only aqui
// (dejar pasar el fetch tal cual, sin interceptar la respuesta).
const NEVER_CACHE_PREFIXES = [
  "/api/", // market-data, futures-equity, market-pulse, search, manage, ai, smart-import, snapshot
  "/rest/v1/", // Supabase PostgREST directo (positions, transactions, smart_imports, etc.)
  "/auth/v1/", // Supabase Auth (aunque hoy no se usa, nunca cachear)
];

export function isNeverCachePath(pathname) {
  return NEVER_CACHE_PREFIXES.some((p) => pathname.startsWith(p));
}

// El "app shell" es el HTML de entrada -- SIEMPRE debe intentar red
// primero. Si se sirve de cache un index.html viejo, puede apuntar a
// bundles JS/CSS hasheados que ya no existen en un deploy nuevo. Cache
// solo como fallback offline (estado C del sprint: "OFFLINE + APP SHELL
// DISPONIBLE").
export function isAppShellPath(pathname) {
  return pathname === "/" || pathname === "/index.html";
}

// Assets de build de Vite (JS/CSS bajo /assets/) llevan hash de
// contenido en el nombre de archivo -- una URL nunca cambia de
// contenido. Cache-first es seguro: un deploy nuevo genera un hash (y
// por lo tanto una URL) distinta, nunca reescribe la anterior.
export function isImmutableBuildAsset(pathname) {
  return pathname.startsWith("/assets/");
}

// Iconos/manifest: estaticos, casi nunca cambian, pero no llevan hash en
// el nombre -- se sirven stale-while-revalidate (cache-first pero con
// refresco en background), nunca network-only (no son financieros, no
// hay riesgo de mostrar datos viejos como si fueran nuevos).
export function isStaticShellAsset(pathname) {
  return (
    pathname.startsWith("/icons/") ||
    pathname === "/manifest.webmanifest" ||
    pathname === "/favicon.ico"
  );
}

// Decision final que usa public/sw.js en su handler de "fetch". Devuelve
// una de: "network-only" | "network-first" | "cache-first" | "stale-while-revalidate".
export function resolveCacheStrategy(pathname) {
  if (isNeverCachePath(pathname)) return "network-only";
  if (isAppShellPath(pathname)) return "network-first";
  if (isImmutableBuildAsset(pathname)) return "cache-first";
  if (isStaticShellAsset(pathname)) return "stale-while-revalidate";
  return "network-only"; // default seguro: cualquier ruta no reconocida nunca se cachea
}
