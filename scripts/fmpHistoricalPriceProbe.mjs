#!/usr/bin/env node
// scripts/fmpHistoricalPriceProbe.mjs
//
// PRIORITY 2, paso 3: auditoria REAL de cobertura de precios historicos
// en FMP, SOLO LECTURA, temporal. Corre SOLO si el paso previo
// (fmpAuthTest.mjs) confirmo que la key autentica (no 401/403) --
// nunca se corre a ciegas. Universo: los tickers EPS-eligible reales
// (ELIGIBLE_HIGH_CONFIDENCE) del re-audit de SEC EPS post-fix -- no se
// prueba BE ni NBIS aqui porque ninguno califica como denominador
// utilizable.
//
// NUNCA infiere semantica de ajuste (split/dividendo) solo por el
// nombre de un campo -- reporta los campos crudos tal cual vienen,
// para que la decision de que representan se tome con evidencia
// separada (documentacion FMP + inspeccion real), no por adivinanza.
//
// NUNCA escribe en Supabase.

import { writeFileSync } from "node:fs";

const FMP_KEY = process.env.FMP_API_KEY;
const FMP_BASE = "https://financialmodelingprep.com/stable";
const REQUEST_DELAY_MS = 200;

// Universo EPS-eligible real, post-fix (ver sec-eps-coverage-probe.json
// de esta misma corrida de trabajo) -- BE y NBIS excluidos
// explicitamente (STALE_OR_LOW_CONFIDENCE / UNAVAILABLE).
const TICKERS = [
  "ALAB", "AMD", "AMZN", "ANET", "GEV", "GOOG", "GOOGL",
  "META", "MSFT", "NVDA", "ORCL", "QCOM", "VRT",
];

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

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

async function probeTicker(ticker) {
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

  const records = data?.historical;
  if (!Array.isArray(records) || records.length === 0) {
    return { ticker, classification: "NO_DATA", http_status: resp.status, raw_shape: Array.isArray(data) ? "array" : typeof data, top_level_keys: data && typeof data === "object" ? Object.keys(data) : [] };
  }

  // records vienen mas reciente primero segun el contrato FMP conocido
  // (ver docs/intelligence/P3.1A.1) -- se verifica con evidencia, no se
  // asume: se ordena explicitamente por fecha para confirmar.
  const sorted = [...records].sort((a, b) => (a.date < b.date ? 1 : -1));
  const latest = sorted[0];
  const earliest = sorted[sorted.length - 1];
  const sampleRecord = latest; // registro real completo, sin editar

  // Solo se reportan los campos crudos presentes -- nunca se asume que
  // "adjClose" o "unadjustedVolume" significan lo que su nombre sugiere
  // sin evidencia de documentacion/comportamiento real.
  const fieldsPresent = Object.keys(sampleRecord);

  return {
    ticker,
    classification: "AVAILABLE",
    http_status: resp.status,
    provider_symbol: ticker,
    record_count: records.length,
    earliest_date: earliest.date,
    latest_date: latest.date,
    fields_present_in_sample: fieldsPresent,
    sample_record_latest: sampleRecord,
    sample_record_earliest: earliest,
    close_field_value: sampleRecord.close ?? null,
    adjclose_like_field_value: sampleRecord.adjClose ?? sampleRecord.adjustedClose ?? sampleRecord.adjustedClosePrice ?? null,
    volume_field_value: sampleRecord.volume ?? null,
    split_related_fields: Object.fromEntries(fieldsPresent.filter((k) => /split/i.test(k)).map((k) => [k, sampleRecord[k]])),
    dividend_related_fields: Object.fromEntries(fieldsPresent.filter((k) => /div/i.test(k)).map((k) => [k, sampleRecord[k]])),
    exchange_field_value: sampleRecord.exchange ?? data.exchange ?? null,
    currency_field_value: sampleRecord.currency ?? data.currency ?? null,
    top_level_keys: Object.keys(data),
  };
}

async function main() {
  console.log(`[fmp-historical-probe] started_at=${new Date().toISOString()} tickers=${JSON.stringify(TICKERS)}`);
  const results = [];
  for (const ticker of TICKERS) {
    const r = await probeTicker(ticker);
    results.push(r);
    if (r.classification === "AVAILABLE") {
      console.log(`[fmp-historical-probe] ${ticker}: AVAILABLE records=${r.record_count} range=${r.earliest_date}..${r.latest_date} fields=${JSON.stringify(r.fields_present_in_sample)}`);
      console.log(`[fmp-historical-probe] ${ticker}: sample_record_latest=${JSON.stringify(r.sample_record_latest)}`);
    } else {
      console.log(`[fmp-historical-probe] ${ticker}: ${r.classification} ${JSON.stringify({ http_status: r.http_status, detail: r.detail, body_snippet: r.body_snippet })}`);
    }
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

  const report = { started_at: new Date().toISOString(), finished_at: new Date().toISOString(), tickers: TICKERS, results, summary };
  writeFileSync("fmp-historical-price-probe.json", JSON.stringify(report, null, 2));

  console.log("[fmp-historical-probe] === SUMMARY ===");
  console.log(JSON.stringify(summary, null, 2));
  console.log("[fmp-historical-probe] done -- see fmp-historical-price-probe.json artifact. NO Supabase write performed.");
}

main().catch((e) => { console.error("[fatal]", e); process.exit(1); });
