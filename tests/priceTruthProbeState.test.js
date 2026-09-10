// tests/priceTruthProbeState.test.js
// Price Truth Stability Probe -- tests de la logica PURA de
// clasificacion/assertions (lib/priceTruthProbeState.js). Cero red,
// cero timers reales.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifyMarketDataIteration, classifyFuturesIteration,
  detectLkgRegression, detectCrossProviderContamination, detectFuturesValuationRegression,
  sanitizeHeadersForLog, truncateBody, classifyResponseFingerprint, buildDiagnosticVerdict,
  classifyJsonResponseShape, validateFuturesContract, validateMarketDataContract, classifyEndpointDiagnosticResult,
  resolveCertificationUniverse, TRACKED_SUBSET_TICKERS,
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

// ================== sanitizeHeadersForLog / truncateBody (modo diagnostico) ==================

test("Q - sanitizeHeadersForLog solo captura la whitelist -- un header desconocido nunca se loguea", () => {
  const headers = new Map([
    ["content-type", "text/html"], ["x-vercel-id", "abc123"],
    ["authorization", "Bearer secret-should-never-appear"], ["x-custom-unknown", "whatever"],
  ]);
  const result = sanitizeHeadersForLog(headers);
  assert.equal(result["content-type"], "text/html");
  assert.equal(result["x-vercel-id"], "abc123");
  assert.equal(result.authorization, undefined, "REGRESION: un secreto/header no-whitelisted jamas debe aparecer en el log");
  assert.equal(result["x-custom-unknown"], undefined);
});

test("R - sanitizeHeadersForLog: set-cookie nunca expone su valor, solo presencia", () => {
  const headers = new Map([["set-cookie", "session=abc123; secret-value-here"]]);
  const result = sanitizeHeadersForLog(headers);
  assert.equal(result["set-cookie"], "PRESENT_REDACTED");
  assert.ok(!JSON.stringify(result).includes("abc123"));
});

test("S - sanitizeHeadersForLog acepta objeto plano ademas de Headers/Map", () => {
  const result = sanitizeHeadersForLog({ "Content-Type": "application/json" });
  assert.equal(result["content-type"], "application/json");
});

test("T - truncateBody trunca cuerpos largos con limite explicito, nunca los oculta por completo", () => {
  const long = "x".repeat(1000);
  const truncated = truncateBody(long, 500);
  assert.equal(truncated.length, 500 + "...[truncated, 1000 bytes total]".length);
  assert.ok(truncated.startsWith("x".repeat(500)));
});

test("U - truncateBody con texto corto no lo toca", () => {
  assert.equal(truncateBody("short body", 500), "short body");
});

test("V - truncateBody con null/undefined -> null, nunca explota", () => {
  assert.equal(truncateBody(null), null);
  assert.equal(truncateBody(undefined), null);
});

// ================== classifyResponseFingerprint ==================

test("W - 200 real -> OK", () => {
  assert.equal(classifyResponseFingerprint({ status: 200, contentType: "application/json", bodySnippet: "{}", headers: {} }), "OK");
});

test("X - 401 JSON con nuestro shape exacto {error:unauthorized} -> APP_LEVEL_REJECTION_UNEXPECTED (documentado como imposible hoy, nunca oculto)", () => {
  const result = classifyResponseFingerprint({ status: 401, contentType: "application/json", bodySnippet: '{"error":"unauthorized"}', headers: {} });
  assert.equal(result, "APP_LEVEL_REJECTION_UNEXPECTED");
});

test("Y - 401 con body mencionando vercel + authenticate -> VERCEL_DEPLOYMENT_PROTECTION_LIKELY", () => {
  const result = classifyResponseFingerprint({ status: 401, contentType: "text/html", bodySnippet: "<html>Vercel Authentication required, please authenticate</html>", headers: {} });
  assert.equal(result, "VERCEL_DEPLOYMENT_PROTECTION_LIKELY");
});

test("Z - 401 con header x-vercel-error -> VERCEL_FIREWALL_LIKELY", () => {
  const result = classifyResponseFingerprint({ status: 401, contentType: "text/plain", bodySnippet: "denied", headers: { "x-vercel-error": "FIREWALL_DENIED" } });
  assert.equal(result, "VERCEL_FIREWALL_LIKELY");
});

test("AA - 401 sin ninguna senal fuerte -> UNKNOWN_NON_2XX_SOURCE, NUNCA adivina WAF sin evidencia", () => {
  const result = classifyResponseFingerprint({ status: 401, contentType: "text/plain", bodySnippet: "Unauthorized", headers: {} });
  assert.equal(result, "UNKNOWN_NON_2XX_SOURCE");
});

// ================== classifyJsonResponseShape (revision: 200 no basta) ==================

test("BB - status no-2xx -> HTTP_NON_2XX sin importar el body", () => {
  assert.equal(classifyJsonResponseShape({ status: 401, contentType: "application/json", rawText: '{"ok":true}' }), "HTTP_NON_2XX");
});

