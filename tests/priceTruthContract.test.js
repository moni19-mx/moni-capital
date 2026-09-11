// tests/priceTruthContract.test.js
// Price Truth POST-review (tras el bug real reportado: ETH/LINK/SOL/USDT
// desapareciendo con hiccups de proveedor). Dos cambios de contrato,
// testeados aqui SIN red/Supabase:
//
// 1. Breaker por proveedor: un 429 de CoinGecko NUNCA debe cortar
//    Finnhub, y viceversa -- antes un solo breaker compartido lo hacia.
// 2. MAX_STALE_AGE: separa TTL ("cuando intentar refresh") de
//    MAX_STALE_AGE ("cuando un LKG deja de ser defendible"). Nunca:
//    "provider fail + LKG usable" -> DATA_UNAVAILABLE.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createRateLimitBreaker, isBreakerTripped, MAX_STALE_AGE_MS, STABLECOIN_TICKERS, isWithinMaxStaleAge,
} from "../lib/priceCache.js";
import { resolveTickerPrice, summarizeProviderHealthDetailed } from "../lib/marketDataOrchestrator.js";
import { ProviderRateLimitError } from "../lib/prices.js";

const NOW = new Date("2026-09-09T15:00:00Z");

function cachedRow(overrides = {}) {
  return {
    ticker: "ETH", ai_price: 2494.89, ai_change_pct: -0.02,
    ai_price_updated_at: new Date(NOW.getTime() - 10 * 60000).toISOString(), // 10min de antiguedad
    high: null, low: null, market_cap: null, pe_ratio: null,
    ...overrides,
  };
}

// ================== A. breaker independiente por proveedor ==================
test("A - un 429 de CoinGecko trip-ea SOLO el breaker de coingecko -- Finnhub sigue intentando en vivo normalmente", async () => {
  const breakers = { finnhub: createRateLimitBreaker(), coingecko: createRateLimitBreaker() };

  // Primero: LINK (crypto) recibe 429 de CoinGecko.
  const linkResult = await resolveTickerPrice({
    item: { ticker: "LINK", type: "crypto", priority: "position" },
    cachedRow: null, now: NOW, breaker: breakers.coingecko,
    fetchLive: async () => { throw new ProviderRateLimitError("coingecko"); },
  });
  assert.equal(linkResult.status, "DATA_UNAVAILABLE");
  assert.equal(isBreakerTripped(breakers.coingecko), true, "el breaker de coingecko SI debe activarse");
  assert.equal(isBreakerTripped(breakers.finnhub), false, "REGRESION: el breaker de finnhub NUNCA debe activarse por un 429 de coingecko");

  // Segundo: AAPL (stock) en la MISMA corrida -- debe intentar vivo normal, sin verse afectado.
  let finnhubLiveCalled = false;
  const aaplResult = await resolveTickerPrice({
    item: { ticker: "AAPL", type: "stock", priority: "position" },
    cachedRow: null, now: NOW, breaker: breakers.finnhub,
    fetchLive: async () => { finnhubLiveCalled = true; return { price: 300, changePct: 1, high: null, low: null, marketCap: null, peRatio: null }; },
  });
  assert.equal(finnhubLiveCalled, true, "REGRESION: Finnhub debe seguir intentando en vivo aunque CoinGecko este rate-limited en la misma corrida");
  assert.equal(aaplResult.status, "LIVE");
});

test("A2 - simetrico: un 429 de Finnhub NUNCA activa el breaker de coingecko", async () => {
  const breakers = { finnhub: createRateLimitBreaker(), coingecko: createRateLimitBreaker() };
  await resolveTickerPrice({
    item: { ticker: "QCOM", type: "stock", priority: "position" },
    cachedRow: null, now: NOW, breaker: breakers.finnhub,
    fetchLive: async () => { throw new ProviderRateLimitError("finnhub"); },
  });
  assert.equal(isBreakerTripped(breakers.finnhub), true);
  assert.equal(isBreakerTripped(breakers.coingecko), false);
});

// ================== B. LKG usable dentro de MAX_STALE_AGE ==================
test("B - live falla + LKG de 2h (fuera de TTL pero MUY dentro de MAX_STALE_AGE=24h) -> se USA como STALE, nunca DATA_UNAVAILABLE", async () => {
  const row = cachedRow({ ai_price_updated_at: new Date(NOW.getTime() - 2 * 3600000).toISOString() }); // 2h
  const result = await resolveTickerPrice({
    item: { ticker: "ETH", type: "crypto", priority: "position" },
    cachedRow: row, now: NOW, breaker: createRateLimitBreaker(),
    fetchLive: async () => { throw new Error("provider_timeout"); },
  });
  assert.equal(result.status, "STALE");
  assert.equal(result.price, 2494.89, "REGRESION: el bug real reportado -- un LKG usable NUNCA debe convertirse en DATA_UNAVAILABLE por un fallo de proveedor");
});

// ================== C. LKG que excede MAX_STALE_AGE ==================
test("C - live falla + LKG de 25h (excede MAX_STALE_AGE=24h) -> DATA_UNAVAILABLE explicito, reason=exceeded_max_stale_age", () => {
  assert.equal(MAX_STALE_AGE_MS, 24 * 60 * 60 * 1000, "confirmando la decision del usuario: 24h para TODO, incluido USDT, NO 7 dias");
});

