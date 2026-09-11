#!/usr/bin/env node
// scripts/secAnnualCanonicalizationAudit.mjs
//
// PRIORITY 1 (Historical Multiple Data Review) -- auditoria de
// canonicalizacion de EPS anual, SOLO LECTURA, temporal. Objetivo:
// verificar con evidencia real si positive_years/negative_or_zero_years/
// annual_history_count (del probe anterior) representan AÑOS FISCALES
// UNICOS o simplemente filas/frames/restatements crudos de SEC.
//
// extractAnnualPoints() (lib/secFinancialsResolver.js) YA deduplica por
// period_end (fecha de fin de periodo real), quedandose con la fila mas
// recientemente "filed" cuando dos filings reportan el MISMO period_end
// (ej. un 10-K/A que corrige un 10-K original) -- ese es el join key
// correcto porque period_end es la fecha de cierre REAL del periodo,
// mientras que el campo `fy` es metadata SUMINISTRADA POR EL FILER
// (dei:DocumentFiscalYearFocus) y puede estar inconsistentemente
// etiquetada entre filings (ej. un periodo comparativo mostrado en un
// 10-K posterior a veces hereda el `fy` del filing que lo muestra, no
// el fy real del periodo). Este script DEMUESTRA esto con evidencia,
// en vez de asumirlo, mostrando:
//
//   1. TODAS las filas crudas candidatas a "anual" (forma confiable +
//      duracion 330-400 dias) bajo el tag/unidad ganador, ANTES de
//      cualquier dedup -- agrupadas por period_end para exponer
//      cualquier restatement real (mismo period_end, multiples filed).
//   2. Esas mismas filas agrupadas por el campo `fy` tal cual lo
//      etiqueto el filer -- para exponer cualquier caso donde el MISMO
//      fy aparezca en multiples period_end distintos (mislabeling, no
//      duplicacion real de periodo).
//   3. El resultado post-dedup real de extractAnnualPoints() (lo que ya
//      usa produccion), con todos los campos pedidos.
//   4. UNIQUE_FISCAL_YEAR_COUNT calculado por period_end (la clave
//      correcta) vs conteo ingenuo por `fy` label, lado a lado.
//
// SEC EDGAR es publico -- sin API key, sin secret. NUNCA escribe en
// Supabase.

import { writeFileSync } from "node:fs";
import {
  CANDIDATE_TAGS, CONCEPT_UNITS, extractAnnualPoints, scoreCandidate,
  pickWinnerAndDetectAmbiguity, selectCompatibleUnit, TRUSTED_ANNUAL_FORMS,
  daysBetween,
} from "../lib/secFinancialsResolver.js";

const SEC_HEADERS = {
  "User-Agent": "MoniCapital-Diagnostic contacto@moni-capital-diagnostic.local",
};
const REQUEST_DELAY_MS = 150;

// Universo bajo auditoria: los 11 tickers EPS-eligible con historia
// STRONG o MINIMUM del re-audit anterior (post unit-selection fix).
// ALAB/GEV (WEAK) y BE/NBIS (sin historia usable) quedan fuera --
// no son objeto de esta validacion de canonicalizacion.
const TICKERS = [
  "AMD", "AMZN", "ANET", "GOOG", "GOOGL", "META", "MSFT",
  "NVDA", "ORCL", "QCOM", "VRT",
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
  const resp = await fetch(url, { headers: SEC_HEADERS });
  if (!resp.ok) return { error: `http_${resp.status}` };
  const data = await resp.json();
  return { data };
}

