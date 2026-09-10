// tests/priceTruthProbeState.test.js
// Price Truth Stability Probe -- tests de la logica PURA de
// clasificacion/assertions (lib/priceTruthProbeState.js). Cero red,
// cero timers reales.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifyMarketDataIteration, classifyFuturesIteration,
  detectLkgRegression, detectCrossProviderContamination, detectFuturesValuationRegression,
} from "../lib/priceTruthProbeState.js";

// ================== classifyMarketDataIteration ==================

test("A - ticker en `data` con price_status -> se clasifica tal cual", () => {
  const json = { data: { ETH: { price: 2500, price_status: "LIVE", price_source: "coingecko", price_fetched_at: "t1" } }, errors: [] };
  const result = classifyMarketDataIteration(json, ["ETH"]);
  assert.deepEqual(result.ETH, { status: "LIVE", price: 2500, source: "coingecko", fetched_at: "t1" });
});

test("B - ticker en `errors` -> DATA_UNAVAILABLE, nunca inventa una razon que el endpoint no expone", () => {
  const json = { data: {}, errors: ["QCOM"] };
  const result = classifyMarketDataIteration(json, ["QCOM"]);
  assert.equal(result.QCOM.status, "DATA_UNAVAILABLE");
  assert.equal(result.QCOM.price, null);
});

test("C - ticker ni en data ni en errors -> MISSING_FROM_RESPONSE explicito, nunca asumido como DATA_UNAVAILABLE silenciosamente", () => {
  const json = { data: {}, errors: [] };
  const result = classifyMarketDataIteration(json, ["NVDA"]);
  assert.equal(result.NVDA.status, "MISSING_FROM_RESPONSE");
});

// ================== classifyFuturesIteration ==================

test("D - USD_M/COIN_M se detectan por product_type real (guion bajo, no guion)", () => {
  const json = {
    total_value_usd: 5000, is_complete: true, warnings: [],
    accounts: [
      { account_id: 3, product_type: "USD_M", valuation_status: "OK", balances: [{ ticker: "USDT", equity_value: 100, value_usd: 100, status: "OK", price_status: "LIVE", price_source: "coingecko_cache", price_fetched_at: "t1" }] },
      { account_id: 4, product_type: "COIN_M", valuation_status: "PARTIAL", balances: [{ ticker: "BTC", equity_value: 0.01, value_usd: null, status: "PRICE_UNAVAILABLE", price_status: "DATA_UNAVAILABLE", price_source: null, price_fetched_at: null }] },
    ],
  };
  const result = classifyFuturesIteration(json);
  assert.equal(result.usdm.included, true);
  assert.equal(result.usdm.value_usd, 100);
  assert.equal(result.coinm.included, false);
  assert.equal(result.coinm.valuation_status, "PRICE_UNAVAILABLE");
});

test("E - sin cuentas futures -> usdm/coinm quedan null, nunca 0 inventado", () => {
  const result = classifyFuturesIteration({ total_value_usd: 0, is_complete: true, warnings: [], accounts: [] });
  assert.equal(result.usdm, null);
  assert.equal(result.coinm, null);
});

// ================== detectLkgRegression ==================

test("F - primera vez usable -> no hay regresion, se guarda como newBest", () => {
  const { regression, newBest } = detectLkgRegression({ ticker: "ETH", provider: "coingecko", previousBest: null, current: { status: "LIVE", price: 2500 }, iterationIndex: 1 });
  assert.equal(regression, null);
  assert.equal(newBest.status, "LIVE");
  assert.equal(newBest.iteration, 1);
});

test("G - LIVE en iter 1, DATA_UNAVAILABLE en iter 2 -> REGRESSION_LKG_DISAPPEARED, sin excepcion (ventana <15min, MAX_STALE_AGE=24h)", () => {
  const previousBest = { status: "LIVE", price: 2500, iteration: 1 };
  const { regression, newBest } = detectLkgRegression({ ticker: "ETH", provider: "coingecko", previousBest, current: { status: "DATA_UNAVAILABLE", price: null }, iterationIndex: 2, providerHealth: { finnhub_status: "OK", coingecko_status: "OK" } });
  assert.ok(regression);
  assert.equal(regression.ticker, "ETH");
  assert.equal(regression.previous_status, "LIVE");
  assert.equal(regression.current_iteration, 2);
  assert.deepEqual(newBest, previousBest, "el baseline se conserva para seguir detectando regresiones futuras");
});

test("H - CACHED -> STALE -> nunca es regresion (STALE sigue siendo usable)", () => {
  const previousBest = { status: "CACHED", price: 100, iteration: 1 };
  const { regression, newBest } = detectLkgRegression({ ticker: "AMZN", provider: "finnhub", previousBest, current: { status: "STALE", price: 100 }, iterationIndex: 2 });
  assert.equal(regression, null);
  assert.equal(newBest.status, "STALE");
});