test("C2 - live falla + LKG de 25h -> DATA_UNAVAILABLE, nunca STALE (el LKG dejo de ser defendible)", async () => {
  const row = cachedRow({ ai_price_updated_at: new Date(NOW.getTime() - 25 * 3600000).toISOString() }); // 25h
  const result = await resolveTickerPrice({
    item: { ticker: "ETH", type: "crypto", priority: "position" },
    cachedRow: row, now: NOW, breaker: createRateLimitBreaker(),
    fetchLive: async () => { throw new Error("provider_timeout"); },
  });
  assert.equal(result.status, "DATA_UNAVAILABLE");
  assert.equal(result.reason, "exceeded_max_stale_age", "REGRESION: debe distinguirse explicitamente de 'nunca hubo cache' -- aqui SI hubo, mas de 24h vieja");
  assert.equal(result.price, null, "nunca se usa un precio de 25h como si fuera valido");
});

test("C3 - isWithinMaxStaleAge: frontera exacta -- justo antes de 24h es usable, justo despues no", () => {
  const justBefore = new Date(NOW.getTime() - (24 * 3600000 - 1000)).toISOString();
  const justAfter = new Date(NOW.getTime() - (24 * 3600000 + 1000)).toISOString();
  assert.equal(isWithinMaxStaleAge(justBefore, NOW), true);
  assert.equal(isWithinMaxStaleAge(justAfter, NOW), false);
});

// ================== D. TTL != MAX_STALE_AGE (conceptos distintos, confirmado) ==================
test("D - TTL vencido (90s) con LKG de solo 5min sigue siendo usable -- vencer el TTL NUNCA significa 'ya no sirve', solo 'intenta refrescar'", async () => {
  const row = cachedRow({ ai_price_updated_at: new Date(NOW.getTime() - 5 * 60000).toISOString() }); // 5min: muy por encima del TTL de 90s, muy por debajo de MAX_STALE_AGE de 24h
  const result = await resolveTickerPrice({
    item: { ticker: "ETH", type: "crypto", priority: "position" },
    cachedRow: row, now: NOW, breaker: createRateLimitBreaker(),
    fetchLive: async () => { throw new Error("timeout"); },
  });
  assert.equal(result.status, "STALE");
  assert.equal(result.price, 2494.89);
});

// ================== E. live_attempted / live_error expuestos para trace ==================
test("E - live_attempted=true y live_error poblado cuando realmente se intento y fallo -- para el trace ETH/LINK/SOL/USDT pedido por el usuario", async () => {
  const result = await resolveTickerPrice({
    item: { ticker: "SOL", type: "crypto", priority: "position" },
    cachedRow: null, now: NOW, breaker: createRateLimitBreaker(),
    fetchLive: async () => { throw new Error("no_price: status=500"); },
  });
  assert.equal(result.live_attempted, true);
  assert.equal(result.live_error, "no_price: status=500");
});

test("E2 - live_attempted=false cuando el breaker ya estaba tripped -- nunca se intento de verdad", async () => {
  const breaker = createRateLimitBreaker();
  const row = cachedRow();
  const { tripBreaker } = await import("../lib/priceCache.js");
  tripBreaker(breaker, NOW);
  const result = await resolveTickerPrice({
    item: { ticker: "ETH", type: "crypto", priority: "position" },
    cachedRow: row, now: NOW, breaker,
    fetchLive: async () => { throw new Error("nunca deberia llamarse"); },
  });
  assert.equal(result.live_attempted, false);
});

// ================== F. summarizeProviderHealthDetailed ==================
test("F - summarizeProviderHealthDetailed: coingecko RATE_LIMITED no cambia finnhub_status", async () => {
  const { tripBreaker } = await import("../lib/priceCache.js");
  const breakers = { finnhub: createRateLimitBreaker(), coingecko: createRateLimitBreaker() };
  tripBreaker(breakers.coingecko, NOW);
  const results = [
    { status: "LIVE", provider: "finnhub" },
    { status: "LIVE", provider: "finnhub" },
    { status: "STALE_RATE_LIMITED", provider: "coingecko" },
  ];
  const detailed = summarizeProviderHealthDetailed(results, breakers);
  assert.equal(detailed.finnhub_status, "OK", "REGRESION: finnhub_status no debe verse afectado por el breaker de coingecko");
  assert.equal(detailed.coingecko_status, "RATE_LIMITED");
  assert.equal(detailed.aggregate, "RATE_LIMITED", "el agregado SI debe reflejar que al menos un proveedor esta degradado");
});

// ================== G. whitelist de stablecoins declarada, sin efecto en MAX_STALE_AGE todavia ==================
test("G - STABLECOIN_TICKERS incluye USDT explicitamente, pero MAX_STALE_AGE_MS es el MISMO para todos los activos (decision revisada del usuario: no 7 dias todavia)", () => {
  assert.deepEqual(STABLECOIN_TICKERS, ["USDT"]);
  // USDT no recibe ningun trato especial de staleness hoy -- mismo limite de 24h:
  const rowUsdt = { ai_price: 1.0, ai_price_updated_at: new Date(NOW.getTime() - 25 * 3600000).toISOString() };
  assert.equal(isWithinMaxStaleAge(rowUsdt.ai_price_updated_at, NOW), false, "25h excede el limite de 24h igual que cualquier otro activo");
});
