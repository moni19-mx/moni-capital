// lib/pwaCacheStrategy.js
// Sprint P4.2.1 (PWA Cache Policy Parity). Shim de re-exportacion -- la
// logica real vive en public/pwa-cache-policy.js (tiene que ser un
// archivo estatico servible por HTTP para que public/sw.js lo cargue via
// importScripts(), la unica forma de compartir codigo con un service
// worker CLASICO sin requerir type:"module", sin soporte confiable en
// iOS Safari; ver ese archivo para el detalle completo). Este modulo
// solo importa ese archivo por efecto lateral (bajo "type":"module" de
// package.json, un .js sin import/export sigue siendo un modulo ES
// valido) y re-exporta su API, para que node:test y cualquier codigo
// server-side futuro sigan pudiendo hacer
// `import { resolveCacheStrategy } from "../lib/pwaCacheStrategy.js"`
// sin conocer ese detalle de implementacion.
//
// Cero logica propia en este archivo a proposito: no hay una segunda
// copia de NEVER_CACHE_PREFIXES ni de ninguna funcion de clasificacion
// que pueda desincronizarse de la que realmente ejecuta el navegador.

import "../public/pwa-cache-policy.js";

const policy = globalThis.MoniPwaPolicy;

export const NEVER_CACHE_PREFIXES = policy.NEVER_CACHE_PREFIXES;
export const isNeverCachePath = policy.isNeverCachePath;
export const isAppShellPath = policy.isAppShellPath;
export const isImmutableBuildAsset = policy.isImmutableBuildAsset;
export const isStaticShellAsset = policy.isStaticShellAsset;
export const resolveCacheStrategy = policy.resolveCacheStrategy;
