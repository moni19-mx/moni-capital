// tests/swReal.test.js
// Sprint P4.2.1 (PWA Cache Policy Parity). Prueba el COMPORTAMIENTO REAL
// de public/sw.js (ejecutado tal cual, via tests/helpers/swHarness.js —
// ver ese archivo para el por que), no una reimplementacion de su
// logica. Dos grupos de tests:
//
// 1. INVARIANTES FAIL-CLOSED: para cada endpoint financiero nombrado
//    explicitamente, Supabase REST/RPC/Auth, cross-origin, y metodos de
//    escritura -- afirma directamente sobre el service worker real que
//    NUNCA responde desde cache (event.respondWith nunca se llama).
//    Estos tests no importan lib/pwaCacheStrategy.js en absoluto: son
//    correctos incluso si la politica y el service worker driftearan
//    juntos en la direccion equivocada (algo que un test de paridad por
//    si solo no detectaria).
// 2. PARIDAD/DRIFT: para un set amplio de rutas (incluidas
//    hipoteticas/futuras), afirma que la decision del service worker
//    real coincide exactamente con lib/pwaCacheStrategy.js. Como ambos
//    ahora cargan el mismo public/pwa-cache-policy.js (Sprint P4.2.1),
//    esto ya es estructuralmente imposible de romper por una edicion
//    aislada -- pero el test sigue protegiendo el CABLEADO (el fetch
//    handler de sw.js podria, en el futuro, dejar de llamar a
//    resolveCacheStrategy, hardcodear una rama, o invertir un orden de
//    checks; ese tipo de bug rompe la paridad sin tocar la politica).

import { test } from "node:test";
import assert from "node:assert/strict";
import { loadRealServiceWorker, TEST_ORIGIN } from "./helpers/swHarness.js";
import { resolveCacheStrategy } from "../lib/pwaCacheStrategy.js";

// ==========================================================
// 1. INVARIANTES FAIL-CLOSED (contra el service worker REAL)
// ==========================================================

const FINANCIAL_ENDPOINTS = [
  "/api/market-data",
  "/api/futures-equity",
  "/api/smart-import",
  "/api/ai",
  "/api/manage",
  "/api/snapshot",
  "/api/market-pulse",
  "/api/search",
];

for (const path of FINANCIAL_ENDPOINTS) {
  test(`fail-closed: GET ${path} nunca se responde desde el service worker (network-only real)`, () => {
    const sw = loadRealServiceWorker();
    const event = sw.dispatchFetch({ path, method: "GET" });
    assert.equal(event.responded, false, `${path} no debe pasar por event.respondWith()`);
  });
}

test("fail-closed: Supabase REST (/rest/v1/*) nunca se responde desde el SW", () => {
  const sw = loadRealServiceWorker();
  const event = sw.dispatchFetch({ path: "/rest/v1/positions?select=*", method: "GET" });
  assert.equal(event.responded, false);
});

test("fail-closed: Supabase RPC (/rest/v1/rpc/*) nunca se responde desde el SW", () => {
  const sw = loadRealServiceWorker();
  const event = sw.dispatchFetch({
    path: "/rest/v1/rpc/confirm_smart_import_futures_account_snapshot",
    method: "GET",
  });
  assert.equal(event.responded, false);
});

test("fail-closed: Supabase Auth (/auth/v1/*) nunca se responde desde el SW", () => {
  const sw = loadRealServiceWorker();
  const event = sw.dispatchFetch({ path: "/auth/v1/token", method: "GET" });
  assert.equal(event.responded, false);
});

for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
  test(`fail-closed: ${method} nunca se responde desde el SW, sin importar la ruta`, () => {
    const sw = loadRealServiceWorker();
    // Incluso una ruta que SI seria cacheable en GET (app shell) debe
    // ignorarse por completo si el metodo no es GET.
    const event = sw.dispatchFetch({ path: "/", method });
    assert.equal(event.responded, false);
  });
}

