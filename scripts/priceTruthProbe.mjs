#!/usr/bin/env node
// scripts/priceTruthProbe.mjs
//
// Price Truth Stability Probe. Corre en GitHub Actions (egress real --
// este sandbox de Claude Code no llega a *.vercel.app, confirmado con
// curl real en el sprint del Conviction Coverage Orchestrator).
//
// OBSERVA. NO CORRIGE. Llama exactamente los mismos dos endpoints
// publicos que ya usa el dashboard (api/market-data.js,
// api/futures-equity.js) cada ~60s durante ~15 minutos reales, y
// registra lo que devuelven. CERO reimplementacion de logica
// financiera/Price Truth -- toda la clasificacion/assertions pura vive
// en lib/priceTruthProbeState.js, testeada aparte sin red.
//
// Env requerido: TARGET_BASE_URL (SIN default -- si falta, sale con
// error explicito, nunca apunta a una URL adivinada).
// Env opcional: VERCEL_PROTECTION_BYPASS_SECRET (si Vercel Deployment
// Protection sigue activo en el Preview -- mismo patron de
// scripts/orchestrate-conviction.js, defense in depth, nunca
// reemplaza ningun auth de la app -- estos endpoints no tienen
// x-admin-secret hoy, se verifico en el codigo antes de asumirlo).
// ITERATIONS (default 16), INTERVAL_MS (default 60000).

import { writeFileSync, appendFileSync } from "node:fs";
import {
  classifyMarketDataIteration, classifyFuturesIteration,
  detectLkgRegression, detectCrossProviderContamination, detectFuturesValuationRegression,
  buildProbeSummary,
} from "../lib/priceTruthProbeState.js";

const TARGET_BASE_URL = process.env.TARGET_BASE_URL;
if (!TARGET_BASE_URL) {
  console.error("[fatal] TARGET_BASE_URL es requerido -- no hay default, nunca se adivina un deployment.");
  process.exit(1);
}
const VERCEL_BYPASS = process.env.VERCEL_PROTECTION_BYPASS_SECRET;
const ITERATIONS = Number(process.env.ITERATIONS || 16); // 16 con 60s de intervalo -- ~15 min entre la muestra #1 y la #16, ver nota del usuario.
const INTERVAL_MS = Number(process.env.INTERVAL_MS || 60_000);
const CODE_BASE_SHA = process.env.GITHUB_SHA || process.env.CODE_BASE_SHA || "unknown";

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

function nowIso() { return new Date().toISOString(); }

function authHeaders(extra = {}) {
  const h = { ...extra };
  if (VERCEL_BYPASS) h["x-vercel-protection-bypass"] = VERCEL_BYPASS;
  return h;
}

// Clasifica un 401/403 como bloqueo de plataforma (Vercel Deployment
// Protection) vs falla real del endpoint -- ninguno de los dos
// endpoints del probe exige x-admin-secret (verificado en el codigo
// antes de asumirlo), asi que un 401/403 aqui es casi siempre
// plataforma, nunca la app rechazando credenciales que no le pedimos.
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
    return { ok: false, status: "NETWORK_ERROR", duration_ms: Date.now() - start, json: null };
  }
  const duration_ms = Date.now() - start;
  const contentType = resp.headers.get("content-type") || "";
  let json = null;
  try { json = JSON.parse(text); } catch { /* respuesta no-JSON */ }

  if (!resp.ok) {
    const authFailure = classifyHttpFailure(resp.status, contentType);
    httpFailures.push({ iteration, timestamp: nowIso(), endpoint: endpointLabel, status: resp.status, detail: authFailure || `content-type=${contentType}` });
    return { ok: false, status: resp.status, duration_ms, json, authFailure };
  }
  return { ok: true, status: resp.status, duration_ms, json, contentType };
}

async function main() {
  const startedAt = nowIso();
  console.log(`[probe] TARGET_BASE_URL=${TARGET_BASE_URL} CODE_BASE_SHA=${CODE_BASE_SHA} iterations=${ITERATIONS} interval_ms=${INTERVAL_MS}`);
  console.log(`[probe] started_at=${startedAt}`);

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
  const tickerAvailability = Object.fromEntries(TICKER_NAMES.map((t) => [t, 0]));
  let usdmAvailability = 0, coinmAvailability = 0;
  let bestUsdm = null, bestCoinm = null;
  let prevProviderStatuses = null;
  const futuresEquityValues = [];

  let actualIterations = 0;
  for (let i = 1; i <= ITERATIONS; i++) {
    const iterStart = nowIso();

    const mdResp = await callJson(
      `${TARGET_BASE_URL}/api/market-data`,
      { method: "POST", headers: authHeaders({ "Content-Type": "application/json" }), body: JSON.stringify({ items: PROBE_TICKERS }) },
      i, "market-data", httpFailures
    );
    const feResp = await callJson(
      `${TARGET_BASE_URL}/api/futures-equity`,
      { method: "GET", headers: authHeaders() },
      i, "futures-equity", httpFailures
    );

    actualIterations = i;

    const mdClassified = mdResp.ok ? classifyMarketDataIteration(mdResp.json, TICKER_NAMES) : Object.fromEntries(TICKER_NAMES.map((t) => [t, { status: "HTTP_FAILURE", price: null }]));
    const feClassified = feResp.ok ? classifyFuturesIteration(feResp.json) : { usdm: null, coinm: null, total_value_usd: null, is_complete: null, warnings: [] };

    const currProviderStatuses = mdResp.ok ? { finnhub: mdResp.json?.finnhub_status, coingecko: mdResp.json?.coingecko_status } : { finnhub: null, coingecko: null };
    if (currProviderStatuses.finnhub === "RATE_LIMITED") finnhubRateLimitEvents++;
    if (currProviderStatuses.coingecko === "RATE_LIMITED") coingeckoRateLimitEvents++;

    // -------- LKG regression por ticker --------
    for (const ticker of TICKER_NAMES) {
      const current = mdClassified[ticker];
      const provider = PROVIDER_BY_TICKER[ticker];
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

main().catch((e) => { console.error("[fatal]", e); process.exit(1); });