async function auditTicker(ticker, cikPadded) {
  const tags = CANDIDATE_TAGS.EPS_DILUTED;
  const allowedUnits = CONCEPT_UNITS.EPS_DILUTED;

  // Paso 1: replicar la misma decision de tag ganador que usa produccion
  // (pickWinnerAndDetectAmbiguity), para auditar el tag REAL usado, no
  // uno asumido.
  const candidates = [];
  const rawDataByTag = {};
  for (const tag of tags) {
    const result = await fetchConcept(cikPadded, tag);
    await sleep(REQUEST_DELAY_MS);
    if (result.data) {
      rawDataByTag[tag] = result.data;
      const points = extractAnnualPoints(result.data, allowedUnits);
      if (points.length > 0) candidates.push({ tag, points, score: scoreCandidate(points) });
    }
  }
  const decision = pickWinnerAndDetectAmbiguity(candidates, tags);
  if (decision.status !== "OK") {
    return { ticker, status: decision.status, reason: decision.reason };
  }

  const winningTag = decision.tag;
  const winningData = rawDataByTag[winningTag];
  const units = winningData.units || {};
  const unitKey = selectCompatibleUnit(units, allowedUnits);
  const rawEntries = units[unitKey] || [];

  // Paso 2: TODAS las filas crudas candidatas a "anual" bajo el tag
  // ganador -- misma forma (10-K/10-K/A/10-KT/10-KT/A) + duracion
  // 330-400 dias que usa extractAnnualPoints, pero SIN el dedup por
  // period_end, para exponer cualquier restatement real.
  const rawAnnualCandidates = rawEntries.filter((e) => {
    if (!TRUSTED_ANNUAL_FORMS.includes(e.form)) return false;
    if (e.start && e.end) {
      const dur = daysBetween(e.start, e.end);
      return dur != null && dur >= 330 && dur <= 400;
    }
    return true;
  }).map((e) => ({
    period_end: e.end, period_start: e.start || null, fy_label: e.fy ?? null,
    fp_label: e.fp ?? null, value: e.val, form: e.form, filed_date: e.filed,
    accession_number: e.accn || null,
  }));

  // Agrupar por period_end (clave correcta de "año fiscal unico real")
  // para exponer restatements genuinos (misma period_end, multiples filed).
  const byPeriodEnd = {};
  rawAnnualCandidates.forEach((e) => {
    if (!byPeriodEnd[e.period_end]) byPeriodEnd[e.period_end] = [];
    byPeriodEnd[e.period_end].push(e);
  });
  const periodEndGroupsWithDuplicates = Object.entries(byPeriodEnd)
    .filter(([, rows]) => rows.length > 1)
    .map(([period_end, rows]) => ({ period_end, candidate_count: rows.length, rows }));

  // Agrupar por fy_label (metadata del filer) para exponer mislabeling
  // (mismo fy en multiples period_end DISTINTOS -- no es duplicacion
  // real de periodo, es una etiqueta de filer inconsistente).
  const byFyLabel = {};
  rawAnnualCandidates.forEach((e) => {
    const key = String(e.fy_label);
    if (!byFyLabel[key]) byFyLabel[key] = new Set();
    byFyLabel[key].add(e.period_end);
  });
  const fyLabelsWithMultiplePeriodEnds = Object.entries(byFyLabel)
    .filter(([, endsSet]) => endsSet.size > 1)
    .map(([fy_label, endsSet]) => ({ fy_label, distinct_period_ends: [...endsSet] }));

  // Paso 3: resultado REAL post-dedup (lo que produccion ya usa hoy),
  // con confidence del ganador aplicada a cada punto (la confidence es
  // del CANDIDATO/tag completo, no per-punto, pero se reporta junto
  // para trazabilidad).
  const canonicalPoints = decision.points.map((p) => ({
    fiscal_year: p.fiscal_year, period_end: p.period_end, eps_diluted: p.value,
    filed_at: p.filed_date, accession_number: p.accession_number, form: p.form,
    raw_xbrl_tag: winningTag, normalization_confidence: decision.confidence,
  }));

  const uniqueFiscalYearCountByPeriodEnd = new Set(canonicalPoints.map((p) => p.period_end)).size;
  const uniqueFiscalYearCountByFyLabel = new Set(canonicalPoints.map((p) => p.fiscal_year)).size;

  const positivePoints = canonicalPoints.filter((p) => typeof p.eps_diluted === "number" && p.eps_diluted > 0);
  const negativeOrZeroPoints = canonicalPoints.filter((p) => typeof p.eps_diluted === "number" && p.eps_diluted <= 0);

  return {
    ticker,
    status: "OK",
    winning_tag: winningTag,
    confidence: decision.confidence,
    raw_annual_candidate_count_pre_dedup: rawAnnualCandidates.length,
    period_end_groups_with_duplicate_filings: periodEndGroupsWithDuplicates,
    fy_labels_with_multiple_period_ends: fyLabelsWithMultiplePeriodEnds,
    canonical_points: canonicalPoints,
    unique_fiscal_year_count_by_period_end: uniqueFiscalYearCountByPeriodEnd,
    unique_fiscal_year_count_by_fy_label: uniqueFiscalYearCountByFyLabel,
    positive_years_canonical: positivePoints.length,
    negative_or_zero_years_canonical: negativeOrZeroPoints.length,
  };
}

