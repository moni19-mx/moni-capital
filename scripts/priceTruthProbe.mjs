#!/usr/bin/env node
// scripts/priceTruthProbe.mjs
//
// Price Truth Stability Probe. Corre en GitHub Actions (egress real --
// este sandbox de Claude Code no llega a *.vercel.app, confirmado con
// curl real en el sprint del Conviction Coverage Orchestrator).
//
// OBSERVA. NO CORRIGE. Llama exactamente los mismos dos endpoints
// publicos que ya usa el dashboard (api/market-data.js,
// api/futures-equity.js). CERO reimplementacion de logica
// financiera/Price Truth -- toda la clasificacion/assertions pura vive
// en lib/priceTruthProbeState.js, testeada aparte sin red.
//
// Dos modos, vocabulario de veredicto DISTINTO a proposito (nunca se
// confunden):
//   MODE=diagnostic (default 3 iteraciones, ~2 min) -- NO es una
//     certificacion de Price Truth. Objetivo: probar si el harness
//     mismo es observable (User-Agent, fingerprint de cualquier
//     401/no-2xx, breakdown real de futures-equity por balance).
//     Veredicto: DIAGNOSTIC_OK / DIAGNOSTIC_BLOCKED.
//   MODE=certification (16 iteraciones, ~15 min real) -- la corrida
//     de PASS/FAIL ya aprobada. Sin cambios de logica respecto a la
//     version anterior.
//
// Env requerido: TARGET_BASE_URL (SIN default -- si falta, sale con
// error explicito, nunca apunta a una URL adivinada).
// Env opcional: VERCEL_PROTECTION_BYPASS_SECRET (si Vercel Deployment
// Protection sigue activo en el Preview -- mismo patron de
// scripts/orchestrate-conviction.js, defense in depth, nunca
// reemplaza ningun auth de la app -- estos endpoints no tienen
// x-admin-secret hoy, se verifico en el codigo antes de asumirlo).
// MODE (default "diagnostic"), ITERATIONS, INTERVAL_MS.

import { writeFileSync, appendFileSync } from "node:fs";
import {
  classifyMarketDataIteration, classifyFuturesIteration,
  detectLkgRegression, detectCrossProviderContamination, detectFuturesValuationRegression,
  buildProbeSummary, sanitizeHeadersForLog, truncateBody, classifyResponseFingerprint, buildDiagnosticVerdict,
  classifyEndpointDiagnosticResult, validateFuturesContract, validateMarketDataContract,
  resolveCertificationUniverse,
} from "../lib/priceTruthProbeState.js";

const TARGET_BASE_URL = process.env.TARGET_BASE_URL;
if (!TARGET_BASE_URL) {
  console.error("[fatal] TARGET_BASE_URL es requerido -- no hay default, nunca se adivina un deployment.");
  process.exit(1);
}
const VERCEL_BYPASS = process.env.VERCEL_PROTECTION_BYPASS_SECRET;
const MODE = (process.env.MODE || "diagnostic").toLowerCase(); // "diagnostic" | "certification"
const ITERATIONS = Number(process.env.ITERATIONS || (MODE === "certification" ? 16 : 3));
const INTERVAL_MS = Number(process.env.INTERVAL_MS || 60_000);
const CODE_BASE_SHA = process.env.GITHUB_SHA || process.env.CODE_BASE_SHA || "unknown";
// Identificador server-to-server legitimo, mismo patron ya usado en
// lib/prices.js para CoinGecko -- NUNCA se falsea un fingerprint de
// navegador, nunca se oculta que esto es un probe automatizado.
const USER_AGENT = "Moni-Capital-PriceTruth-Probe/1.0 (+https://moni-capital.vercel.app)";

const PROBE_TICKERS = [
  { ticker: "ETH", type: "crypto" },
  { ticker: "BTC", type: "crypto" },
  { ticker: "LINK", type: "crypto" },
  { ticker: "SOL", type: "crypto" },
  { ticker: "USDT", type: "crypto" }, // explicito -- USD-M depende de esto, nunca se asume que ya esta en el universo normal
  { ticker: "AMZN", type: "stock" },
  { ticker: "META", type: "stock" },
  { ticker: "NVDA", type: "stock" },
  { ticker: "QCOM", type: "stock" },
];
const TICKER_NAMES = PROBE_TICKERS.map((t) => t.ticker);
const PROVIDER_BY_TICKER = Object.fromEntries(PROBE_TICKERS.map((t) => [t.ticker, t.type === "crypto" ? "coingecko" : "finnhub"]));

