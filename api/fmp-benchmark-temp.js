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
// Micro-sprint P0.2 (Financial Totals Correctness + Stability), cierre
// final. Reutiliza la formula canonica unica -- CERO reimplementacion.
import {
  buildMarketDataItems, mergeMarketData, enrichPositions, computeCashValue,
  computeStocksValue, computeCryptoValue, computePatrimonioBase, computePatrimonio,
  computeInvested, computeTotalGain, unclassifiedPositions,
} from "../lib/financialSnapshot.js";

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
// READ-ONLY. Nunca escribe. Llama a los MISMOS endpoints internos que
// usa la app real (/api/market-data, /api/futures-equity) via fetch
// interno -- CERO reimplementacion de la logica de precios/futures, y
// usa las MISMAS funciones puras de lib/financialSnapshot.js que
// src/App.jsx -- CERO reimplementacion de la formula de totales.
async function runReconciliation(req, res) {
  const financialRefreshId = `p02-recon-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const proto = req.headers["x-forwarded-proto"] || "https";
  const base = `${proto}://${req.headers.host}`;

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
      const r = await fetch(`${base}/api/market-data`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ items }),
      });
      const json = await r.json();
      return { ok: r.ok, status: r.status, json, duration_ms: Date.now() - t };
    } catch (e) {
      return { ok: false, status: null, json: null, duration_ms: Date.now() - t, error: String(e.message || e) };
    }
  })();

  const futuresEquityCall = (async () => {
    const t = Date.now();
    try {
      const r = await fetch(`${base}/api/futures-equity`);
      const json = await r.json();
      return { ok: r.ok, status: r.status, json, duration_ms: Date.now() - t };
    } catch (e) {
      return { ok: false, status: null, json: null, duration_ms: Date.now() - t, error: String(e.message || e) };
    }
  })();

  const [marketR, futuresR] = await Promise.all([marketDataCall, futuresEquityCall]);
  const criticalFetchCompletedAt = new Date().toISOString();
  const criticalFetchDurationMs = Date.now() - t0;

  const marketData = marketR.ok ? mergeMarketData({}, marketR.json.data || {}) : {};
  const marketErrors = marketR.ok ? (marketR.json.errors || []) : [];
  const futuresEquity = futuresR.ok ? futuresR.json : { total_value_usd: 0, is_complete: false, accounts: [], positions: [], warnings: ["futures_equity_call_failed"] };

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

  const stockBreakdown = enriched
    .filter((p) => p.type === "stock")
    .map((p) => ({
      ticker: p.ticker,
      shares: Number(p.shares),
      price_used: p.market?.price ?? null,
      price_status: p.value == null ? "MISSING" : (marketErrors.includes(p.ticker) ? "LAST_KNOWN_GOOD" : "LIVE"),
      market_value: p.value,
    }))
    .sort((a, b) => (b.market_value ?? -1) - (a.market_value ?? -1));

  const missingStocks = enriched.filter((p) => p.type === "stock" && p.value == null).map((p) => p.ticker);

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
  });
}

export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  const { pin, tickers, cryptoTickers, reconcile } = req.query || {};

  if (!pin || pin !== process.env.MONI_PIN) {
    return res.status(401).json({ error: "invalid_pin" });
  }

  if (reconcile === "true") {
    return runReconciliation(req, res);
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
