// api/fmp-benchmark-temp.js
//
// DIAGNOSTICO TEMPORAL -- no forma parte del flujo de produccion de Moni
// Capital. No lo importa ningun otro archivo. Se borra de este repo
// cuando terminemos de decidir Starter vs Premium.
//
// Uso: GET /api/fmp-benchmark-temp?pin=TU_PIN&ticker=META&assetType=stock
//   assetType: "stock" o "crypto"
//   Para crypto, ticker debe ser el simbolo FMP real: BTCUSD, ETHUSD,
//   SOLUSD, LINKUSD (no BTC/ETH/SOL/LINK planos).
//
// Un ticker por llamada, para quedar comodamente debajo del limite de
// tiempo de una funcion serverless. Se visita la URL 16 veces (una por
// cada ticker/simbolo), cambiando el parametro `ticker` cada vez.
//
// Nunca devuelve ni loguea la API key en la respuesta ni en errores.

import { createClient } from "@supabase/supabase-js";
// Historical Multiple Data Review: normalizacion PURA y testeable de la
// forma real de respuesta de FMP historical-price-eod/full (ver
// lib/fmpHistoricalNormalizer.js -- bugfix real, el probe asumia
// siempre `{ historical: [...] }` y clasificaba NO_DATA para
// respuestas que son un array de nivel superior).
import { normalizeFmpHistoricalResponse } from "../lib/fmpHistoricalNormalizer.js";
// Micro-sprint P0.2 (Financial Totals Correctness + Stability), cierre
// final. Reutiliza la formula canonica unica -- CERO reimplementacion.
import {
  buildMarketDataItems, mergeMarketData, enrichPositions, computeCashValue,
  computeStocksValue, computeCryptoValue, computePatrimonioBase, computePatrimonio,
  computeInvested, computeTotalGain, unclassifiedPositions,
} from "../lib/financialSnapshot.js";
// Mismos bloques puros que usan api/market-data.js y api/futures-equity.js
// -- se llaman DIRECTO en vez de por fetch interno porque Vercel
// Deployment Protection (SSO del preview) bloquea con 401 cualquier
// fetch de la funcion hacia si misma en el mismo deployment; llamar la
// funcion en vez del endpoint evita el 401 sin reimplementar nada real.
import { getStockData, getCryptoData, COINGECKO_FALLBACK_IDS } from "../lib/prices.js";
import { mapWithConcurrency } from "../lib/aiPriceCache.js";
import { valuateAccountEquity, selectLatestConfirmedSnapshot } from "../lib/reconciliationEngine.js";
// Micro-sprint P0.3 (Market Price Cache + Provider Resilience) --
// misma politica cache-first + circuit breaker que la app real.
import { createRateLimitBreaker, buildCacheWriteRow, computeTtlMs, MAX_STALE_AGE_MS, isBreakerTripped } from "../lib/priceCache.js";
import { resolveTickerPrice, summarizeProviderHealthDetailed } from "../lib/marketDataOrchestrator.js";