// CERT_TICKERS: universo dinamico opcional para MODE=certification
// UNICAMENTE (positions UNION watchlist deduplicado + USDT, ya resuelto
// contra la tabla `assets` real antes de disparar el workflow -- este
// script NUNCA llama Supabase ni auto-crea/adivina un asset_type). Si no
// se provee, certification usa el mismo PROBE_TICKERS fijo de siempre.
// MODE=diagnostic ignora esta variable por completo -- sin cambios de
// comportamiento ahi.
function parseCertTickersEnv(raw) {
  if (!raw) return null;
  let parsed;
  try { parsed = JSON.parse(raw); } catch (e) {
    console.error(`[fatal] CERT_TICKERS no es JSON valido: ${e.message}`);
    process.exit(1);
  }
  return parsed;
}

function nowIso() { return new Date().toISOString(); }

function authHeaders(extra = {}) {
  const h = { "User-Agent": USER_AGENT, ...extra };
  if (VERCEL_BYPASS) h["x-vercel-protection-bypass"] = VERCEL_BYPASS;
  return h;
}

// Clasifica un 401/403 como bloqueo de plataforma vs falla real del
// endpoint -- ninguno de los dos endpoints del probe exige
// x-admin-secret (verificado en el codigo antes de asumirlo), asi que
// un 401/403 aqui es casi siempre plataforma, nunca la app rechazando
// credenciales que no le pedimos. Usado por el modo certificacion
// (resumen simple); el modo diagnostico usa el fingerprint completo
// (classifyResponseFingerprint) ademas de esto.
function classifyHttpFailure(status, contentType) {
  if (status !== 401 && status !== 403) return null;
  const isJson = (contentType || "").includes("application/json");
  return isJson ? "APP_LEVEL_REJECTION_UNEXPECTED" : "PLATFORM_AUTH_FAILED";
}

async function callJson(url, opts, iteration, endpointLabel, httpFailures) {
  const start = Date.now();
  let resp, text = "";
  try {
    resp = await fetch(url, opts);
    text = await resp.text();
  } catch (e) {
    httpFailures.push({ iteration, timestamp: nowIso(), endpoint: endpointLabel, status: "NETWORK_ERROR", detail: String(e && e.message || e) });
    return { ok: false, status: "NETWORK_ERROR", duration_ms: Date.now() - start, json: null, rawText: null, headers: null };
  }
  const duration_ms = Date.now() - start;
  const contentType = resp.headers.get("content-type") || "";
  let json = null;
  try { json = JSON.parse(text); } catch { /* respuesta no-JSON */ }

  if (!resp.ok) {
    const authFailure = classifyHttpFailure(resp.status, contentType);
    httpFailures.push({ iteration, timestamp: nowIso(), endpoint: endpointLabel, status: resp.status, detail: authFailure || `content-type=${contentType}` });
    return { ok: false, status: resp.status, duration_ms, json, rawText: text, headers: resp.headers, authFailure, contentType };
  }
  return { ok: true, status: resp.status, duration_ms, json, rawText: text, headers: resp.headers, contentType };
}