function classifyHistoryDepth(positiveYearsCount) {
  if (positiveYearsCount >= 5) return "HISTORY_STRONG";
  if (positiveYearsCount === 4) return "HISTORY_MINIMUM";
  if (positiveYearsCount >= 1) return "HISTORY_WEAK";
  return "NO_USABLE_HISTORY";
}

async function main() {
  console.log(`[canon-audit] started_at=${new Date().toISOString()} tickers=${JSON.stringify(TICKERS)}`);
  const cikMap = await getCikMap();
  const results = [];

  for (const ticker of TICKERS) {
    const cikPadded = cikMap[ticker];
    if (!cikPadded) {
      console.log(`[canon-audit] ${ticker}: cik_not_found`);
      results.push({ ticker, status: "CIK_NOT_FOUND" });
      continue;
    }
    const r = await auditTicker(ticker, cikPadded);
    results.push(r);
    if (r.status === "OK") {
      const depth = classifyHistoryDepth(r.positive_years_canonical);
      console.log(`[canon-audit] ${ticker}: tag=${r.winning_tag} confidence=${r.confidence} raw_pre_dedup=${r.raw_annual_candidate_count_pre_dedup} unique_by_period_end=${r.unique_fiscal_year_count_by_period_end} unique_by_fy_label=${r.unique_fiscal_year_count_by_fy_label} duplicate_filing_groups=${r.period_end_groups_with_duplicate_filings.length} fy_label_mismatches=${r.fy_labels_with_multiple_period_ends.length} positive=${r.positive_years_canonical} neg_or_zero=${r.negative_or_zero_years_canonical} depth=${depth}`);
      console.log(`[canon-audit] ${ticker}: canonical_points=${JSON.stringify(r.canonical_points)}`);
      if (r.period_end_groups_with_duplicate_filings.length > 0) {
        console.log(`[canon-audit] ${ticker}: DUPLICATE_FILINGS_FOR_SAME_PERIOD=${JSON.stringify(r.period_end_groups_with_duplicate_filings)}`);
      }
      if (r.fy_labels_with_multiple_period_ends.length > 0) {
        console.log(`[canon-audit] ${ticker}: FY_LABEL_MISMATCHES=${JSON.stringify(r.fy_labels_with_multiple_period_ends)}`);
      }
    } else {
      console.log(`[canon-audit] ${ticker}: status=${r.status} reason=${r.reason || ""}`);
    }
  }

  const summary = {
    total_tested: results.length,
    history_strong_canonical: results.filter((r) => r.status === "OK" && classifyHistoryDepth(r.positive_years_canonical) === "HISTORY_STRONG").map((r) => r.ticker),
    history_minimum_canonical: results.filter((r) => r.status === "OK" && classifyHistoryDepth(r.positive_years_canonical) === "HISTORY_MINIMUM").map((r) => r.ticker),
    history_weak_canonical: results.filter((r) => r.status === "OK" && classifyHistoryDepth(r.positive_years_canonical) === "HISTORY_WEAK").map((r) => r.ticker),
    tickers_with_duplicate_filings_for_same_period: results.filter((r) => r.status === "OK" && r.period_end_groups_with_duplicate_filings.length > 0).map((r) => r.ticker),
    tickers_with_fy_label_mismatches: results.filter((r) => r.status === "OK" && r.fy_labels_with_multiple_period_ends.length > 0).map((r) => r.ticker),
  };

  const report = { started_at: new Date().toISOString(), finished_at: new Date().toISOString(), tickers: TICKERS, results, summary };
  writeFileSync("sec-annual-canonicalization-audit.json", JSON.stringify(report, null, 2));

  console.log("[canon-audit] === SUMMARY ===");
  console.log(JSON.stringify(summary, null, 2));
  console.log("[canon-audit] done -- see sec-annual-canonicalization-audit.json artifact. NO Supabase write performed.");
}

main().catch((e) => { console.error("[fatal]", e); process.exit(1); });