test("fail-closed: POST /api/smart-import nunca se responde desde el SW (nunca app-shell/cache)", () => {
  const sw = loadRealServiceWorker();
  const event = sw.dispatchFetch({ path: "/api/smart-import", method: "POST" });
  assert.equal(event.responded, false);
});

// ==========================================================
// CROSS-ORIGIN (verificado contra el SW real, no el classifier)
// ==========================================================

test("cross-origin: una request a *.supabase.co nunca es interceptada, aunque el pathname luzca como Supabase REST", () => {
  const sw = loadRealServiceWorker();
  const event = sw.dispatchFetch({
    path: "https://sjnobxdzlzcqnfjodxri.supabase.co/rest/v1/positions?select=*",
    method: "GET",
  });
  assert.equal(event.responded, false);
});

test("cross-origin: una request a *.supabase.co con pathname de asset estatico (/icons/...) TAMPOCO se intercepta -- el check de origen es incondicional, va antes que cualquier chequeo de ruta", () => {
  const sw = loadRealServiceWorker();
  const event = sw.dispatchFetch({
    path: "https://sjnobxdzlzcqnfjodxri.supabase.co/icons/icon-512.png",
    method: "GET",
  });
  assert.equal(event.responded, false);
});

test("cross-origin: terceros (Binance/FMP/CoinGecko/Google Fonts) nunca son interceptados", () => {
  const sw = loadRealServiceWorker();
  for (const url of [
    "https://fapi.binance.com/fapi/v2/account",
    "https://financialmodelingprep.com/api/v3/quote/AAPL",
    "https://api.coingecko.com/api/v3/simple/price",
    "https://fonts.googleapis.com/css2",
  ]) {
    const event = sw.dispatchFetch({ path: url, method: "GET" });
    assert.equal(event.responded, false, `${url} no debe interceptarse`);
  }
});

test("same-origin: una ruta same-origin equivalente SI puede ser interceptada (control positivo -- confirma que el mock de origen funciona en ambas direcciones)", () => {
  const sw = loadRealServiceWorker();
  const event = sw.dispatchFetch({ path: "/assets/index-ABC123.js", method: "GET" });
  assert.equal(event.responded, true);
});

// ==========================================================
// NAVIGATION FALLBACK
// ==========================================================

test("navigation fallback: GET / con mode navigate recibe app-shell (network-first) real", () => {
  const sw = loadRealServiceWorker();
  const event = sw.dispatchFetch({ path: "/", method: "GET", mode: "navigate" });
  assert.equal(event.responded, true);
});

test("navigation fallback: GET /portfolio (ruta SPA hipotetica) con mode navigate SI recibe app-shell fallback", () => {
  const sw = loadRealServiceWorker();
  const event = sw.dispatchFetch({ path: "/portfolio", method: "GET", mode: "navigate" });
  assert.equal(event.responded, true, "una navegacion real de pestaña a una ruta propia debe poder abrir la app offline");
});

test("navigation fallback: GET /api/lo-que-sea con mode navigate JAMAS recibe app-shell -- sigue siendo network-only", () => {
  const sw = loadRealServiceWorker();
  const event = sw.dispatchFetch({ path: "/api/lo-que-sea", method: "GET", mode: "navigate" });
  assert.equal(event.responded, false, "network-only le gana a navigation fallback: nunca se disfraza un fallo financiero de app-shell exitoso");
});

test("navigation fallback: GET /rest/v1/positions con mode navigate JAMAS recibe app-shell", () => {
  const sw = loadRealServiceWorker();
  const event = sw.dispatchFetch({ path: "/rest/v1/positions", method: "GET", mode: "navigate" });
  assert.equal(event.responded, false);
});

test("navigation fallback: un fetch()/XHR de datos normal (mode !== navigate) a una ruta desconocida NO recibe app-shell -- el fallback es solo para navegacion real de pestaña", () => {
  const sw = loadRealServiceWorker();
  const event = sw.dispatchFetch({ path: "/portfolio", method: "GET", mode: "cors" });
  assert.equal(event.responded, false);
});