const supabase = createClient(
  process.env.VITE_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const FMP_BASE = "https://financialmodelingprep.com/stable";
const REQUEST_DELAY_MS = 150;

const STOCK_ENDPOINTS = [
  { name: "quote", path: (s) => `/quote?symbol=${s}`, dataTypes: ["current_price"], parseRecords: (d) => (Array.isArray(d) ? d.length : d ? 1 : 0) },
  { name: "historical_price_eod_full", path: (s) => `/historical-price-eod/full?symbol=${s}`, dataTypes: ["historical_prices"], parseRecords: (d) => d?.historical?.length ?? (Array.isArray(d) ? d.length : 0) },
  { name: "income_statement", path: (s) => `/income-statement?symbol=${s}&period=annual&limit=5`, dataTypes: ["historical_revenue", "historical_eps", "ebitda"], parseRecords: (d) => (Array.isArray(d) ? d.length : 0) },
  { name: "balance_sheet_statement", path: (s) => `/balance-sheet-statement?symbol=${s}&period=annual&limit=5`, dataTypes: ["balance_sheet"], parseRecords: (d) => (Array.isArray(d) ? d.length : 0) },
  { name: "cash_flow_statement", path: (s) => `/cash-flow-statement?symbol=${s}&period=annual&limit=5`, dataTypes: ["free_cash_flow"], parseRecords: (d) => (Array.isArray(d) ? d.length : 0) },
  { name: "ratios", path: (s) => `/ratios?symbol=${s}&period=annual&limit=5`, dataTypes: ["gross_margin", "operating_margin", "net_margin"], parseRecords: (d) => (Array.isArray(d) ? d.length : 0) },
  { name: "financial_growth", path: (s) => `/financial-growth?symbol=${s}&period=annual&limit=5`, dataTypes: ["historical_growth"], parseRecords: (d) => (Array.isArray(d) ? d.length : 0) },
  { name: "analyst_estimates", path: (s) => `/analyst-estimates?symbol=${s}&period=annual&page=0&limit=10`, dataTypes: ["forward_eps", "forward_revenue", "analyst_consensus", "earnings_revisions"], parseRecords: (d) => (Array.isArray(d) ? d.length : 0) },
  { name: "price_target_consensus", path: (s) => `/price-target-consensus?symbol=${s}`, dataTypes: ["price_target_consensus"], parseRecords: (d) => (Array.isArray(d) ? d.length : d ? 1 : 0) },
  { name: "earnings", path: (s) => `/earnings?symbol=${s}&limit=8`, dataTypes: ["earnings_calendar", "earnings_surprises"], parseRecords: (d) => (Array.isArray(d) ? d.length : 0) },
  { name: "news_stock", path: (s) => `/news/stock?symbols=${s}&limit=10`, dataTypes: ["ticker_news"], parseRecords: (d) => (Array.isArray(d) ? d.length : 0) },
];

const CRYPTO_ENDPOINTS = [
  { name: "quote", path: (s) => `/quote?symbol=${s}`, dataTypes: ["current_price"], parseRecords: (d) => (Array.isArray(d) ? d.length : d ? 1 : 0) },
  { name: "historical_price_eod_full", path: (s) => `/historical-price-eod/full?symbol=${s}`, dataTypes: ["historical_prices"], parseRecords: (d) => d?.historical?.length ?? (Array.isArray(d) ? d.length : 0) },
  { name: "news_crypto", path: (s) => `/news/crypto?symbols=${s}&limit=10`, dataTypes: ["ticker_news"], parseRecords: (d) => (Array.isArray(d) ? d.length : 0) },
];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function looksLikePlanBlockedMessage(text) {
  const lower = text.toLowerCase();
  return (
    lower.includes("upgrade") ||
    lower.includes("not available under your current") ||
    lower.includes("premium query") ||
    lower.includes("subscription") ||
    lower.includes("special endpoint")
  );
}

function extractLatestDate(data) {
  const arr = Array.isArray(data) ? data : data?.historical || null;
  if (!arr || arr.length === 0) return null;
  const first = arr[0];
  return first?.date || first?.acceptedDate || first?.publishedDate || null;
}

async function testEndpoint(FMP_KEY, ticker, assetType, endpointDef) {
  const url = `${FMP_BASE}${endpointDef.path(ticker)}&apikey=${FMP_KEY}`;
  const startedAt = Date.now();
  let resp;
  try {
    resp = await fetch(url);
  } catch (networkErr) {
    return { classification: "ERROR", httpStatus: null, recordCount: null, latestDate: null, latencyMs: Date.now() - startedAt, note: `network_error: ${networkErr.message}` };
  }

  const latencyMs = Date.now() - startedAt;

  if (resp.status === 401 || resp.status === 403 || resp.status === 402) {
    return { classification: "PLAN_BLOCKED", httpStatus: resp.status, recordCount: 0, latestDate: null, latencyMs, note: `http_${resp.status}` };
  }
  if (resp.status === 429) {
    return { classification: "ERROR", httpStatus: 429, recordCount: null, latestDate: null, latencyMs, note: "rate_limited" };
  }
  if (!resp.ok) {
    return { classification: "ERROR", httpStatus: resp.status, recordCount: 0, latestDate: null, latencyMs, note: `http_${resp.status}` };
  }

  const rawText = await resp.text();
  let data = null;
  try {
    data = JSON.parse(rawText);
  } catch (e) {
    return { classification: "ERROR", httpStatus: resp.status, recordCount: 0, latestDate: null, latencyMs, note: "invalid_json_response" };
  }

  if (data && typeof data === "object" && !Array.isArray(data) && (data["Error Message"] || data.error)) {
    const msg = String(data["Error Message"] || data.error);
    if (looksLikePlanBlockedMessage(msg)) {
      return { classification: "PLAN_BLOCKED", httpStatus: 200, recordCount: 0, latestDate: null, latencyMs, note: msg.slice(0, 150) };
    }
    return { classification: "ERROR", httpStatus: 200, recordCount: 0, latestDate: null, latencyMs, note: msg.slice(0, 150) };
  }

  const recordCount = endpointDef.parseRecords(data);
  const latestDate = extractLatestDate(data);
  let classification;
  if (recordCount === 0) classification = "UNAVAILABLE";
  else if (recordCount <= 1 && endpointDef.name !== "quote" && endpointDef.name !== "price_target_consensus") classification = "LIMITED";
  else classification = "AVAILABLE";

  return { classification, httpStatus: resp.status, recordCount, latestDate, latencyMs, note: null };
}

async function crossCheckFinnhub(ticker) {
  const FINNHUB_KEY = process.env.FINNHUB_API_KEY;
  if (!FINNHUB_KEY) return null;
  try {
    const [quoteResp, metricResp] = await Promise.all([
      fetch(`https://finnhub.io/api/v1/quote?symbol=${ticker}&token=${FINNHUB_KEY}`),
      fetch(`https://finnhub.io/api/v1/stock/metric?symbol=${ticker}&metric=all&token=${FINNHUB_KEY}`),
    ]);
    const quote = await quoteResp.json();
    const metric = await metricResp.json();
    return {
      price: typeof quote?.c === "number" ? quote.c : null,
      marketCap: typeof metric?.metric?.marketCapitalization === "number" ? metric.metric.marketCapitalization * 1_000_000 : null,
      pe: typeof metric?.metric?.peBasicExclExtraTTM === "number" ? metric.metric.peBasicExclExtraTTM : null,
    };
  } catch (e) {
    return null;
  }
}

function pctDiff(a, b) {
  if (a == null || b == null || a === 0) return null;
  return Math.abs((a - b) / a) * 100;
}

const CONFLICT_THRESHOLDS = { price: 2, marketCap: 15, pe: 15 };

// ================== Micro-sprint P0.2 (cierre final) ==================
// Modo diagnostico separado (?pin=X&reconcile=true), sin relacion con
// el proposito original de este archivo (benchmark FMP) -- mismo
// patron ya usado en conviction-benchmark-temp.js (varios modos
// independientes en un solo archivo temporal para no exceder el limite
// de 12 funciones serverless de Vercel Hobby).
//
// READ-ONLY. Nunca escribe. Llama DIRECTO a las mismas funciones puras
// de lib/prices.js + lib/reconciliationEngine.js que usan
// api/market-data.js y api/futures-equity.js respectivamente (nunca
// via fetch interno -- Vercel Deployment Protection intercepta con 401
// cualquier request de la funcion hacia si misma en el mismo preview,
// confirmado en vivo) -- CERO reimplementacion de la logica de
// precios/futures, y usa las MISMAS funciones puras de
// lib/financialSnapshot.js que src/App.jsx -- CERO reimplementacion de
// la formula de totales.
const MARKET_DATA_CONCURRENCY = 6; // misma politica que api/market-data.js
const STALE_SNAPSHOT_MS = 24 * 60 * 60 * 1000; // mismo umbral que api/futures-equity.js

// Micro-sprint P0.3: MISMA politica cache-first + circuit breaker que
// api/market-data.js real (via lib/marketDataOrchestrator.js) -- para
// que este endpoint de reconciliacion demuestre fielmente el ahorro
// real de llamadas, no una version distinta que siempre pide todo en
// vivo.
async function computeMarketDataDirect(items) {
  const FINNHUB_KEY = process.env.FINNHUB_API_KEY;
  const now = new Date();
  const tickers = [...new Set(items.map((i) => i.ticker))];
  const { data: cachedRows } = await supabase
    .from("market_cache")
    .select("ticker, ai_price, ai_change_pct, ai_price_updated_at, high, low, market_cap, pe_ratio")
    .in("ticker", tickers);
  const cacheByTicker = {};
  (cachedRows || []).forEach((r) => { cacheByTicker[r.ticker] = r; });

  const data = {};
  const errors = [];
  const results = [];
  // Price Truth POST-review: breakers independientes por proveedor --
  // este endpoint debe reflejar EXACTAMENTE el mismo fix que
  // api/market-data.js (ver ese archivo para el detalle del bug real:
  // un breaker compartido dejaba que un 429 de CoinGecko cortara
  // tambien los tickers de Finnhub del mismo batch).
  const breakers = { finnhub: createRateLimitBreaker(), coingecko: createRateLimitBreaker() };

  await mapWithConcurrency(items, MARKET_DATA_CONCURRENCY, async (item) => {
    const ticker = item.ticker;
    const cachedRow = cacheByTicker[ticker] || null;
    const providerBreaker = item.type === "crypto" ? breakers.coingecko : breakers.finnhub;
    const fetchLive = async () => {
      if (item.type === "stock") return getStockData(supabase, ticker, FINNHUB_KEY);
      if (item.type === "crypto") {
        const id = item.coingeckoId || COINGECKO_FALLBACK_IDS[ticker];
        if (!id) throw new Error("no_coingecko_id");
        return getCryptoData(supabase, ticker, id);
      }
      throw new Error("unknown_asset_type");
    };
    const result = await resolveTickerPrice({ item, cachedRow, now, breaker: providerBreaker, fetchLive });
    result.provider = item.type === "crypto" ? "coingecko" : "finnhub";
    if (result.status === "LIVE") {
      // 2 bugfixes reales de P0.3 (ver api/market-data.js para el
      // detalle completo): (1) await obligatorio -- fire-and-forget
      // puede quedar cortado a medias en un handler serverless; (2)
      // `type` es NOT NULL en market_cache y Postgres lo exige incluso
      // en la fila candidata de un ON CONFLICT DO UPDATE, aunque el
      // UPDATE nunca lo toque -- confirmado con SQL directo, fallaba
      // SIEMPRE sin este campo.
      const { error: cacheWriteError } = await supabase.from("market_cache").upsert(
        [buildCacheWriteRow(ticker, item.type, result)],
        { onConflict: "ticker" }
      );
      if (cacheWriteError) result.cacheWriteFailed = true;
    }
    // El push va DESPUES del bloque de arriba a proposito -- results[]
    // debe reflejar cacheWriteFailed si aplico (un push antes, con
    // spread, congela una copia y pierde la mutacion posterior).
    //
    // Price Truth POST-review: trace completo por ticker (pedido
    // explicito del usuario para poder diagnosticar casos como
    // ETH/LINK/SOL/USDT sin adivinar) -- cached_row_found/cached_price/
    // cached_age_seconds/normal_ttl_ms/max_stale_age_ms se calculan aqui
    // con los MISMOS valores que resolveTickerPrice ya uso (nunca se
    // reimplementa la decision, solo se expone la evidencia).
    const ttlMsForTrace = computeTtlMs(item.type, now, item.priority || "position");
    results.push({
      ticker, ...result,
      trace: {
        provider: result.provider,
        cached_row_found: !!cachedRow,
        cached_price: cachedRow?.ai_price ?? null,
        cached_age_seconds: cachedRow?.ai_price_updated_at ? Math.round((now.getTime() - new Date(cachedRow.ai_price_updated_at).getTime()) / 1000) : null,
        normal_ttl_ms: ttlMsForTrace,
        max_stale_age_ms: MAX_STALE_AGE_MS,
        breaker_tripped_after_this_ticker: isBreakerTripped(providerBreaker),
        live_attempted: result.live_attempted ?? null,
        live_error: result.live_error ?? null,
        final_price: result.price ?? null,
        final_price_status: result.status,
        final_reason: result.reason ?? null,
      },
    });
    if (result.status === "DATA_UNAVAILABLE") { errors.push(ticker); return; }
    data[ticker] = {
      price: result.price, changePct: result.changePct, high: result.high, low: result.low,
      marketCap: result.marketCap, peRatio: result.peRatio,
      price_status: result.status, price_source: result.source, price_fetched_at: result.fetchedAt,
    };
  });

  const providerHealthDetailed = summarizeProviderHealthDetailed(results, breakers);
  return {
    data, errors, provider_health: providerHealthDetailed.aggregate,
    finnhub_status: providerHealthDetailed.finnhub_status, coingecko_status: providerHealthDetailed.coingecko_status,
    per_ticker: results,
  };
}

async function computeFuturesEquityDirect() {
  const { data: futuresAccounts } = await supabase.from("accounts").select("id, name, account_type, product_type").eq("account_type", "futures");
  const accountIds = (futuresAccounts || []).map((a) => a.id);
  const { data: allSnapshots } = accountIds.length
    ? await supabase.from("account_snapshots").select("id, account_id, observed_at, source_import_id").in("account_id", accountIds)
    : { data: [] };
  const importIds = [...new Set((allSnapshots || []).map((s) => s.source_import_id))];
  const { data: confirmedImports } = importIds.length
    ? await supabase.from("smart_imports").select("id, status").in("id", importIds)
    : { data: [] };
  const confirmedIdSet = new Set((confirmedImports || []).filter((i) => i.status === "CONFIRMED").map((i) => i.id));

  const warnings = [];
  let totalValueUsd = 0;
  let isComplete = true;
  // Price Truth POST-review (item 2, trace de USDT): este mirror
  // llamaba getCryptoData() DIRECTO, igual que el bug real que ya se
  // corrigio en api/futures-equity.js -- nunca se actualizo este
  // diagnostico para reflejar el mismo fix, asi que su trace hubiera
  // sido enganoso (nunca podia mostrar STALE, solo OK/PRICE_UNAVAILABLE).
  // Ahora reusa EXACTAMENTE la misma resolveTickerPrice + cache +
  // breaker que la app real -- cero formula nueva, valuateAccountEquity
  // sigue siendo la unica formula financiera, sin tocar.
  const futuresBreaker = createRateLimitBreaker();
  const futuresNow = new Date();
  const traceByTicker = {};

  for (const account of futuresAccounts || []) {
    const latest = selectLatestConfirmedSnapshot(allSnapshots, confirmedIdSet, account.id);
    if (!latest) continue;
    const { data: balances } = await supabase
      .from("account_snapshot_balances")
      .select("asset_id, equity_value, available_balance_value, assets(ticker, provider_symbols)")
      .eq("account_snapshot_id", latest.id);

    let accountValueUsd = 0;
    for (const b of balances || []) {
      const ticker = b.assets?.ticker ?? null;
      const equityValue = b.equity_value != null ? Number(b.equity_value) : null;
      let priceUsd = null;
      if (equityValue != null && ticker) {
        const coingeckoId = b.assets?.provider_symbols?.coingecko || COINGECKO_FALLBACK_IDS[ticker];
        if (coingeckoId) {
          const { data: cachedRow } = await supabase
            .from("market_cache")
            .select("ticker, ai_price, ai_change_pct, ai_price_updated_at, high, low, market_cap, pe_ratio")
            .eq("ticker", ticker).maybeSingle();
          const ttlMsForTrace = computeTtlMs("crypto", futuresNow, "position");
          const result = await resolveTickerPrice({
            item: { ticker, type: "crypto", coingeckoId, priority: "position" },
            cachedRow, now: futuresNow, breaker: futuresBreaker,
            fetchLive: () => getCryptoData(supabase, ticker, coingeckoId),
          });
          if (result.status === "LIVE") {
            const { error: cacheWriteError } = await supabase.from("market_cache").upsert(
              [buildCacheWriteRow(ticker, "crypto", result)], { onConflict: "ticker" }
            );
            if (cacheWriteError) result.cacheWriteFailed = true;
          }
          priceUsd = typeof result.price === "number" ? result.price : null;
          traceByTicker[ticker] = {
            provider: "coingecko",
            coingecko_id: coingeckoId,
            cached_row_found: !!cachedRow,
            cached_price: cachedRow?.ai_price ?? null,
            cached_age_seconds: cachedRow?.ai_price_updated_at ? Math.round((futuresNow.getTime() - new Date(cachedRow.ai_price_updated_at).getTime()) / 1000) : null,
            normal_ttl_ms: ttlMsForTrace,
            max_stale_age_ms: MAX_STALE_AGE_MS,
            breaker_tripped_after_this_ticker: isBreakerTripped(futuresBreaker),
            live_attempted: result.live_attempted ?? null,
            live_error: result.live_error ?? null,
            fallback_selected: result.status === "STALE" || result.status === "STALE_RATE_LIMITED" ? "cache_stale" : (result.status === "LIVE" ? "none" : "none_available"),
            final_price: result.price ?? null,
            final_price_status: result.status,
            final_reason: result.reason ?? null,
          };
        } else {
          traceByTicker[ticker] = { provider: "coingecko", coingecko_id: null, final_price: null, final_price_status: "DATA_UNAVAILABLE", final_reason: "no_coingecko_id" };
        }
      }
      const valuation = valuateAccountEquity({ account_id: account.id, asset_id: b.asset_id, equity_value: equityValue, price_usd_per_unit: priceUsd });
      if (valuation.status === "OK") accountValueUsd += valuation.value_usd;
      else { isComplete = false; warnings.push(`${valuation.status}_${ticker ?? b.asset_id}_ACCOUNT_${account.id}`); }
    }

    const ageMs = Date.now() - new Date(latest.observed_at).getTime();
    if (ageMs > STALE_SNAPSHOT_MS) warnings.push(`STALE_SNAPSHOT_ACCOUNT_${account.id}`);
    totalValueUsd += accountValueUsd;
  }

  return { total_value_usd: totalValueUsd, is_complete: isComplete, warnings, trace_by_ticker: traceByTicker };
}

async function runReconciliation(req, res) {
  const financialRefreshId = `p02-recon-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  const [{ data: positions, error: posErr }, { data: cashMovements, error: cmErr }] = await Promise.all([
    supabase.from("positions").select("*"),
    supabase.from("cash_movements").select("*"),
  ]);
  if (posErr) return res.status(500).json({ error: "positions_read_failed", detail: String(posErr.message || posErr) });
  if (cmErr) return res.status(500).json({ error: "cash_movements_read_failed", detail: String(cmErr.message || cmErr) });

  const items = buildMarketDataItems(positions, []); // watchlist vacio a proposito: no afecta ningun total, solo agregaria tickers extra al fetch

  const criticalFetchStartedAt = new Date().toISOString();
  const t0 = Date.now();

  const marketDataCall = (async () => {
    const t = Date.now();
    try {
      const json = await computeMarketDataDirect(items);
      return { ok: true, status: 200, json, duration_ms: Date.now() - t };
    } catch (e) {
      return { ok: false, status: null, json: null, duration_ms: Date.now() - t, error: String(e.message || e) };
    }
  })();

  const futuresEquityCall = (async () => {
    const t = Date.now();
    try {
      const json = await computeFuturesEquityDirect();
      return { ok: true, status: 200, json, duration_ms: Date.now() - t };
    } catch (e) {
      return { ok: false, status: null, json: null, duration_ms: Date.now() - t, error: String(e.message || e) };
    }
  })();

  const [marketR, futuresR] = await Promise.all([marketDataCall, futuresEquityCall]);
  const criticalFetchCompletedAt = new Date().toISOString();
  const criticalFetchDurationMs = Date.now() - t0;

  const marketData = marketR.ok ? mergeMarketData({}, marketR.json.data || {}) : {};
  const marketErrors = marketR.ok ? (marketR.json.errors || []) : [];
  const futuresEquity = futuresR.ok ? futuresR.json : { total_value_usd: 0, is_complete: false, accounts: [], positions: [], warnings: ["futures_equity_call_failed", futuresR.error].filter(Boolean) };

  // ================== GRUPO CRITICO: commit unico (mismo principio que loadAll()) ==================
  const enriched = enrichPositions(positions, marketData, {});
  const unclassified = unclassifiedPositions(positions);
  const cashValue = computeCashValue(cashMovements);
  const stocksValue = computeStocksValue(enriched);
  const cryptoValue = computeCryptoValue(enriched);
  const patrimonioBase = computePatrimonioBase(enriched, cashValue);
  const futuresEquityUsd = futuresEquity.total_value_usd || 0;
  const patrimonioTotal = computePatrimonio(patrimonioBase, futuresEquityUsd);
  const invested = computeInvested(enriched, cashValue);
  const pnlTotal = computeTotalGain(patrimonioTotal, invested);

  const financialCommitAt = new Date().toISOString();

  const breakdownRow = (p) => ({
    ticker: p.ticker,
    shares: Number(p.shares),
    price_used: p.market?.price ?? null,
    price_status: p.value == null ? "MISSING" : (p.market?.price_status || "LIVE"),
    price_source: p.market?.price_source ?? null,
    price_fetched_at: p.market?.price_fetched_at ?? null,
    market_value: p.value,
  });
  const stockBreakdown = enriched.filter((p) => p.type === "stock").map(breakdownRow)
    .sort((a, b) => (b.market_value ?? -1) - (a.market_value ?? -1));
  // Price Truth POST-review: item explicito del usuario -- traza tambien
  // los tickers cripto (antes solo stock_breakdown existia, LINK/SOL/ETH
  // eran invisibles en esta respuesta salvo dentro de crypto_value agregado).
  const cryptoBreakdown = enriched.filter((p) => p.type === "crypto").map(breakdownRow)
    .sort((a, b) => (b.market_value ?? -1) - (a.market_value ?? -1));

  const missingStocks = enriched.filter((p) => p.type === "stock" && p.value == null).map((p) => p.ticker);

  // Micro-sprint P0.3: evidencia real de cache-hit-ratio/llamadas vivas
  // ahorradas -- ver items 8/9 del reporte final.
  const perTicker = marketR.ok ? (marketR.json.per_ticker || []) : [];
  const priceCacheStats = {
    live_calls: perTicker.filter((r) => r.status === "LIVE").length,
    cache_hits: perTicker.filter((r) => r.status === "CACHED").length,
    stale_served: perTicker.filter((r) => r.status === "STALE" || r.status === "STALE_RATE_LIMITED").length,
    data_unavailable: perTicker.filter((r) => r.status === "DATA_UNAVAILABLE").length,
    total_requested: perTicker.length,
    provider_health: marketR.ok ? (marketR.json.provider_health || null) : null,
    // Price Truth POST-review: estos dos campos existian en
    // computeMarketDataDirect() desde 646adb7 pero nunca se habian
    // conectado a la respuesta HTTP real -- el bug de diseño (breaker
    // por proveedor) SI estaba corregido y corriendo, solo faltaba
    // exponer la evidencia.
    finnhub_status: marketR.ok ? (marketR.json.finnhub_status || null) : null,
    coingecko_status: marketR.ok ? (marketR.json.coingecko_status || null) : null,
    cache_write_failures: perTicker.filter((r) => r.cacheWriteFailed).length,
  };
  // Trace completo por ticker (item explicito del usuario, ver
  // lib/marketDataOrchestrator.js) -- mismo `trace` que cada item de
  // per_ticker ya trae, indexado por ticker para consulta directa.
  const traceByTicker = {};
  perTicker.forEach((r) => { if (r.trace) traceByTicker[r.ticker] = r.trace; });

  return res.status(200).json({
    ok: true,
    computed_at: financialCommitAt,
    financial_refresh_id: financialRefreshId,
    critical_fetch_started_at: criticalFetchStartedAt,
    critical_fetch_completed_at: criticalFetchCompletedAt,
    financial_commit_at: financialCommitAt,
    performance: {
      market_data_duration_ms: marketR.duration_ms,
      futures_equity_duration_ms: futuresR.duration_ms,
      critical_financial_refresh_duration_ms: criticalFetchDurationMs,
      note: "time_to_first_valid_financial_view / time_to_coherent_refresh son metricas de percepcion del navegador -- no medibles desde un endpoint stateless server-side; estas son las duraciones reales del lado servidor que las determinan.",
    },
    price_cache_stats: priceCacheStats,
    stocks_value: Math.round(stocksValue * 100) / 100,
    crypto_value: Math.round(cryptoValue * 100) / 100,
    cash_value: Math.round(cashValue * 100) / 100,
    patrimonio_base: Math.round(patrimonioBase * 100) / 100,
    futures_equity: Math.round(futuresEquityUsd * 100) / 100,
    patrimonio_total: Math.round(patrimonioTotal * 100) / 100,
    invested_total: Math.round(invested * 100) / 100,
    pnl_total: Math.round(pnlTotal * 100) / 100,
    source_statuses: {
      positions_count: positions.length,
      cash_movements_count: cashMovements.length,
      market_data: { ok: marketR.ok, http_status: marketR.status, errors: marketErrors },
      futures_equity: { ok: futuresR.ok, http_status: futuresR.status, is_complete: futuresEquity.is_complete, warnings: futuresEquity.warnings || [] },
      unclassified_positions: unclassified.map((p) => ({ id: p.id, ticker: p.ticker, type: p.type })),
      missing_price_stocks: missingStocks,
    },
    stock_breakdown: stockBreakdown,
    crypto_breakdown: cryptoBreakdown,
    trace_by_ticker: traceByTicker,
    futures_trace_by_ticker: futuresEquity.trace_by_ticker || {},
  });
}

// Price Truth POST-review, item "WARM-UP": modo READ-ONLY, CERO llamada
// a Finnhub/CoinGecko -- solo reporta, por ticker, el estado actual de
// cache y que accion haria un warm-up real. Pedido explicitamente por
// el usuario ANTES de ejecutar nada en vivo ("dry-run primero").
// Universo: el mismo que usa el dashboard real (positions+watchlist,
// via buildMarketDataItems) MAS los assets que Futures necesita y que
// buildMarketDataItems nunca incluye (USDT hoy) -- se reportan por
// separado para no mezclar los dos universos (item explicito del
// usuario).
async function runWarmupDryRun(req, res) {
  const [{ data: positions }, { data: watchlist }] = await Promise.all([
    supabase.from("positions").select("*"),
    supabase.from("watchlist").select("*"),
  ]);
  const dashboardItems = buildMarketDataItems(positions || [], watchlist || []);

  // USDT: necesario para valuar USD-M, nunca aparece en positions/watchlist.
  const futuresOnlyItems = [{ ticker: "USDT", type: "crypto", priority: "position" }];

  const allTickers = [...new Set([...dashboardItems, ...futuresOnlyItems].map((i) => i.ticker))];
  const { data: cachedRows } = await supabase
    .from("market_cache")
    .select("ticker, ai_price, ai_price_updated_at")
    .in("ticker", allTickers);
  const cacheByTicker = {};
  (cachedRows || []).forEach((r) => { cacheByTicker[r.ticker] = r; });
  const now = new Date();

  function planFor(item) {
    const row = cacheByTicker[item.ticker] || null;
    const hasLkg = !!row && row.ai_price != null;
    const provider = item.type === "crypto" ? "coingecko" : "finnhub";
    const currentCacheState = !row
      ? "NEVER_CACHED"
      : hasLkg
        ? `LKG_PRESENT (age_seconds=${Math.round((now.getTime() - new Date(row.ai_price_updated_at).getTime()) / 1000)})`
        : "ROW_EXISTS_NO_PRICE";
    // Plan: solo se propone refrescar tickers SIN LKG hoy -- warm-up no
    // es para "refrescar todo", es para cerrar el gap real (20 tickers
    // sin LKG jamas, ver auditoria de cache coverage). Un ticker que YA
    // tiene LKG se deja en paz (se refresca solo via el poll normal).
    const plannedAction = hasLkg ? "SKIP_ALREADY_HAS_LKG" : "FETCH_LIVE_AND_CACHE";
    return { ticker: item.ticker, type: item.type, provider, current_cache_state: currentCacheState, planned_action: plannedAction };
  }

  const dashboardPlan = dashboardItems.map(planFor);
  const futuresPlan = futuresOnlyItems.map(planFor);

  res.status(200).json({
    ok: true,
    mode: "DRY_RUN",
    note: "CERO llamadas a Finnhub/CoinGecko en este modo -- solo lectura de market_cache. Ejecutar el warm-up real es un paso separado, no automatico.",
    dashboard_universe: { total: dashboardPlan.length, to_fetch: dashboardPlan.filter((p) => p.planned_action === "FETCH_LIVE_AND_CACHE").length, plan: dashboardPlan },
    futures_only_universe: { total: futuresPlan.length, to_fetch: futuresPlan.filter((p) => p.planned_action === "FETCH_LIVE_AND_CACHE").length, plan: futuresPlan },
  });
}

// Price Truth POST-review, item "RESIDUAL WATCHLIST WARM-UP": modo LIVE,
// autorizado EXPLICITAMENTE por el usuario para exactamente estos 8
// tickers watchlist-only sin LKG jamas -- nunca posiciones, nunca USDT,
// nunca crypto, nunca un ticker que ya tenga LKG (se verifica en vivo
// contra market_cache, no se asume la lista del dry-run anterior).
// Lista hardcodeada a proposito (no derivada de watchlist/positions) --
// es la unica forma de garantizar que este modo JAMAS toque un ticker
// fuera de lo autorizado, sin importar que cambie el watchlist real.
const WARMUP_LIVE_ALLOWED_TICKERS = ["ASML.AS", "CEG", "CRCL", "LWLG", "NOC", "SERV", "SNDK", "TE"];
const WARMUP_LIVE_SPACING_MS = 2000; // ~1 llamada cada ~2s, requisito explicito del usuario

async function runWarmupLive(req, res) {
  const FINNHUB_KEY = process.env.FINNHUB_API_KEY;
  // Breaker propio de esta corrida -- si Finnhub responde 429 en
  // cualquier ticker, se detiene el resto INMEDIATAMENTE (sin retry
  // agresivo): resolveTickerPrice ya no intenta en vivo una vez que el
  // breaker esta tripped, y aqui ademas se marca el resto como SKIPPED
  // explicito en vez de dejarlos pasar por otro intento fallido.
  const breaker = createRateLimitBreaker();
  const results = [];
  let stoppedEarly = false;

  // Se lee el estado REAL de market_cache para estos 8 tickers antes de
  // tocar nada -- nunca se asume que un ticker sigue sin LKG solo porque
  // el dry-run anterior lo reporto asi.
  const { data: cachedRows } = await supabase
    .from("market_cache")
    .select("ticker, ai_price, ai_price_updated_at")
    .in("ticker", WARMUP_LIVE_ALLOWED_TICKERS);
  const cacheByTicker = {};
  (cachedRows || []).forEach((r) => { cacheByTicker[r.ticker] = r; });

  for (let i = 0; i < WARMUP_LIVE_ALLOWED_TICKERS.length; i++) {
    const ticker = WARMUP_LIVE_ALLOWED_TICKERS[i];
    const cachedRow = cacheByTicker[ticker] || null;
    const hasLkg = !!cachedRow && cachedRow.ai_price != null;

    if (hasLkg) {
      results.push({ ticker, provider: "finnhub", result: "SKIPPED", reason: "already_has_lkg", price: cachedRow.ai_price, cached_at: cachedRow.ai_price_updated_at, market_cache_verified: true });
      continue;
    }

    if (stoppedEarly) {
      results.push({ ticker, provider: "finnhub", result: "SKIPPED", reason: "stopped_after_429_rate_limited", price: null, cached_at: null, market_cache_verified: false });
      continue;
    }

    const now = new Date();
    const result = await resolveTickerPrice({
      item: { ticker, type: "stock", priority: "position" },
      cachedRow: null, now, breaker,
      fetchLive: () => getStockData(supabase, ticker, FINNHUB_KEY),
    });

    if (result.status === "LIVE") {
      // Nunca sobreescribe con NULL: solo se llega aqui si getStockData
      // devolvio un numero > 0 (getStockData ya lanza "no_quote" si no).
      const { error: cacheWriteError } = await supabase.from("market_cache").upsert(
        [buildCacheWriteRow(ticker, "stock", result)], { onConflict: "ticker" }
      );
      let verifyRow = null;
      if (!cacheWriteError) {
        const { data } = await supabase.from("market_cache").select("ticker, ai_price, ai_price_updated_at").eq("ticker", ticker).maybeSingle();
        verifyRow = data;
      }
      const verified = !cacheWriteError && !!verifyRow && verifyRow.ai_price === result.price;
      results.push({
        ticker, provider: "finnhub",
        result: cacheWriteError ? "FAILED" : "SUCCESS",
        reason: cacheWriteError ? `cache_write_failed: ${cacheWriteError.message}` : null,
        price: result.price, cached_at: verifyRow?.ai_price_updated_at ?? null,
        market_cache_verified: verified,
      });
    } else {
      // Sin LKG previo + live fallo -> DATA_UNAVAILABLE, CERO escritura
      // (nada que sobreescribir, no existia precio valido antes). Caso
      // ASML.AS explicito del usuario: si Finnhub devuelve "no_quote"
      // (simbolo invalido/no soportado), se reporta el error exacto tal
      // cual, SIN improvisar otro simbolo.
      results.push({ ticker, provider: "finnhub", result: "FAILED", reason: result.live_error || result.reason || "unknown", price: null, cached_at: null, market_cache_verified: false });
    }

    if (isBreakerTripped(breaker)) stoppedEarly = true;

    if (i < WARMUP_LIVE_ALLOWED_TICKERS.length - 1 && !stoppedEarly) {
      await sleep(WARMUP_LIVE_SPACING_MS);
    }
  }

  res.status(200).json({
    ok: true,
    mode: "LIVE_WARMUP",
    allowed_tickers: WARMUP_LIVE_ALLOWED_TICKERS,
    stopped_early: stoppedEarly,
    results,
  });
}

// ================== Historical Multiple Data Review, PRIORITY 2 ==================
// Modo diagnostico separado (?pin=X&mode=historical_probe), read-only,
// temporal -- NO relacionado con el proposito original de este archivo
// (benchmark FMP con escritura a fmp_benchmark_results). Reutiliza
// FMP_BASE/looksLikePlanBlockedMessage/sleep ya existentes en este mismo
// archivo -- cero reimplementacion. Usa el credential FMP_API_KEY que ya
// esta confirmado funcionando en Vercel (nunca se agrego como secret de
// GitHub Actions a proposito -- decision explicita del usuario de
// reusar el path Vercel en vez de duplicar el secret). NUNCA escribe en
// Supabase, NUNCA expone la API key, NUNCA toca el ruteo de precios de
// produccion (lib/prices.js / lib/marketDataOrchestrator.js / etc. no
// se importan ni se tocan aqui).
//
// Universo: los 11 tickers EPS-eligible con historia STRONG/MINIMUM
// confirmados por el audit de canonicalizacion de este mismo sprint
// (scripts/secAnnualCanonicalizationAudit.mjs) -- BE/NBIS (sin historia
// usable) y ALAB/GEV (WEAK, historia insuficiente) quedan fuera.
const FMP_HISTORICAL_ELIGIBLE_TICKERS = [
  "AMD", "AMZN", "ANET", "GOOG", "GOOGL", "META", "MSFT",
  "NVDA", "ORCL", "QCOM", "VRT",
];

// Fechas de split REALES conocidas (evidencia externa, no derivadas del
// salto de EPS -- usadas solo para localizar la ventana de registros a
// inspeccionar; la clasificacion RAW/SPLIT_ADJUSTED se decide con los
// precios reales alrededor de esa fecha, nunca asumida).
const KNOWN_SPLIT_DATES = {
  NVDA: "2024-06-07",   // 10-for-1
  AMZN: "2022-06-06",   // 20-for-1
  GOOG: "2022-07-18",   // 20-for-1
  GOOGL: "2022-07-18",  // 20-for-1
};

async function probeHistoricalPriceTicker(FMP_KEY, ticker) {
  const url = `${FMP_BASE}/historical-price-eod/full?symbol=${ticker}&apikey=${FMP_KEY}`;
  let resp;
  try {
    resp = await fetch(url);
  } catch (e) {
    return { ticker, classification: "PROVIDER_ERROR", detail: `network_error: ${String(e.message || e)}` };
  }

  if (resp.status === 401 || resp.status === 403) {
    return { ticker, classification: "AUTH_ERROR", http_status: resp.status };
  }
  if (resp.status === 402) {
    return { ticker, classification: "PLAN_BLOCKED", http_status: resp.status };
  }
  if (!resp.ok) {
    const bodyText = await resp.text();
    if (looksLikePlanBlockedMessage(bodyText)) {
      return { ticker, classification: "PLAN_BLOCKED", http_status: resp.status, body_snippet: bodyText.slice(0, 300) };
    }
    return { ticker, classification: "PROVIDER_ERROR", http_status: resp.status, body_snippet: bodyText.slice(0, 300) };
  }

  let data;
  try {
    data = await resp.json();
  } catch (e) {
    return { ticker, classification: "PROVIDER_ERROR", detail: `json_parse_error: ${String(e.message || e)}` };
  }

  // BUGFIX (Historical Multiple Data Review): la forma real de la
  // respuesta de FMP para /historical-price-eod/full puede ser un
  // ARRAY de nivel superior directamente (confirmado en vivo para
  // NVDA/AMZN) -- asumir siempre `{ historical: [...] }` clasificaba
  // erroneamente NO_DATA para un ticker con ~1255 registros reales.
  // normalizeFmpHistoricalResponse nunca adivina una forma no
  // reconocida en silencio -- ver lib/fmpHistoricalNormalizer.js.
  const { shape: detectedResponseShape, records } = normalizeFmpHistoricalResponse(data);
  if (records.length === 0) {
    return {
      ticker,
      classification: "NO_DATA",
      http_status: resp.status,
      detected_response_shape: detectedResponseShape,
      top_level_keys: data && typeof data === "object" ? Object.keys(data).slice(0, 20) : [],
    };
  }

  // Se ordena explicitamente por fecha -- nunca se asume el orden que
  // FMP devuelve sin verificarlo.
  const sorted = [...records].sort((a, b) => (a.date < b.date ? 1 : -1));
  const latest = sorted[0];
  const earliest = sorted[sorted.length - 1];
  const fieldsPresent = Object.keys(latest);

  const knownSplitDate = KNOWN_SPLIT_DATES[ticker] || null;
  const splitWindowEvidence = knownSplitDate ? findRecordsAroundDate(records, knownSplitDate, 3) : null;

  return {
    ticker,
    classification: "AVAILABLE",
    http_status: resp.status,
    detected_response_shape: detectedResponseShape,
    provider_symbol: ticker,
    record_count: records.length,
    earliest_date: earliest.date,
    latest_date: latest.date,
    fields_present_in_sample: fieldsPresent,
    sample_record_latest: latest,
    sample_record_earliest: earliest,
    close_field_value: latest.close ?? null,
    adjclose_like_field_value: latest.adjClose ?? latest.adjustedClose ?? latest.adjustedClosePrice ?? null,
    volume_field_value: latest.volume ?? null,
    split_related_fields: Object.fromEntries(fieldsPresent.filter((k) => /split/i.test(k)).map((k) => [k, latest[k]])),
    dividend_related_fields: Object.fromEntries(fieldsPresent.filter((k) => /div/i.test(k)).map((k) => [k, latest[k]])),
    exchange_field_value: latest.exchange ?? (Array.isArray(data) ? null : data.exchange) ?? null,
    currency_field_value: latest.currency ?? (Array.isArray(data) ? null : data.currency) ?? null,
    known_split_date: knownSplitDate,
    split_window_evidence: splitWindowEvidence,
  };
}

// Sprint P2A style split-evidence helper: busca, dentro de los records
// ya normalizados y ordenados por fecha, la ventana alrededor de una
// fecha de split conocida -- evidencia real, nunca inferida del nombre
// de un campo. Devuelve hasta N registros antes y despues de esa fecha.
function findRecordsAroundDate(records, targetDate, windowSize = 3) {
  const sorted = [...records].sort((a, b) => (a.date < b.date ? -1 : 1)); // ascendente
  const idx = sorted.findIndex((r) => r.date >= targetDate);
  if (idx === -1) return { found: false, before: [], after: [] };
  const before = sorted.slice(Math.max(0, idx - windowSize), idx);
  const after = sorted.slice(idx, idx + windowSize);
  return { found: true, before, after };
}

async function runHistoricalPriceProbe(req, res) {
  const FMP_KEY = process.env.FMP_API_KEY;
  if (!FMP_KEY) {
    return res.status(500).json({ error: "missing_fmp_key_in_vercel_env" });
  }
  const { tickers: tickersOverride } = req.query || {};
  const tickerList = tickersOverride
    ? tickersOverride.split(",").map((t) => t.trim().toUpperCase()).filter(Boolean)
    : FMP_HISTORICAL_ELIGIBLE_TICKERS;

  const results = [];
  for (const ticker of tickerList) {
    const r = await probeHistoricalPriceTicker(FMP_KEY, ticker);
    results.push(r);
    await sleep(REQUEST_DELAY_MS);
  }

  const summary = {
    total_tested: results.length,
    available: results.filter((r) => r.classification === "AVAILABLE").map((r) => r.ticker),
    plan_blocked: results.filter((r) => r.classification === "PLAN_BLOCKED").map((r) => r.ticker),
    auth_error: results.filter((r) => r.classification === "AUTH_ERROR").map((r) => r.ticker),
    no_data: results.filter((r) => r.classification === "NO_DATA").map((r) => r.ticker),
    provider_error: results.filter((r) => r.classification === "PROVIDER_ERROR").map((r) => r.ticker),
  };

  return res.status(200).json({ ok: true, mode: "HISTORICAL_PRICE_PROBE", tickers: tickerList, summary, results });
}

export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  const { pin, tickers, cryptoTickers, reconcile, warmup, mode } = req.query || {};

  if (!pin || pin !== process.env.MONI_PIN) {
    return res.status(401).json({ error: "invalid_pin" });
  }

  if (mode === "historical_probe") {
    return runHistoricalPriceProbe(req, res);
  }

  if (reconcile === "true") {
    return runReconciliation(req, res);
  }

  if (warmup === "dryrun") {
    return runWarmupDryRun(req, res);
  }

  if (warmup === "live") {
    return runWarmupLive(req, res);
  }

  if (!tickers && !cryptoTickers) {
    return res.status(400).json({ error: "missing_params", detail: "usa ?tickers=MSFT,AMZN,...&cryptoTickers=BTCUSD,ETHUSD,..." });
  }

  const FMP_KEY = process.env.FMP_API_KEY;
  if (!FMP_KEY) {
    return res.status(500).json({ error: "missing_fmp_key_in_vercel_env" });
  }

  const stockList = tickers ? tickers.split(",").map((t) => t.trim()).filter(Boolean) : [];
  const cryptoList = cryptoTickers ? cryptoTickers.split(",").map((t) => t.trim()).filter(Boolean) : [];
  const summary = [];

  for (const ticker of stockList) {
    const result = await runOneTicker(FMP_KEY, ticker, "stock");
    summary.push(result);
  }
  for (const ticker of cryptoList) {
    const result = await runOneTicker(FMP_KEY, ticker, "crypto");
    summary.push(result);
  }

  return res.status(200).json({ ok: true, processed: summary.length, summary });
}

async function runOneTicker(FMP_KEY, ticker, assetType) {
  const endpoints = assetType === "stock" ? STOCK_ENDPOINTS : CRYPTO_ENDPOINTS;
  const rows = [];

  for (const endpointDef of endpoints) {
    const result = await testEndpoint(FMP_KEY, ticker, assetType, endpointDef);
    for (const dataType of endpointDef.dataTypes) {
      rows.push({
        ticker,
        asset_type: assetType,
        data_type: dataType,
        endpoint_name: endpointDef.name,
        endpoint_ref: `${endpointDef.name}?symbol=${ticker}`,
        http_status: result.httpStatus,
        classification: result.classification,
        record_count: result.recordCount,
        latest_available_date: result.latestDate,
        latency_ms: result.latencyMs,
        provider: "fmp",
        note: result.note,
      });
    }
    await sleep(REQUEST_DELAY_MS);
  }

  const { error: insertErr } = await supabase.from("fmp_benchmark_results").insert(rows);
  if (insertErr) {
    return { ticker, asset_type: assetType, ok: false, error: insertErr.message };
  }

  let conflictCount = 0;
  if (assetType === "stock") {
    const quoteRow = rows.find((r) => r.endpoint_name === "quote");
    if (quoteRow && quoteRow.classification === "AVAILABLE") {
      const fh = await crossCheckFinnhub(ticker);
      if (fh) {
        const fmpResp = await fetch(`${FMP_BASE}/quote?symbol=${ticker}&apikey=${FMP_KEY}`);
        const fmpData = await fmpResp.json();
        const fmpQuote = Array.isArray(fmpData) ? fmpData[0] : fmpData;

        const diffs = [
          { field: "price", fmp: fmpQuote?.price ?? null, finnhub: fh.price, threshold: CONFLICT_THRESHOLDS.price },
          { field: "marketCap", fmp: fmpQuote?.marketCap ?? null, finnhub: fh.marketCap, threshold: CONFLICT_THRESHOLDS.marketCap },
          { field: "pe", fmp: fmpQuote?.pe ?? null, finnhub: fh.pe, threshold: CONFLICT_THRESHOLDS.pe },
        ];

        const conflictRows = [];
        for (const d of diffs) {
          const diffPct = pctDiff(d.fmp, d.finnhub);
          if (diffPct != null && diffPct > d.threshold) {
            conflictRows.push({
              ticker,
              field: d.field,
              fmp_value: d.fmp,
              finnhub_value: d.finnhub,
              diff_pct: Math.round(diffPct * 10) / 10,
              threshold_pct: d.threshold,
            });
          }
        }
        if (conflictRows.length > 0) {
          await supabase.from("fmp_benchmark_conflicts").insert(conflictRows);
          conflictCount = conflictRows.length;
        }
      }
    }
  }

  return { ticker, asset_type: assetType, ok: true, rows_inserted: rows.length, conflicts_found: conflictCount };
}
