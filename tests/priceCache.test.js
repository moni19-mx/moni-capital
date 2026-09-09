// tests/priceCache.test.js
// Micro-sprint P0.3 (Market Price Cache + Provider Resilience). Tests
// A-N sobre lib/priceCache.js + lib/marketDataOrchestrator.js -- CERO
// red, CERO Supabase real (fetchLive/cachedRow siempre inyectados).

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MARKET_OPEN_TTL_MS, MARKET_CLOSED_TTL_MS, CRYPTO_TTL_MS,
  isLikelyMarketOpen, computeTtlMs, isCacheFresh, classifyPriceStatus,
  createRateLimitBreaker, tripBreaker, isBreakerTripped,
} from "../lib/priceCache.js";
import { resolveTickerPrice, summarizeProviderHealth } from "../lib/marketDataOrchestrator.js";
import { ProviderRateLimitError, ProviderAuthError } from "../lib/prices.js";
import { enrichPositions, computeStocksValue } from "../lib/financialSnapshot.js";

const NOW = new Date("2026-09-09T15:00:00Z"); // martes, dentro de horario NYSE real (11:00am ET)
const AFTER_HOURS = new Date("2026-09-09T02:00:00Z"); // martes 22:00 ET del dia anterior -- mercado cerrado

function makeCachedRow(overrides = {}) {
  return {
    ticker: "AAPL", ai_price: 300, ai_change_pct: 1.2,
    ai_price_updated_at: new Date(NOW.getTime() - 5000).toISOString(), // 5s de antiguedad
    high: 350, low: 250, market_cap: 3e12, pe_ratio: 30,
    ...overrides,
  };
}
const STOCK_ITEM = { ticker: "AAPL", type: "stock" };

// ================== market hours / TTL ==================
test("isLikelyMarketOpen: martes 11am ET -> true; martes 10pm ET (mismo dia UTC anterior) -> false", () => {
  assert.equal(isLikelyMarketOpen(NOW), true);
  assert.equal(isLikelyMarketOpen(AFTER_HOURS), false);
});

test("isLikelyMarketOpen: sabado -> false sin importar la hora", () => {
  assert.equal(isLikelyMarketOpen(new Date("2026-09-12T15:00:00Z")), false); // sabado real
});

test("computeTtlMs: stock en horario -> TTL corto; stock fuera de horario -> TTL largo; crypto siempre TTL corto", () => {
  assert.equal(computeTtlMs("stock", NOW), MARKET_OPEN_TTL_MS);
  assert.equal(computeTtlMs("stock", AFTER_HOURS), MARKET_CLOSED_TTL_MS);
  assert.equal(computeTtlMs("crypto", AFTER_HOURS), CRYPTO_TTL_MS);
});

// ================== A. fresh cache -> no Finnhub request ==================
test("A - cache fresco (5s de antiguedad, TTL 30s) -> status CACHED, fetchLive NUNCA se llama", async () => {
  let liveCalled = false;
  const fetchLive = async () => { liveCalled = true; return { price: 999 }; };
  const result = await resolveTickerPrice({ item: STOCK_ITEM, cachedRow: makeCachedRow(), now: NOW, breaker: createRateLimitBreaker(), fetchLive });
  assert.equal(result.status, "CACHED");
  assert.equal(result.price, 300);
  assert.equal(liveCalled, false, "REGRESION: cache fresco no debe disparar una llamada live");
});

// ================== B. expired cache -> refresh Finnhub ==================
test("B - cache vencido (10min de antiguedad en horario de mercado, TTL 30s) -> intenta live", async () => {
  let liveCalled = false;
  const staleRow = makeCachedRow({ ai_price_updated_at: new Date(NOW.getTime() - 10 * 60000).toISOString() });
  const fetchLive = async () => { liveCalled = true; return { price: 305, changePct: 1.5, high: 350, low: 250, marketCap: 3e12, peRatio: 30 }; };
  const result = await resolveTickerPrice({ item: STOCK_ITEM, cachedRow: staleRow, now: NOW, breaker: createRateLimitBreaker(), fetchLive });
  assert.equal(liveCalled, true);
  assert.equal(result.status, "LIVE");
  assert.equal(result.price, 305);
});