test("I - DATA_UNAVAILABLE nunca visto antes -> no hay regresion (nunca hubo LKG usable que perder)", () => {
  const { regression } = detectLkgRegression({ ticker: "XYZ", provider: "finnhub", previousBest: null, current: { status: "DATA_UNAVAILABLE", price: null }, iterationIndex: 1 });
  assert.equal(regression, null);
});

test("J - regresion ya detectada en iter 2, si vuelve DATA_UNAVAILABLE en iter 4 (tras recuperarse en iter 3) se detecta de nuevo", () => {
  const bestAfterRegression = { status: "LIVE", price: 2500, iteration: 1 }; // se conserva tras G
  const recovered = detectLkgRegression({ ticker: "ETH", provider: "coingecko", previousBest: bestAfterRegression, current: { status: "CACHED", price: 2500 }, iterationIndex: 3 });
  assert.equal(recovered.regression, null);
  assert.equal(recovered.newBest.status, "CACHED");
  const regressedAgain = detectLkgRegression({ ticker: "ETH", provider: "coingecko", previousBest: recovered.newBest, current: { status: "DATA_UNAVAILABLE", price: null }, iterationIndex: 4 });
  assert.ok(regressedAgain.regression);
  assert.equal(regressedAgain.regression.current_iteration, 4);
});

// ================== detectCrossProviderContamination ==================

test("K - CoinGecko rate-limited + Finnhub tickers faltantes por otra razon -> NUNCA se infiere contaminacion solo por eso (esta funcion ni siquiera mira conteo de tickers)", () => {
  // La funcion NUNCA recibe conteos de tickers -- solo status agregados,
  // por diseno, para que sea estructuralmente imposible inferir por
  // coincidencia de tickers simultaneos.
  const result = detectCrossProviderContamination({
    providerAName: "coingecko", providerBName: "finnhub",
    prevStatuses: { coingecko: "OK", finnhub: "OK" },
    currStatuses: { coingecko: "RATE_LIMITED", finnhub: "OK" }, // finnhub sigue OK -- sin violacion
  });
  assert.equal(result.violation, false);
});

test("L - CoinGecko pasa a RATE_LIMITED Y Finnhub, que estaba sano, se degrada en la MISMA iteracion -> violacion marcada (correlacional)", () => {
  const result = detectCrossProviderContamination({
    providerAName: "coingecko", providerBName: "finnhub",
    prevStatuses: { coingecko: "OK", finnhub: "OK" },
    currStatuses: { coingecko: "RATE_LIMITED", finnhub: "RATE_LIMITED" },
  });
  assert.equal(result.violation, true);
  assert.equal(result.provider_a, "coingecko");
  assert.equal(result.provider_b, "finnhub");
  assert.ok(result.note.includes("Correlacional"));
});

test("M - Finnhub ya venia degradado ANTES de que CoinGecko cayera -> no es nueva evidencia de contaminacion, no se marca", () => {
  const result = detectCrossProviderContamination({
    providerAName: "coingecko", providerBName: "finnhub",
    prevStatuses: { coingecko: "OK", finnhub: "AUTH_ERROR" }, // finnhub YA estaba mal antes
    currStatuses: { coingecko: "RATE_LIMITED", finnhub: "AUTH_ERROR" },
  });
  assert.equal(result.violation, false);
});

test("N - CoinGecko ya estaba RATE_LIMITED en la iteracion previa -> no es un evento NUEVO, no dispara la deteccion de nuevo", () => {
  const result = detectCrossProviderContamination({
    providerAName: "coingecko", providerBName: "finnhub",
    prevStatuses: { coingecko: "RATE_LIMITED", finnhub: "OK" },
    currStatuses: { coingecko: "RATE_LIMITED", finnhub: "RATE_LIMITED" }, // finnhub se degrada, pero A no es "newly" rate limited
  });
  assert.equal(result.violation, false);
});

// ================== detectFuturesValuationRegression ==================

test("O - USD-M incluido en iter 1, excluido en iter 2 -> regresion detectada", () => {
  const previousIncluded = { included: true, value_usd: 4300, iteration: 1 };
  const current = { included: false, valuation_status: "PRICE_UNAVAILABLE", price_status: "DATA_UNAVAILABLE" };
  const { regression } = detectFuturesValuationRegression({ bucket: "USD-M", previousIncluded, currentIncluded: current, iterationIndex: 2, current });
  assert.ok(regression);
  assert.equal(regression.bucket, "USD-M");
  assert.equal(regression.previous_value_usd, 4300);
});

test("P - nunca incluido -> nunca hay regresion (no hay baseline usable que perder)", () => {
  const { regression } = detectFuturesValuationRegression({ bucket: "COIN-M", previousIncluded: null, currentIncluded: { included: false }, iterationIndex: 1, current: { included: false } });
  assert.equal(regression, null);
});
