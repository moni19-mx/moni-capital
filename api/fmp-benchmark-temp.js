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

export default async function handler(req, res) {
  const { pin, ticker, assetType } = req.query || {};

  if (!pin || pin !== process.env.MONI_PIN) {
    return res.status(401).json({ error: "invalid_pin" });
  }
  if (!ticker || !assetType || !["stock", "crypto"].includes(assetType)) {
    return res.status(400).json({ error: "missing_or_invalid_params", detail: "usa ?ticker=X&assetType=stock|crypto" });
  }

  const FMP_KEY = process.env.FMP_API_KEY;
  if (!FMP_KEY) {
    return res.status(500).json({ error: "missing_fmp_key_in_vercel_env" });
  }

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
    return res.status(500).json({ error: "supabase_insert_failed", detail: insertErr.message });
  }

  // Cross-check con Finnhub solo para stocks (Finnhub no cubre nuestros
  // simbolos crypto con FMP-style BTCUSD).
  let conflictCount = 0;
  if (assetType === "stock") {
    const quoteRow = rows.find((r) => r.endpoint_name === "quote");
    if (quoteRow && quoteRow.classification === "AVAILABLE") {
      const fh = await crossCheckFinnhub(ticker);
      if (fh) {
        // Necesitamos el valor real de FMP, no solo su clasificacion --
        // hacemos una segunda lectura ligera del quote ya confirmado.
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

  return res.status(200).json({
    ok: true,
    ticker,
    asset_type: assetType,
    rows_inserted: rows.length,
    conflicts_found: conflictCount,
  });
}