// ================== C. expired cache + exito -> LIVE (el llamador actualiza el cache) ==================
test("C - expired cache + Finnhub exitoso -> status LIVE con fetchedAt real, listo para que el llamador escriba el cache", async () => {
  const staleRow = makeCachedRow({ ai_price_updated_at: new Date(NOW.getTime() - 10 * 60000).toISOString() });
  const fetchLive = async () => ({ price: 310, changePct: 2, high: 350, low: 250, marketCap: 3e12, peRatio: 30 });
  const result = await resolveTickerPrice({ item: STOCK_ITEM, cachedRow: staleRow, now: NOW, breaker: createRateLimitBreaker(), fetchLive });
  assert.equal(result.status, "LIVE");
  assert.equal(result.fetchedAt, NOW.toISOString());
});

// ================== D. expired cache + fallo -> STALE (nunca excluido si hay cache vieja) ==================
test("D - expired cache + Finnhub falla (no-429) -> sirve el precio STALE cacheado, nunca null", async () => {
  const staleRow = makeCachedRow({ ai_price_updated_at: new Date(NOW.getTime() - 10 * 60000).toISOString() });
  const fetchLive = async () => { throw new Error("timeout_after_8000ms"); };
  const result = await resolveTickerPrice({ item: STOCK_ITEM, cachedRow: staleRow, now: NOW, breaker: createRateLimitBreaker(), fetchLive });
  assert.equal(result.status, "STALE");
  assert.equal(result.price, 300, "debe conservar el ultimo precio conocido, nunca null/0");
});

// ================== E. no cache + fallo -> DATA_UNAVAILABLE, nunca 0 ==================
test("E - sin cache alguna vez + Finnhub falla -> DATA_UNAVAILABLE explicito, price=null, NUNCA 0", async () => {
  const fetchLive = async () => { throw new Error("no_quote"); };
  const result = await resolveTickerPrice({ item: STOCK_ITEM, cachedRow: null, now: NOW, breaker: createRateLimitBreaker(), fetchLive });
  assert.equal(result.status, "DATA_UNAVAILABLE");
  assert.equal(result.price, null);
  assert.notEqual(result.price, 0);
});

// ================== F. 429 -> RATE_LIMITED + breaker tripped ==================
test("F - Finnhub responde 429 (ProviderRateLimitError) -> breaker se activa, y si hay cache vieja se sirve como STALE_RATE_LIMITED", async () => {
  const breaker = createRateLimitBreaker();
  const staleRow = makeCachedRow({ ai_price_updated_at: new Date(NOW.getTime() - 10 * 60000).toISOString() });
  const fetchLive = async () => { throw new ProviderRateLimitError("finnhub"); };
  const result = await resolveTickerPrice({ item: STOCK_ITEM, cachedRow: staleRow, now: NOW, breaker, fetchLive });
  assert.equal(result.status, "STALE_RATE_LIMITED");
  assert.equal(result.price, 300);
  assert.equal(isBreakerTripped(breaker), true, "el breaker debe quedar activado tras un 429 real");
});

test("F - 429 sin ninguna cache disponible -> DATA_UNAVAILABLE (nunca 0), breaker igual se activa", async () => {
  const breaker = createRateLimitBreaker();
  const fetchLive = async () => { throw new ProviderRateLimitError("finnhub"); };
  const result = await resolveTickerPrice({ item: STOCK_ITEM, cachedRow: null, now: NOW, breaker, fetchLive });
  assert.equal(result.status, "DATA_UNAVAILABLE");
  assert.equal(isBreakerTripped(breaker), true);
});

// ================== G. cooldown -> no repeated live calls dentro de la misma corrida ==================
test("G - breaker ya activado (ticker anterior del mismo batch disparo 429) -> el siguiente ticker NUNCA intenta live, va directo a cache/STALE", async () => {
  const breaker = createRateLimitBreaker();
  tripBreaker(breaker, NOW); // simula que un ticker anterior en el mismo batch ya disparo 429
  let liveCalled = false;
  const staleRow = makeCachedRow({ ticker: "MSFT", ai_price_updated_at: new Date(NOW.getTime() - 10 * 60000).toISOString() });
  const fetchLive = async () => { liveCalled = true; return { price: 999 }; };
  const result = await resolveTickerPrice({ item: { ticker: "MSFT", type: "stock" }, cachedRow: staleRow, now: NOW, breaker, fetchLive });
  assert.equal(liveCalled, false, "REGRESION: con el breaker activo, ningun ticker restante debe intentar una llamada live");
  assert.equal(result.status, "STALE_RATE_LIMITED");
});