test("CC - status 200 con HTML (pagina de auto-redirect de Vercel Auth) -> HTTP_200_HTML, NUNCA se confunde con exito", () => {
  const result = classifyJsonResponseShape({ status: 200, contentType: "text/html", rawText: "<html><body>Redirecting to SSO...</body></html>" });
  assert.equal(result, "HTTP_200_HTML");
});

test("DD - status 200 con texto no-JSON y sin content-type html -> HTTP_200_INVALID_JSON", () => {
  const result = classifyJsonResponseShape({ status: 200, contentType: "text/plain", rawText: "not json at all" });
  assert.equal(result, "HTTP_200_INVALID_JSON");
});

test("EE - status 200 con JSON real -> HTTP_200_VALID_JSON", () => {
  const result = classifyJsonResponseShape({ status: 200, contentType: "application/json", rawText: '{"data":{},"errors":[]}' });
  assert.equal(result, "HTTP_200_VALID_JSON");
});

// ================== validateFuturesContract (contrato real del codigo, nunca inventado) ==================

test("FF - shape exacto real de futures-equity.js -> valido", () => {
  const result = validateFuturesContract({ total_value_usd: 4300.5, is_complete: true, accounts: [], positions: [], warnings: [] });
  assert.equal(result.valid, true);
});

test("GG - total_value_usd=null (imposible en una ejecucion real del handler) -> invalido, razon explicita", () => {
  const result = validateFuturesContract({ total_value_usd: null, is_complete: null, accounts: [], positions: [], warnings: [] });
  assert.equal(result.valid, false);
  assert.equal(result.reason, "total_value_usd_not_number");
});

test("HH - falta una key del contrato real -> invalido, lista la key faltante", () => {
  const result = validateFuturesContract({ total_value_usd: 0, is_complete: true, accounts: [], positions: [] });
  assert.equal(result.valid, false);
  assert.deepEqual(result.missingKeys, ["warnings"]);
});

test("II - null/no-objeto -> invalido, nunca explota", () => {
  assert.equal(validateFuturesContract(null).valid, false);
  assert.equal(validateFuturesContract("string").valid, false);
});

// ================== validateMarketDataContract ==================

test("JJ - shape exacto real de market-data.js -> valido", () => {
  const result = validateMarketDataContract({ data: { ETH: {} }, errors: [] });
  assert.equal(result.valid, true);
});

test("KK - errors no es array -> invalido", () => {
  const result = validateMarketDataContract({ data: {}, errors: "none" });
  assert.equal(result.valid, false);
  assert.equal(result.reason, "errors_not_array");
});

// ================== classifyEndpointDiagnosticResult (integracion) ==================

test("LL - 200 + JSON valido + contrato real cumplido -> VALID_ENDPOINT_RESPONSE", () => {
  const result = classifyEndpointDiagnosticResult({
    status: 200, contentType: "application/json", rawText: JSON.stringify({ total_value_usd: 100, is_complete: true, accounts: [], positions: [], warnings: [] }),
    validateContract: validateFuturesContract,
  });
  assert.equal(result.result, "VALID_ENDPOINT_RESPONSE");
  assert.ok(result.topLevelKeys.includes("total_value_usd"));
});

test("MM - 200 pero HTML (el caso real encontrado: Vercel Auth con auto_vercel_auth_redirect) -> PLATFORM_INTERCEPT_OR_INVALID_RESPONSE, NUNCA cuenta como exito de Price Truth", () => {
  const result = classifyEndpointDiagnosticResult({
    status: 200, contentType: "text/html", rawText: "<html>redirecting...</html>",
    validateContract: validateFuturesContract,
  });
  assert.equal(result.result, "PLATFORM_INTERCEPT_OR_INVALID_RESPONSE");
  assert.equal(result.shape, "HTTP_200_HTML");
});

test("NN - 200 + JSON valido pero con shape distinto al contrato real (ej. total_value_usd null) -> PLATFORM_INTERCEPT_OR_INVALID_RESPONSE", () => {
  const result = classifyEndpointDiagnosticResult({
    status: 200, contentType: "application/json", rawText: JSON.stringify({ total_value_usd: null, is_complete: null, accounts: [], positions: [], warnings: [] }),
    validateContract: validateFuturesContract,
  });
  assert.equal(result.result, "PLATFORM_INTERCEPT_OR_INVALID_RESPONSE");
  assert.equal(result.contract.reason, "total_value_usd_not_number");
});

// ================== buildDiagnosticVerdict (revisado: exige endpointResult, no solo status) ==================

test("OO - ambos endpoints VALID_ENDPOINT_RESPONSE en las 3 iteraciones -> DIAGNOSTIC_OK", () => {
  const result = buildDiagnosticVerdict({
    marketDataResults: [{ endpointResult: "VALID_ENDPOINT_RESPONSE" }, { endpointResult: "VALID_ENDPOINT_RESPONSE" }, { endpointResult: "VALID_ENDPOINT_RESPONSE" }],
    futuresResults: [{ endpointResult: "VALID_ENDPOINT_RESPONSE" }, { endpointResult: "VALID_ENDPOINT_RESPONSE" }, { endpointResult: "VALID_ENDPOINT_RESPONSE" }],
  });
  assert.equal(result, "DIAGNOSTIC_OK");
});