test("una respuesta financiera con error HTTP sigue siendo esa respuesta -- el SW nunca la reemplaza porque nunca la intercepta", async () => {
  const sw = loadRealServiceWorker({
    fetchImpl: async () => ({ ok: false, status: 500, clone() { return this; } }),
  });
  const event = sw.dispatchFetch({ path: "/api/futures-equity", method: "GET" });
  // network-only: el SW nunca llama a event.respondWith(), asi que el
  // navegador ejecuta su fetch() normal (el mismo fetchImpl de arriba,
  // que devuelve 500) sin que el SW pueda transformarlo en nada -- no
  // hay una "respuesta" del SW que inspeccionar porque el SW se hizo a
  // un lado por completo, que es exactamente la garantia pedida.
  assert.equal(event.responded, false);
});

// ==========================================================
// 2. PARIDAD/DRIFT: SW real vs. lib/pwaCacheStrategy.js
// ==========================================================
// Mismo archivo fuente (public/pwa-cache-policy.js) para ambos desde
// Sprint P4.2.1 -- drift estructuralmente imposible en la POLITICA, pero
// este test protege el CABLEADO del fetch handler de sw.js (que sw.js
// realmente llame a resolveCacheStrategy() y respete su resultado).

const PARITY_CASES = [
  { path: "/", mode: "same-origin" },
  { path: "/index.html", mode: "same-origin" },
  { path: "/assets/index-XYZ789.css", mode: "same-origin" },
  { path: "/icons/icon-192.png", mode: "same-origin" },
  { path: "/manifest.webmanifest", mode: "same-origin" },
  { path: "/favicon.ico", mode: "same-origin" },
  { path: "/api/market-data", mode: "same-origin" },
  { path: "/api/futures-equity", mode: "same-origin" },
  { path: "/rest/v1/transactions", mode: "same-origin" },
  { path: "/auth/v1/token", mode: "same-origin" },
  { path: "/benchmark.html", mode: "same-origin" }, // existe pero no es parte de ninguna estrategia reconocida
  { path: "/una-ruta-que-no-existe-todavia", mode: "same-origin" },
  { path: "/una-ruta-que-no-existe-todavia", mode: "navigate" },
  { path: "/portfolio", mode: "navigate" },
  { path: "/api/futuro-endpoint-financiero", mode: "navigate" },
];

for (const { path, mode } of PARITY_CASES) {
  test(`paridad: SW real y classifier coinciden para ${path} (mode=${mode})`, () => {
    const expectedStrategy = resolveCacheStrategy(path, { mode });
    const sw = loadRealServiceWorker();
    const event = sw.dispatchFetch({ path, method: "GET", mode });
    const wasIntercepted = event.responded;
    const shouldBeIntercepted = expectedStrategy !== "network-only";
    assert.equal(
      wasIntercepted,
      shouldBeIntercepted,
      `classifier dice "${expectedStrategy}" (intercepted=${shouldBeIntercepted}) pero el SW real hizo intercepted=${wasIntercepted} para ${path} (mode=${mode})`
    );
  });
}

test("paridad: el set de rutas financieras que el SW real rechaza es identico al que el classifier marca network-only, para las 8 rutas nombradas explicitamente", () => {
  for (const path of FINANCIAL_ENDPOINTS) {
    const expectedStrategy = resolveCacheStrategy(path);
    assert.equal(expectedStrategy, "network-only", `classifier: ${path} debe ser network-only`);
    const sw = loadRealServiceWorker();
    const event = sw.dispatchFetch({ path, method: "GET" });
    assert.equal(event.responded, false, `SW real: ${path} no debe interceptarse`);
  }
});

// ==========================================================
// Sanidad del harness (que el mock realmente ejecuta sw.js real)
// ==========================================================

test("sanidad del harness: install/activate no explotan contra el SW real", () => {
  const sw = loadRealServiceWorker();
  assert.doesNotThrow(() => sw.dispatchActivate());
});