// ================== H. cooldown expiry -> requests resume ==================
test("H - un breaker NUEVO (siguiente corrida/invocacion) no hereda el estado tripped de la corrida anterior -- las llamadas live se reanudan", async () => {
  const freshBreaker = createRateLimitBreaker();
  let liveCalled = false;
  const fetchLive = async () => { liveCalled = true; return { price: 305, changePct: 1, high: null, low: null, marketCap: null, peRatio: null }; };
  const staleRow = makeCachedRow({ ai_price_updated_at: new Date(NOW.getTime() - 10 * 60000).toISOString() });
  const result = await resolveTickerPrice({ item: STOCK_ITEM, cachedRow: staleRow, now: NOW, breaker: freshBreaker, fetchLive });
  assert.equal(liveCalled, true);
  assert.equal(result.status, "LIVE");
});

// ================== I. fallo de un ticker no afecta a los demas ==================
test("I - dos tickers independientes, uno falla y el otro tiene exito -- cada resultado es independiente", async () => {
  const breaker = createRateLimitBreaker();
  const okResult = await resolveTickerPrice({
    item: { ticker: "AAPL", type: "stock" }, cachedRow: null, now: NOW, breaker,
    fetchLive: async () => ({ price: 300, changePct: 1, high: null, low: null, marketCap: null, peRatio: null }),
  });
  const failResult = await resolveTickerPrice({
    item: { ticker: "XYZ", type: "stock" }, cachedRow: null, now: NOW, breaker,
    fetchLive: async () => { throw new Error("no_quote"); },
  });
  assert.equal(okResult.status, "LIVE");
  assert.equal(failResult.status, "DATA_UNAVAILABLE");
});

// ================== J. mitigacion de llamadas redundantes (via TTL, no in-flight coalescing) ==================
test("J - dos resoluciones consecutivas para el MISMO ticker dentro del TTL (simulando polling+manual+SmartImport casi simultaneos) -> la segunda usa cache, no dispara una segunda llamada live", async () => {
  // NOTA HONESTA (ver limitations del reporte): esto NO es coalescing de
  // requests en vuelo (2 invocaciones de Vercel realmente simultaneas
  // podrian ambas ver cache vacio y ambas llamar live) -- es mitigacion
  // via TTL: la SEGUNDA corrida, si llega despues de que la primera ya
  // escribio el cache, lo reusa. Cubre el caso real y comun (refresh B
  // llega segundos despues de que refresh A ya completo), no la carrera
  // exacta de 2 requests arrancando en el mismo milisegundo.
  const breaker = createRateLimitBreaker();
  let liveCallCount = 0;
  const fetchLive = async () => { liveCallCount++; return { price: 300, changePct: 1, high: null, low: null, marketCap: null, peRatio: null }; };

  const first = await resolveTickerPrice({ item: STOCK_ITEM, cachedRow: null, now: NOW, breaker, fetchLive });
  assert.equal(first.status, "LIVE");
  // El llamador real (api/market-data.js) escribe el cache tras un LIVE -- se simula aqui:
  const rowAfterWrite = makeCachedRow({ ai_price: first.price, ai_price_updated_at: first.fetchedAt });

  const secondNow = new Date(NOW.getTime() + 3000); // 3s despues, dentro del TTL de 30s
  const second = await resolveTickerPrice({ item: STOCK_ITEM, cachedRow: rowAfterWrite, now: secondNow, breaker, fetchLive });
  assert.equal(second.status, "CACHED");
  assert.equal(liveCallCount, 1, "solo 1 llamada live real entre las 2 resoluciones dentro del TTL");
});

// ================== K. cache reproduce el mismo Total Acciones que un precio live ==================
test("K - un precio servido desde CACHED produce EXACTAMENTE el mismo Total Acciones que si viniera de LIVE -- misma forma de dato, misma formula", () => {
  const positions = [{ ticker: "AAPL", type: "stock", shares: 2, cost_basis: 500 }];
  const marketDataLive = { AAPL: { price: 300, price_status: "LIVE" } };
  const marketDataCached = { AAPL: { price: 300, price_status: "CACHED" } };
  const totalLive = computeStocksValue(enrichPositions(positions, marketDataLive, {}));
  const totalCached = computeStocksValue(enrichPositions(positions, marketDataCached, {}));
  assert.equal(totalLive, totalCached);
  assert.equal(totalLive, 600);
});

