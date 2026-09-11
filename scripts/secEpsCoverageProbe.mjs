#!/usr/bin/env node
// scripts/secEpsCoverageProbe.mjs
//
// Sprint P2A (Valuation Facts Layer) -- AUDITORIA DE COBERTURA REAL,
// SOLO LECTURA, TEMPORAL. Corre en GitHub Actions (egress real). NUNCA
// escribe en Supabase (a diferencia de api/sec-benchmark-temp.js) --
// esto es puramente evidencia, no ingestion. SEC EDGAR no requiere API
// key (publico), asi que este probe no necesita ningun secret.
//
// Reusa exactamente la misma logica pura de
// lib/secFinancialsResolver.js que ya usa (y seguira usando)
// api/sec-benchmark-temp.js -- mismo tag-selection/ambiguity/confidence
// para el concepto anual EPS_DILUTED, mas la capa trimestral/TTM nueva
// de este sprint. Cero logica duplicada/reimplementada.
//
// Universo: los 15 tickers que ya tienen cobertura SEC real confirmada
// para REVENUE/NET_INCOME/etc (ver P2A review) -- no se estima, se
// prueba cada uno con datos reales.

import { writeFileSync } from "node:fs";
import {
  CANDIDATE_TAGS, CONCEPT_UNITS, extractAnnualPoints, scoreCandidate,
  pickWinnerAndDetectAmbiguity, extractQuarterlyPoints, computeTtmEps,
} from "../lib/secFinancialsResolver.js";

const SEC_HEADERS = {
  "User-Agent": "MoniCapital-Diagnostic contacto@moni-capital-diagnostic.local",
};
const REQUEST_DELAY_MS = 120;

const TICKERS = [
  "ALAB", "AMD", "AMZN", "ANET", "BE", "GEV", "GOOG", "GOOGL",
  "META", "MSFT", "NBIS", "NVDA", "ORCL", "QCOM", "VRT",
];

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function getCikMap() {
  const resp = await fetch("https://www.sec.gov/files/company_tickers.json", { headers: SEC_HEADERS });
  if (!resp.ok) throw new Error(`cik_map_fetch_failed_${resp.status}`);
  const data = await resp.json();
  const map = {};
  Object.values(data).forEach((entry) => { map[entry.ticker.toUpperCase()] = String(entry.cik_str).padStart(10, "0"); });
  return map;
}

async function fetchConcept(cikPadded, tag) {
  const url = `https://data.sec.gov/api/xbrl/companyconcept/CIK${cikPadded}/us-gaap/${tag}.json`;
  try {
    const resp = await fetch(url, { headers: SEC_HEADERS });
    if (resp.status === 404) return { notFound: true, status: resp.status };
    if (!resp.ok) return { error: `http_${resp.status}`, status: resp.status };
    const data = await resp.json();
    return { data, status: resp.status };
  } catch (e) {
    return { error: String(e.message || e), status: null };
  }
}

// Sprint P2A revision: clasifica profundidad de historial ANUAL usable
// para una futura distribucion de P/E -- SOLO evidencia, no calcula
// ningun P/E aqui. "Usable" = EPS positivo (un EPS negativo/cero no
// produce un P/E con significado economico, se excluye de la cuenta
// pero NUNCA se borra del historial real).
function classifyHistoryDepth(positiveYearsCount) {
  if (positiveYearsCount >= 5) return "HISTORY_STRONG";
  if (positiveYearsCount === 4) return "HISTORY_MINIMUM";
  if (positiveYearsCount >= 1) return "HISTORY_WEAK";
  return "NO_USABLE_HISTORY";
}

async function auditTicker(ticker, cikPadded) {
  const tags = CANDIDATE_TAGS.EPS_DILUTED;
  const allowedUnits = CONCEPT_UNITS.EPS_DILUTED;
  const annualCandidates = [];
  const quarterlyByTag = {};
  const httpCalls = [];

  for (const tag of tags) {
    const result = await fetchConcept(cikPadded, tag);
    httpCalls.push({ tag, status: result.status, notFound: !!result.notFound, error: result.error || null });
    await sleep(REQUEST_DELAY_MS);
    if (result.data) {
      // BUGFIX (Sprint P2A, caso BE): unidad explicita -- nunca
      // "la primera key del objeto units", ver lib/secFinancialsResolver.js.
      const annualPoints = extractAnnualPoints(result.data, allowedUnits);
      if (annualPoints.length > 0) annualCandidates.push({ tag, points: annualPoints, score: scoreCandidate(annualPoints) });
      quarterlyByTag[tag] = extractQuarterlyPoints(result.data, allowedUnits);
    }
  }

  const annualDecision = pickWinnerAndDetectAmbiguity(annualCandidates, tags);

  let ttmResult = { status: "INSUFFICIENT_DATA", reason: "no_winning_annual_tag_to_source_quarters_from" };
  let quarterlyPointsFound = 0;
  if (annualDecision.status === "OK") {
    const quarters = quarterlyByTag[annualDecision.tag] || [];
    quarterlyPointsFound = quarters.length;
    ttmResult = computeTtmEps(quarters);
  }

  let annualResult;
  if (annualDecision.status === "OK") {
    const points = annualDecision.points; // ya ordenados mas reciente primero
    const positivePoints = points.filter((p) => typeof p.value === "number" && p.value > 0);
    const negativeOrZeroPoints = points.filter((p) => typeof p.value === "number" && p.value <= 0);
    const fiscalYears = points.map((p) => p.fiscal_year).filter((fy) => fy != null);
    annualResult = {
      status: "OK",
      tag: annualDecision.tag,
      confidence: annualDecision.confidence,
      ambiguity_note: annualDecision.ambiguityNote,
      latest_value: points[0]?.value ?? null,
      latest_period_end: points[0]?.period_end ?? null,
      latest_filed_date: points[0]?.filed_date ?? null,
      points_found: points.length,
      fiscal_years: fiscalYears,
      oldest_usable_fiscal_year: fiscalYears.length > 0 ? fiscalYears[fiscalYears.length - 1] : null,
      positive_eps_years: positivePoints.length,
      negative_or_zero_eps_years: negativeOrZeroPoints.length,
      history_depth_classification: classifyHistoryDepth(positivePoints.length),
    };
  } else {
    annualResult = { status: "DATA_UNAVAILABLE", reason: annualDecision.reason, history_depth_classification: "NO_USABLE_HISTORY" };
  }

  return {
    ticker, cik: cikPadded,
    annual: annualResult,
    quarterly_points_found: quarterlyPointsFound,
    ttm: ttmResult.status === "OK"
      ? { status: "OK", ttm_eps: ttmResult.ttm_eps, is_positive: ttmResult.is_positive, quarters_used: ttmResult.quarters_used }
      : { status: "INSUFFICIENT_DATA", reason: ttmResult.reason },
    http_calls: httpCalls,
  };
}