// ================== MODO DIAGNOSTICO ==================
// Revision (item 2/3): un 200 NUNCA se cuenta como exito por si solo,
// para NINGUNO de los dos endpoints -- Vercel Authentication puede
// devolver 200 con una pagina HTML de auto-redirect en vez de dejar
// pasar la request al handler real (evidencia real encontrada: el
// 401 de market-data trae `auto_vercel_auth_redirect: true`). Siempre
// se captura el fingerprint completo (status/content-type/body
// truncado/headers seguros/duration), en TODAS las iteraciones, no
// solo en las que fallan por HTTP.
async function runDiagnostic() {
  const startedAt = nowIso();
  console.log(`[diagnostic] TARGET_BASE_URL=${TARGET_BASE_URL} CODE_BASE_SHA=${CODE_BASE_SHA} iterations=${ITERATIONS} interval_ms=${INTERVAL_MS} user_agent="${USER_AGENT}"`);
  console.log(`[diagnostic] started_at=${startedAt}`);

  writeFileSync("price-truth-diagnostic.jsonl", "");
  const httpFailures = [];
  const marketDataResults = [];
  const futuresResults = [];
  const perIteration = [];

  for (let i = 1; i <= ITERATIONS; i++) {
    const iterStart = nowIso();

    const mdResp = await callJson(
      `${TARGET_BASE_URL}/api/market-data`,
      { method: "POST", headers: authHeaders({ "Content-Type": "application/json" }), body: JSON.stringify({ items: PROBE_TICKERS }) },
      i, "market-data", httpFailures
    );
    const mdStatus = typeof mdResp.status === "number" ? mdResp.status : 0;
    const mdDiag = classifyEndpointDiagnosticResult({ status: mdStatus, contentType: mdResp.contentType, rawText: mdResp.rawText, validateContract: validateMarketDataContract });
    marketDataResults.push({ endpointResult: mdDiag.result });

    const mdFingerprint = {
      status: mdStatus, content_type: mdResp.contentType || null,
      body_snippet: truncateBody(mdResp.rawText, 500), headers: sanitizeHeadersForLog(mdResp.headers),
      method: "POST", url_path: "/api/market-data", duration_ms: mdResp.duration_ms,
      json_parsed: mdDiag.shape === "HTTP_200_VALID_JSON", top_level_keys: mdDiag.topLevelKeys,
      shape: mdDiag.shape, endpoint_result: mdDiag.result, contract: mdDiag.contract,
      fingerprint_classification: mdStatus !== 200 ? classifyResponseFingerprint({ status: mdStatus, contentType: mdResp.contentType, bodySnippet: mdResp.rawText, headers: sanitizeHeadersForLog(mdResp.headers) }) : null,
    };
    console.log(`[diagnostic] iter ${i}/${ITERATIONS} market-data ${mdDiag.result}: ${JSON.stringify(mdFingerprint)}`);

    let mdTickers = null;
    if (mdDiag.result === "VALID_ENDPOINT_RESPONSE") {
      mdTickers = classifyMarketDataIteration(mdResp.json, TICKER_NAMES);
      console.log(`[diagnostic]   tickers: ${JSON.stringify(mdTickers)}`);
    }

    const feResp = await callJson(
      `${TARGET_BASE_URL}/api/futures-equity`,
      { method: "GET", headers: authHeaders() },
      i, "futures-equity", httpFailures
    );
    const feStatus = typeof feResp.status === "number" ? feResp.status : 0;
    const feDiag = classifyEndpointDiagnosticResult({ status: feStatus, contentType: feResp.contentType, rawText: feResp.rawText, validateContract: validateFuturesContract });
    futuresResults.push({ endpointResult: feDiag.result });

    const feFingerprint = {
      status: feStatus, content_type: feResp.contentType || null,
      body_snippet: truncateBody(feResp.rawText, 500), headers: sanitizeHeadersForLog(feResp.headers),
      method: "GET", url_path: "/api/futures-equity", duration_ms: feResp.duration_ms,
      json_parsed: feDiag.shape === "HTTP_200_VALID_JSON", top_level_keys: feDiag.topLevelKeys,
      shape: feDiag.shape, endpoint_result: feDiag.result, contract: feDiag.contract,
      fingerprint_classification: feStatus !== 200 ? classifyResponseFingerprint({ status: feStatus, contentType: feResp.contentType, bodySnippet: feResp.rawText, headers: sanitizeHeadersForLog(feResp.headers) }) : null,
    };
    console.log(`[diagnostic] iter ${i}/${ITERATIONS} futures-equity ${feDiag.result}: ${JSON.stringify(feFingerprint)}`);

    let feBalances = null;
    if (feDiag.result === "VALID_ENDPOINT_RESPONSE") {
      feBalances = classifyFuturesIteration(feResp.json);
      console.log(`[diagnostic]   USD-M (USDT): ${JSON.stringify(feBalances.usdm)}`);
      console.log(`[diagnostic]   COIN-M (BTC): ${JSON.stringify(feBalances.coinm)}`);
    }

    const record = {
      iteration: i, timestamp: iterStart,
      market_data: mdFingerprint, market_data_tickers: mdTickers,
      futures_equity: feFingerprint, futures_equity_balances: feBalances,
    };
    perIteration.push(record);
    appendFileSync("price-truth-diagnostic.jsonl", JSON.stringify(record) + "\n");

    if (i < ITERATIONS) await new Promise((r) => setTimeout(r, INTERVAL_MS));
  }

  const finishedAt = nowIso();
  const verdict = buildDiagnosticVerdict({ marketDataResults, futuresResults });

  const lines = [];
  lines.push("# PRICE TRUTH -- SHORT DIAGNOSTIC PROBE");
  lines.push("");
  lines.push(`verdict: **${verdict}** (NO es una certificacion Price Truth -- eso solo lo produce MODE=certification)`);
  lines.push(`code_base_sha: ${CODE_BASE_SHA}`);
  lines.push(`started_at: ${startedAt} | finished_at: ${finishedAt}`);
  lines.push(`iterations: ${ITERATIONS}`);
  lines.push("");
  lines.push("## 1. market-data -- por iteracion (endpoint_result, nunca solo status)");
  perIteration.forEach((r) => lines.push(`- iter ${r.iteration}: ${JSON.stringify(r.market_data)}`));
  lines.push("");
  lines.push("## 2. market-data tickers (solo iteraciones VALID_ENDPOINT_RESPONSE)");
  perIteration.filter((r) => r.market_data_tickers).forEach((r) => lines.push(`- iter ${r.iteration}: ${JSON.stringify(r.market_data_tickers)}`));
  lines.push("");
  lines.push("## 3. futures-equity -- por iteracion (endpoint_result, nunca solo status)");
  perIteration.forEach((r) => lines.push(`- iter ${r.iteration}: ${JSON.stringify(r.futures_equity)}`));
  lines.push("");
  lines.push("## 4. futures-equity breakdown USD-M / COIN-M (solo iteraciones VALID_ENDPOINT_RESPONSE)");
  perIteration.filter((r) => r.futures_equity_balances).forEach((r) => lines.push(`- iter ${r.iteration}: ${JSON.stringify(r.futures_equity_balances)}`));
  lines.push("");
  lines.push(`user_agent_applied: "${USER_AGENT}" (aplicado a AMBAS llamadas, market-data y futures-equity)`);

  const markdown = lines.join("\n");
  writeFileSync("price-truth-diagnostic-summary.md", markdown);
  console.log(markdown);
  console.log(`[diagnostic] verdict=${verdict}`);
  if (verdict === "DIAGNOSTIC_BLOCKED") process.exitCode = 1;
}