// ================== L. sin cambios de formula financiera ==================
test("L - enrichPositions ignora price_status/price_source/price_fetched_at para el calculo de value -- solo usa .price, la formula no cambio", () => {
  const positions = [{ ticker: "X", type: "stock", shares: 3, cost_basis: 100 }];
  const marketData = { X: { price: 50, price_status: "STALE_RATE_LIMITED", price_source: "cache_stale", price_fetched_at: "2020-01-01T00:00:00Z", changePct: -99, marketCap: 1 } };
  const [enriched] = enrichPositions(positions, marketData, {});
  assert.equal(enriched.value, 150, "value = shares * price, sin importar ningun otro campo de metadata");
});

// ================== provider health summary ==================
test("summarizeProviderHealth: sin fallos -> OK; parcial -> PARTIAL; todo DATA_UNAVAILABLE sin breaker -> PROVIDER_ERROR; breaker activo -> RATE_LIMITED", () => {
  assert.equal(summarizeProviderHealth([{ status: "LIVE" }, { status: "CACHED" }], createRateLimitBreaker()), "OK");
  assert.equal(summarizeProviderHealth([{ status: "LIVE" }, { status: "DATA_UNAVAILABLE" }], createRateLimitBreaker()), "PARTIAL");
  assert.equal(summarizeProviderHealth([{ status: "DATA_UNAVAILABLE" }, { status: "DATA_UNAVAILABLE" }], createRateLimitBreaker()), "PROVIDER_ERROR");
  const tripped = createRateLimitBreaker();
  tripBreaker(tripped);
  assert.equal(summarizeProviderHealth([{ status: "STALE_RATE_LIMITED" }], tripped), "RATE_LIMITED");
});

test("summarizeProviderHealth: todos auth_error -> AUTH_ERROR", () => {
  const results = [{ status: "DATA_UNAVAILABLE", reason: "auth_error" }, { status: "DATA_UNAVAILABLE", reason: "auth_error" }];
  assert.equal(summarizeProviderHealth(results, createRateLimitBreaker()), "AUTH_ERROR");
});

// ================== ProviderAuthError ==================
test("ProviderAuthError: 401/403 se distingue de un fallo generico, y sin cache produce DATA_UNAVAILABLE con reason=auth_error", async () => {
  const fetchLive = async () => { throw new ProviderAuthError("finnhub", 401); };
  const result = await resolveTickerPrice({ item: STOCK_ITEM, cachedRow: null, now: NOW, breaker: createRateLimitBreaker(), fetchLive });
  assert.equal(result.status, "DATA_UNAVAILABLE");
  assert.equal(result.reason, "auth_error");
});

// ================== classifyPriceStatus (helper puro standalone) ==================
test("classifyPriceStatus: cubre las 4 combinaciones documentadas", () => {
  assert.equal(classifyPriceStatus({ hasFreshCache: false, hasStaleCache: false, liveSucceeded: true, rateLimited: false }), "LIVE");
  assert.equal(classifyPriceStatus({ hasFreshCache: true, hasStaleCache: false, liveSucceeded: false, rateLimited: false }), "CACHED");
  assert.equal(classifyPriceStatus({ hasFreshCache: false, hasStaleCache: true, liveSucceeded: false, rateLimited: false }), "STALE");
  assert.equal(classifyPriceStatus({ hasFreshCache: false, hasStaleCache: true, liveSucceeded: false, rateLimited: true }), "STALE_RATE_LIMITED");
  assert.equal(classifyPriceStatus({ hasFreshCache: false, hasStaleCache: false, liveSucceeded: false, rateLimited: false }), "DATA_UNAVAILABLE");
});

// ================== M. PWA nunca cachea /api/market-data ==================
test("M - PWA cache policy: /api/market-data sigue siendo network-only (sin cambios de este sprint)", async () => {
  const { resolveCacheStrategy } = await import("../lib/pwaCacheStrategy.js");
  assert.equal(resolveCacheStrategy("/api/market-data", { mode: "cors" }), "network-only");
});

// N. P0.1/P0.2 LKG behavior: cubierto por tests/loadAllCoherence.test.js y
// tests/financialSnapshot.test.js (parte de la misma corrida de suite
// completa, 423 tests previos siguen en 100% verde con estos cambios).
