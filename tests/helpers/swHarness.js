// tests/helpers/swHarness.js
// Sprint P4.2.1 (PWA Cache Policy Parity). Ejecuta el archivo REAL
// public/sw.js (y, via su propio importScripts(), el archivo REAL
// public/pwa-cache-policy.js) dentro de un contexto vm de Node con un
// scope global de service worker minimamente mockeado.
//
// Por que: un test que reimplementa a mano "lo que sw.js deberia hacer"
// y lo compara contra si mismo no prueba nada -- si alguien rompe el
// fetch handler real (reordena un check, hardcodea una estrategia,
// olvida llamar a resolveCacheStrategy) ese tipo de test seguiria en
// verde. Este harness carga y corre el BYTECODE REAL de ambos archivos
// tal como los serviría Vercel, y expone solo una funcion --
// dispatchFetch()-- para disparar un fetch event sintetico y observar
// que decidio el service worker de verdad: si llamo a
// event.respondWith() (y con que estrategia) o si dejo pasar la
// request intacta (nunca toco Cache API).

import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../..");
const SW_PATH = path.join(REPO_ROOT, "public/sw.js");
const POLICY_PATH = path.join(REPO_ROOT, "public/pwa-cache-policy.js");

export const TEST_ORIGIN = "https://moni-capital.example";

function makeCachesMock() {
  const buckets = new Map(); // cacheName -> Map(url -> response)
  function bucketFor(name) {
    if (!buckets.has(name)) buckets.set(name, new Map());
    return buckets.get(name);
  }
  function keyFor(req) {
    return typeof req === "string" ? req : req.url;
  }
  return {
    open: async (name) => {
      const bucket = bucketFor(name);
      return {
        match: async (req) => bucket.get(keyFor(req)),
        put: async (req, res) => { bucket.set(keyFor(req), res); },
      };
    },
    match: async (req) => {
      for (const bucket of buckets.values()) {
        const hit = bucket.get(keyFor(req));
        if (hit) return hit;
      }
      return undefined;
    },
    keys: async () => Array.from(buckets.keys()),
    delete: async (name) => buckets.delete(name),
  };
}

function makeFakeResponse() {
  return {
    ok: true,
    status: 200,
    clone() { return makeFakeResponse(); },
  };
}

// Crea una instancia FRESCA del service worker real (sw.js +
// pwa-cache-policy.js via importScripts) para cada test -- nunca
// comparte estado de Cache API mock entre tests.
export function loadRealServiceWorker({ fetchImpl } = {}) {
  const listeners = {};
  const sandbox = {
    console,
    URL,
    self: undefined, // se asigna abajo a globalThis del contexto
    caches: makeCachesMock(),
    fetch: fetchImpl || (async () => makeFakeResponse()),
    importScripts(url) {
      // Resuelve SOLO /pwa-cache-policy.js -- el unico importScripts()
      // que el sw.js real usa hoy. Si algun dia se agrega otro import,
      // este mock fallaria fuerte (error explicito) en vez de fingir.
      if (url !== "/pwa-cache-policy.js") {
        throw new Error(`swHarness: importScripts mock no sabe resolver ${url}`);
      }
      const src = fs.readFileSync(POLICY_PATH, "utf8");
      vm.runInContext(src, context, { filename: POLICY_PATH });
    },
  };
  const context = vm.createContext(sandbox);
  // self === globalThis dentro de un worker real; replicamos eso.
  vm.runInContext("globalThis.self = globalThis;", context);
  vm.runInContext(
    `globalThis.self.location = { origin: ${JSON.stringify(TEST_ORIGIN)} };`,
    context
  );
  vm.runInContext(
    `globalThis.self.skipWaiting = function () {};`,
    context
  );
  vm.runInContext(
    `globalThis.self.addEventListener = function (type, handler) {
       globalThis.__listeners[type] = globalThis.__listeners[type] || [];
       globalThis.__listeners[type].push(handler);
     };`,
    context
  );
  vm.runInContext(`globalThis.__listeners = {};`, context);

  const swSrc = fs.readFileSync(SW_PATH, "utf8");
  vm.runInContext(swSrc, context, { filename: SW_PATH });

  const registeredListeners = vm.runInContext("globalThis.__listeners", context);

  function dispatch(type, event) {
    const handlers = registeredListeners[type] || [];
    for (const h of handlers) h(event);
    return event;
  }

  // Dispara un fetch event sintetico. path puede ser absoluto
  // (https://otra-cosa.tld/x) para simular cross-origin, o relativo
  // (empieza con "/") para same-origin (se le antepone TEST_ORIGIN).
  function dispatchFetch({ path, method = "GET", mode = "same-origin" }) {
    const url = path.startsWith("http") ? path : `${TEST_ORIGIN}${path}`;
    const request = { method, url, mode, clone() { return this; } };
    const event = {
      request,
      responded: false,
      respondedWithPromise: null,
      respondWith(promise) {
        event.responded = true;
        event.respondedWithPromise = promise;
      },
      waitUntil() {},
    };
    dispatch("fetch", event);
    return event;
  }

  return { context, dispatchFetch, dispatchActivate: () => dispatch("activate", { waitUntil() {} }) };
}