async function main() {
  console.log(`[sec-eps-probe] started_at=${new Date().toISOString()} tickers=${JSON.stringify(TICKERS)}`);
  const cikMap = await getCikMap();

  const results = [];
  for (const ticker of TICKERS) {
    const cikPadded = cikMap[ticker];
    if (!cikPadded) {
      console.log(`[sec-eps-probe] ${ticker}: cik_not_found`);
      results.push({ ticker, cik: null, annual: { status: "CIK_NOT_FOUND" }, ttm: { status: "CIK_NOT_FOUND" } });
      continue;
    }
    const r = await auditTicker(ticker, cikPadded);
    console.log(`[sec-eps-probe] ${ticker} (CIK ${cikPadded}): annual=${r.annual.status}${r.annual.status === "OK" ? `(${r.annual.tag}, ${r.annual.confidence}, latest=${r.annual.latest_value}@${r.annual.latest_period_end}, filed=${r.annual.latest_filed_date}, years=${JSON.stringify(r.annual.fiscal_years)}, positive=${r.annual.positive_eps_years}, neg_or_zero=${r.annual.negative_or_zero_eps_years}, depth=${r.annual.history_depth_classification})` : ""} quarterly_points=${r.quarterly_points_found} ttm=${r.ttm.status}${r.ttm.status === "OK" ? `(${r.ttm.ttm_eps.toFixed(4)}, positive=${r.ttm.is_positive})` : ` (${r.ttm.reason})`}`);
    results.push(r);
  }

  const summary = {
    total_equities_tested: results.length,
    eps_diluted_tag_resolves: results.filter((r) => r.annual.status === "OK").map((r) => r.ticker),
    eps_diluted_unavailable: results.filter((r) => r.annual.status === "DATA_UNAVAILABLE").map((r) => r.ticker),
    cik_not_found: results.filter((r) => r.annual.status === "CIK_NOT_FOUND").map((r) => r.ticker),
    ttm_four_valid_quarters: results.filter((r) => r.ttm.status === "OK").map((r) => r.ticker),
    ttm_positive: results.filter((r) => r.ttm.status === "OK" && r.ttm.is_positive).map((r) => r.ticker),
    ttm_negative_or_zero: results.filter((r) => r.ttm.status === "OK" && !r.ttm.is_positive).map((r) => r.ticker),
    ttm_insufficient_data: results.filter((r) => r.ttm.status === "INSUFFICIENT_DATA").map((r) => r.ticker),
    annual_with_ambiguity: results.filter((r) => r.annual.status === "OK" && r.annual.ambiguity_note).map((r) => ({ ticker: r.ticker, note: r.annual.ambiguity_note })),
    history_strong: results.filter((r) => r.annual.history_depth_classification === "HISTORY_STRONG").map((r) => r.ticker),
    history_minimum: results.filter((r) => r.annual.history_depth_classification === "HISTORY_MINIMUM").map((r) => r.ticker),
    history_weak: results.filter((r) => r.annual.history_depth_classification === "HISTORY_WEAK").map((r) => r.ticker),
    no_usable_history: results.filter((r) => r.annual.history_depth_classification === "NO_USABLE_HISTORY").map((r) => r.ticker),
  };

  const report = { started_at: new Date().toISOString(), finished_at: new Date().toISOString(), tickers: TICKERS, results, summary };
  writeFileSync("sec-eps-coverage-probe.json", JSON.stringify(report, null, 2));

  console.log("[sec-eps-probe] === SUMMARY ===");
  console.log(JSON.stringify(summary, null, 2));
  console.log("[sec-eps-probe] done -- see sec-eps-coverage-probe.json artifact for full detail. NO Supabase write performed.");
}

main().catch((e) => { console.error("[fatal]", e); process.exit(1); });