// ================== MODO CERTIFICACION (16 iteraciones, sin cambios de logica) ==================
async function runCertification() {
  const startedAt = nowIso();
  console.log(`[probe] TARGET_BASE_URL=${TARGET_BASE_URL} CODE_BASE_SHA=${CODE_BASE_SHA} iterations=${ITERATIONS} interval_ms=${INTERVAL_MS} user_agent="${USER_AGENT}"`);
  console.log(`[probe] started_at=${startedAt}`);

  // Universo: dinamico (positions UNION watchlist deduplicado + USDT, ya
  // resuelto contra `assets` real) si CERT_TICKERS viene seteado, si no
  // el mismo PROBE_TICKERS fijo de siempre. resolveCertificationUniverse
  // es pura (lib/priceTruthProbeState.js) -- aqui solo se parsea el JSON
  // del env var y se sale con error explicito si es invalido, nunca se
  // silencia ni se cae de vuelta al fijo por un parse error.
  const certTickersEntries = parseCertTickersEnv(process.env.CERT_TICKERS);
  const { universe, source, missingTrackedSubset } = resolveCertificationUniverse(certTickersEntries, PROBE_TICKERS);
  if (missingTrackedSubset.length > 0) {
    console.error(`[fatal] certification universe (source=${source}) no incluye el subset trackeado explicito: ${missingTrackedSubset.join(", ")}`);
    process.exit(1);
  }
  const universeTickers = universe;
  const universeNames = universeTickers.map((t) => t.ticker);
  const providerByTicker = Object.fromEntries(universeTickers.map((t) => [t.ticker, t.type === "crypto" ? "coingecko" : "finnhub"]));
  console.log(`[probe] certification_universe_source=${source} certification_universe_size=${universeNames.length}`);
  console.log(`[probe] certification_universe_tickers=${JSON.stringify(universeNames)}`);

  writeFileSync("price-truth-probe.jsonl", "");

  const httpFailures = [];
  const lkgRegressions = [];
  const futuresRegressions = [];
  const providerIsolationViolations = [];
  const dataUnavailableLog = [];
  const staleTransitionLog = [];
  let finnhubRateLimitEvents = 0;
  let coingeckoRateLimitEvents = 0;

  const bestByTicker = {}; // ticker -> {status, price, iteration}
  const lastStatusByTicker = {}; // ticker -> status (para detectar transiciones STALE/STALE_RATE_LIMITED)
  const tickerAvailability = Object.fromEntries(universeNames.map((t) => [t, 0]));
  let usdmAvailability = 0, coinmAvailability = 0;
  let bestUsdm = null, bestCoinm = null;
  let prevProviderStatuses = null;
  const futuresEquityValues = [];

  let actualIterations = 0;
  for (let i = 1; i <= ITERATIONS; i++) {
    const iterStart = nowIso();

    const mdResp = await callJson(
      `${TARGET_BASE_URL}/api/market-data`,
      { method: "POST", headers: authHeaders({ "Content-Type": "application/json" }), body: JSON.stringify({ items: universeTickers }) },
      i, "market-data", httpFailures
    );
    const feResp = await callJson(
      `${TARGET_BASE_URL}/api/futures-equity`,
      { method: "GET", headers: authHeaders() },
      i, "futures-equity", httpFailures
    );

    actualIterations = i;

    const mdClassified = mdResp.ok ? classifyMarketDataIteration(mdResp.json, universeNames) : Object.fromEntries(universeNames.map((t) => [t, { status: "HTTP_FAILURE", price: null }]));
    const feClassified = feResp.ok ? classifyFuturesIteration(feResp.json) : { usdm: null, coinm: null, total_value_usd: null, is_complete: null, warnings: [] };

    const currProviderStatuses = mdResp.ok ? { finnhub: mdResp.json?.finnhub_status, coingecko: mdResp.json?.coingecko_status } : { finnhub: null, coingecko: null };
    if (currProviderStatuses.finnhub === "RATE_LIMITED") finnhubRateLimitEvents++;
    if (currProviderStatuses.coingecko === "RATE_LIMITED") coingeckoRateLimitEvents++;

    // -------- LKG regression por ticker --------
    for (const ticker of universeNames) {
      const current = mdClassified[ticker];
      const provider = providerByTicker[ticker];
      const { regression, newBest } = detectLkgRegression({
        ticker, provider, previousBest: bestByTicker[ticker] || null, current, iterationIndex: i,
        providerHealth: { finnhub_status: currProviderStatuses.finnhub, coingecko_status: currProviderStatuses.coingecko },
      });
      if (regression) { lkgRegressions.push(regression); dataUnavailableLog.push({ iteration: i, timestamp: iterStart, ticker }); }
      if (newBest) bestByTicker[ticker] = newBest;
      if (current.status === "DATA_UNAVAILABLE" && !regression) dataUnavailableLog.push({ iteration: i, timestamp: iterStart, ticker });
      if (["LIVE", "CACHED", "STALE", "STALE_RATE_LIMITED"].includes(current.status)) tickerAvailability[ticker]++;

      const prevStatus = lastStatusByTicker[ticker];
      if (prevStatus && prevStatus !== current.status && (current.status === "STALE" || current.status === "STALE_RATE_LIMITED" || prevStatus === "STALE" || prevStatus === "STALE_RATE_LIMITED")) {
        staleTransitionLog.push({ iteration: i, timestamp: iterStart, ticker, from: prevStatus, to: current.status });
      }
      lastStatusByTicker[ticker] = current.status;
    }

    // -------- Provider isolation (correlacional, ver lib) --------
    if (prevProviderStatuses) {
      const viol1 = detectCrossProviderContamination({ providerAName: "coingecko", providerBName: "finnhub", prevStatuses: prevProviderStatuses, currStatuses: currProviderStatuses });
      if (viol1.violation) providerIsolationViolations.push({ ...viol1, iteration: i });
      const viol2 = detectCrossProviderContamination({ providerAName: "finnhub", providerBName: "coingecko", prevStatuses: prevProviderStatuses, currStatuses: currProviderStatuses });
      if (viol2.violation) providerIsolationViolations.push({ ...viol2, iteration: i });
    }
    prevProviderStatuses = currProviderStatuses;

    // -------- Futures valuation regression (USD-M / COIN-M) --------
    const usdmResult = detectFuturesValuationRegression({ bucket: "USD-M", previousIncluded: bestUsdm, currentIncluded: feClassified.usdm, iterationIndex: i, current: feClassified.usdm });
    if (usdmResult.regression) futuresRegressions.push(usdmResult.regression);
    if (usdmResult.newIncluded) bestUsdm = usdmResult.newIncluded;
    if (feClassified.usdm && feClassified.usdm.included) usdmAvailability++;

    const coinmResult = detectFuturesValuationRegression({ bucket: "COIN-M", previousIncluded: bestCoinm, currentIncluded: feClassified.coinm, iterationIndex: i, current: feClassified.coinm });
    if (coinmResult.regression) futuresRegressions.push(coinmResult.regression);
    if (coinmResult.newIncluded) bestCoinm = coinmResult.newIncluded;
    if (feClassified.coinm && feClassified.coinm.included) coinmAvailability++;

    if (typeof feClassified.total_value_usd === "number") futuresEquityValues.push(feClassified.total_value_usd);

    // -------- Log crudo (JSONL, nunca secretos) --------
    const record = {
      iteration: i, timestamp: iterStart,
      market_data: { http_status: mdResp.status, duration_ms: mdResp.duration_ms, finnhub_status: currProviderStatuses.finnhub, coingecko_status: currProviderStatuses.coingecko, tickers: mdClassified },
      futures_equity: { http_status: feResp.status, duration_ms: feResp.duration_ms, ...feClassified },
    };
    appendFileSync("price-truth-probe.jsonl", JSON.stringify(record) + "\n");
    console.log(`[probe] iter ${i}/${ITERATIONS} md=${mdResp.status}(${mdResp.duration_ms}ms) fe=${feResp.status}(${feResp.duration_ms}ms) finnhub=${currProviderStatuses.finnhub} coingecko=${currProviderStatuses.coingecko}`);

    if (i < ITERATIONS) await new Promise((r) => setTimeout(r, INTERVAL_MS));
  }

  const finishedAt = nowIso();
  const futuresEquityMinMax = futuresEquityValues.length > 0 ? { min: Math.min(...futuresEquityValues), max: Math.max(...futuresEquityValues) } : null;

  const { markdown, verdict, elapsedSeconds } = buildProbeSummary({
    startedAt, finishedAt, requestedIterations: ITERATIONS, actualIterations,
    httpFailures, finnhubRateLimitEvents, coingeckoRateLimitEvents,
    providerIsolationViolations, lkgRegressions, futuresRegressions,
    tickerAvailability, usdmAvailability, coinmAvailability,
    futuresEquityMinMax, dataUnavailableLog, staleTransitionLog,
    codeBaseSha: CODE_BASE_SHA, probeCommitSha: null,
  });

  writeFileSync("price-truth-summary.md", markdown);
  console.log(markdown);
  console.log(`[probe] elapsed_seconds=${elapsedSeconds} verdict=${verdict}`);

  if (verdict === "FAIL") process.exitCode = 1;
}

async function main() {
  if (MODE === "certification") await runCertification();
  else await runDiagnostic();
}

main().catch((e) => { console.error("[fatal]", e); process.exit(1); });