test("PP - market-data intercepted por plataforma en cualquier iteracion -> DIAGNOSTIC_BLOCKED", () => {
  const result = buildDiagnosticVerdict({
    marketDataResults: [{ endpointResult: "VALID_ENDPOINT_RESPONSE" }, { endpointResult: "PLATFORM_INTERCEPT_OR_INVALID_RESPONSE" }, { endpointResult: "VALID_ENDPOINT_RESPONSE" }],
    futuresResults: [{ endpointResult: "VALID_ENDPOINT_RESPONSE" }, { endpointResult: "VALID_ENDPOINT_RESPONSE" }, { endpointResult: "VALID_ENDPOINT_RESPONSE" }],
  });
  assert.equal(result, "DIAGNOSTIC_BLOCKED");
});

test("QQ - futures-equity con 200 pero respuesta invalida (el caso real que motivo este cambio) -> DIAGNOSTIC_BLOCKED, NUNCA cuenta como exito solo por status 200", () => {
  const result = buildDiagnosticVerdict({
    marketDataResults: [{ endpointResult: "VALID_ENDPOINT_RESPONSE" }, { endpointResult: "VALID_ENDPOINT_RESPONSE" }, { endpointResult: "VALID_ENDPOINT_RESPONSE" }],
    futuresResults: [{ endpointResult: "VALID_ENDPOINT_RESPONSE" }, { endpointResult: "PLATFORM_INTERCEPT_OR_INVALID_RESPONSE" }, { endpointResult: "VALID_ENDPOINT_RESPONSE" }],
  });
  assert.equal(result, "DIAGNOSTIC_BLOCKED");
});

// ================== resolveCertificationUniverse ==================

const FIXED_FALLBACK = [{ ticker: "ETH", type: "crypto" }, { ticker: "AMZN", type: "stock" }];

test("RR - entries null (CERT_TICKERS no seteado) -> fallback al universo fijo, missingTrackedSubset vacio se ignora en este modo", () => {
  const result = resolveCertificationUniverse(null, FIXED_FALLBACK);
  assert.equal(result.source, "fallback_fixed_list");
  assert.deepEqual(result.universe, FIXED_FALLBACK);
  assert.deepEqual(result.missingTrackedSubset, []);
});

test("SS - array vacio -> throws, nunca certifica con universo vacio silenciosamente", () => {
  assert.throws(() => resolveCertificationUniverse([], FIXED_FALLBACK), /no vacio/);
});

test("TT - type invalido (ni 'stock' ni 'crypto') -> throws, nunca adivina el type", () => {
  assert.throws(() => resolveCertificationUniverse([{ ticker: "XYZ", type: "etf" }], FIXED_FALLBACK), /type debe ser/);
});

test("UU - ticker faltante en una entrada -> throws", () => {
  assert.throws(() => resolveCertificationUniverse([{ type: "stock" }], FIXED_FALLBACK), /ticker faltante/);
});

test("VV - deduplica tickers repetidos, conserva la primera aparicion", () => {
  const result = resolveCertificationUniverse(
    [{ ticker: "ETH", type: "crypto" }, { ticker: "BTC", type: "crypto" }, { ticker: "ETH", type: "crypto" }],
    FIXED_FALLBACK
  );
  assert.equal(result.source, "dynamic");
  assert.deepEqual(result.universe, [{ ticker: "ETH", type: "crypto" }, { ticker: "BTC", type: "crypto" }]);
});

test("WW - universo completo de 48 (positions UNION watchlist + USDT) con el subset trackeado presente -> missingTrackedSubset vacio", () => {
  const entries = TRACKED_SUBSET_TICKERS.map((t) => ({ ticker: t, type: ["ETH", "BTC", "LINK", "SOL", "USDT"].includes(t) ? "crypto" : "stock" }))
    .concat([{ ticker: "AAPL", type: "stock" }, { ticker: "TSM", type: "stock" }]);
  const result = resolveCertificationUniverse(entries, FIXED_FALLBACK);
  assert.equal(result.universe.length, 11);
  assert.deepEqual(result.missingTrackedSubset, []);
});

test("XX - universo dinamico sin USDT -> missingTrackedSubset=['USDT'], nunca se corre certification silenciosamente incompleta", () => {
  const entries = TRACKED_SUBSET_TICKERS.filter((t) => t !== "USDT").map((t) => ({ ticker: t, type: ["ETH", "BTC", "LINK", "SOL"].includes(t) ? "crypto" : "stock" }));
  const result = resolveCertificationUniverse(entries, FIXED_FALLBACK);
  assert.deepEqual(result.missingTrackedSubset, ["USDT"]);
});
