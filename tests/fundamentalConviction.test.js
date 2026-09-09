// tests/fundamentalConviction.test.js
// Micro-sprint P3.2.1 (Fundamental Conviction Coverage). Tests A-P
// (letras propias de P3.2.1, distintas de las A-W de P3.2). Este
// archivo cubre las letras que corresponden a las funciones PURAS de
// lib/fundamentalConviction.js (E, F, G, H, I, J). Las letras que
// requieren estado acumulado real en Supabase (A, B, C, D, K-P) se
// cubren al integrar api/conviction-benchmark-temp.js.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  UNKNOWN,
  selectLatestPerConcept,
  seriesForConcept,
  classifyFactFreshness,
  computeBusinessQuality,
  computeObservedGrowth,
  computeExecutionFromEarnings,
  computeFinancialStrength,
  computeValuationFromPeg,
  classifyEvidenceSufficiency,
  MIN_COVERAGE_FOR_RECOMMENDATION,
  MIN_COMPONENTS_FOR_RECOMMENDATION,
} from "../lib/fundamentalConviction.js";

// Datos reales QCOM (sec_financials_normalized, HIGH confidence,
// source=sec_edgar, form=10-K) -- mismos numeros documentados en el
// PRE audit de P3.2.1, no inventados para el test.
const QCOM_REVENUE = [
  { canonical_concept: "REVENUE", value: 44284000000, period_end: "2025-09-28", source: "sec_edgar" },
  { canonical_concept: "REVENUE", value: 38962000000, period_end: "2024-09-29", source: "sec_edgar" },
  { canonical_concept: "REVENUE", value: 35820000000, period_end: "2023-09-24", source: "sec_edgar" },
];
const QCOM_OPERATING_INCOME = [
  { canonical_concept: "OPERATING_INCOME", value: 12355000000, period_end: "2025-09-28", source: "sec_edgar" },
  { canonical_concept: "OPERATING_INCOME", value: 10071000000, period_end: "2024-09-29", source: "sec_edgar" },
  { canonical_concept: "OPERATING_INCOME", value: 7788000000, period_end: "2023-09-24", source: "sec_edgar" },
];
const QCOM_FCF = [
  { canonical_concept: "FREE_CASH_FLOW", value: 12820000000, period_end: "2025-09-28", source: "sec_edgar" },
  { canonical_concept: "FREE_CASH_FLOW", value: 11161000000, period_end: "2024-09-29", source: "sec_edgar" },
];

// ================== Fact layer ==================
test("selectLatestPerConcept: elige la fila de period_end mas reciente por concepto, historia preservada aparte", () => {
  const rows = [...QCOM_REVENUE, ...QCOM_OPERATING_INCOME];
  const byConcept = selectLatestPerConcept(rows);
  assert.equal(byConcept.REVENUE.period_end, "2025-09-28");
  assert.equal(byConcept.OPERATING_INCOME.period_end, "2025-09-28");
});

test("seriesForConcept: devuelve la serie completa de un concepto ordenada mas reciente primero", () => {
  const series = seriesForConcept(QCOM_REVENUE, "REVENUE");
  assert.equal(series.length, 3);
  assert.equal(series[0].period_end, "2025-09-28");
  assert.equal(series[2].period_end, "2023-09-24");
});

test("classifyFactFreshness: sin period_end -> UNKNOWN, nunca CURRENT por defecto", () => {
  assert.equal(classifyFactFreshness(null, "2026-09-09"), UNKNOWN);
});

test("classifyFactFreshness: <=550 dias -> CURRENT, >550 -> STALE", () => {
  assert.equal(classifyFactFreshness("2025-09-28", "2026-09-09"), "CURRENT");
  assert.equal(classifyFactFreshness("2023-09-24", "2026-09-09"), "STALE");
});

// ================== E. missing fundamental remains UNKNOWN ==================
test("E - BUSINESS_QUALITY sin revenue ni operating income -> UNKNOWN explicito, nunca 0 ni un valor fabricado", () => {
  const r = computeBusinessQuality([], []);
  assert.equal(r.value, UNKNOWN);
  assert.equal(r.method, "no_revenue_or_operating_income_data");
});

test("E - FINANCIAL_STRENGTH sin FCF data (AMD hoy, cero filas SEC) -> UNKNOWN, balance sheet declarado UNAVAILABLE", () => {
  const r = computeFinancialStrength([], []);
  assert.equal(r.value, UNKNOWN);
  assert.match(r.balance_sheet_facts, /UNAVAILABLE/);
});

test("E - GROWTH_TAM con un solo periodo de revenue (no hay YoY posible) -> UNKNOWN, no asume 0% de crecimiento", () => {
  const r = computeObservedGrowth([QCOM_REVENUE[0]]);
  assert.equal(r.value, UNKNOWN);
  assert.equal(r.tam_interpretation, UNKNOWN);
});

test("E - EXECUTION con un solo trimestre real (no permite promedio confiable) -> UNKNOWN, nunca Execution=5 por un solo beat", () => {
  const r = computeExecutionFromEarnings([{ surprisePct: 0.15, period_end: "2025-06-30" }]);
  assert.equal(r.value, UNKNOWN);
  assert.equal(r.quarters_available, 1);
});

test("E - VALUATION sin PE real (p.ej. FMP fallo, market_cache vacio) -> UNKNOWN, nunca fallback fabricado", () => {
  const r = computeValuationFromPeg(UNKNOWN, 0.1366);
  assert.equal(r.value, UNKNOWN);
  assert.equal(r.historical_multiples, "UNAVAILABLE");
});

// ================== F. deterministic fundamental calculation reproducible ==================
test("F - computeBusinessQuality es puro: mismos inputs reales (QCOM) -> mismo resultado siempre", () => {
  const r1 = computeBusinessQuality(QCOM_REVENUE, QCOM_OPERATING_INCOME);
  const r2 = computeBusinessQuality(
    JSON.parse(JSON.stringify(QCOM_REVENUE)),
    JSON.parse(JSON.stringify(QCOM_OPERATING_INCOME))
  );
  assert.deepEqual(r1, r2);
  assert.notEqual(r1.value, UNKNOWN);
});

test("F - QCOM real: operating margin FY25 ~27.9%, mejora YoY de ~2.05pp -> BUSINESS_QUALITY=4.5 (base 4 + trend +0.5)", () => {
  const r = computeBusinessQuality(QCOM_REVENUE, QCOM_OPERATING_INCOME);
  assert.equal(r.operating_margin_pct, 27.9);
  assert.equal(r.value, 4.5);
  assert.match(r.trend, /margin_improved/);
});

test("F - computeObservedGrowth es puro y reproducible sobre los mismos datos reales de QCOM", () => {
  const r1 = computeObservedGrowth(QCOM_REVENUE);
  const r2 = computeObservedGrowth(JSON.parse(JSON.stringify(QCOM_REVENUE)));
  assert.deepEqual(r1, r2);
  assert.equal(r1.observed_growth_pct, 13.7);
});

// ================== G. source/asOf preserved ==================
test("G - cada componente calculado conserva period_end (asOf) y source reales, nunca se pierden en el calculo", () => {
  const bq = computeBusinessQuality(QCOM_REVENUE, QCOM_OPERATING_INCOME);
  assert.equal(bq.period_end, "2025-09-28");
  assert.equal(bq.source, "sec_edgar");

  const fs = computeFinancialStrength(QCOM_REVENUE, QCOM_FCF);
  assert.equal(fs.period_end, "2025-09-28");
  assert.equal(fs.source, "sec_edgar");

  const gt = computeObservedGrowth(QCOM_REVENUE);
  assert.equal(gt.latest_period, "2025-09-28");
  assert.equal(gt.prior_period, "2024-09-29");
  assert.equal(gt.source, "sec_edgar");
});

// ================== H. valuation does not equal analyst target blindly ==================
test("H - VALUATION nunca usa analyst target como medida -- el campo se declara UNAVAILABLE por diseño, siempre", () => {
  const r = computeValuationFromPeg(19.14, 0.1366);
  assert.equal(r.analyst_targets, "UNAVAILABLE(nunca usado como medida unica por diseño)");
  assert.equal(r.method, "peg_like_current_pe_over_observed_revenue_growth");
  assert.ok(!("analyst_target_price" in r));
});

test("H - QCOM real: PE=19.14, growth observado=13.66% -> PEG proxy ~1.40 -> VALUATION=4 (peg<1.5)", () => {
  const r = computeValuationFromPeg(19.14, 0.1366);
  assert.equal(r.peg_proxy, 1.4);
  assert.equal(r.value, 4.0);
});

// ================== I. observed growth separated from TAM interpretation ==================
test("I - computeObservedGrowth NUNCA calcula tam_interpretation -- siempre UNKNOWN, sin importar el crecimiento observado", () => {
  const strong = computeObservedGrowth(QCOM_REVENUE);
  assert.notEqual(strong.value, UNKNOWN);
  assert.equal(strong.tam_interpretation, UNKNOWN, "un crecimiento observado real fuerte no debe rellenar TAM_INTERPRETATION");

  const declining = computeObservedGrowth([
    { value: 100, period_end: "2025-01-01" },
    { value: 150, period_end: "2024-01-01" },
  ]);
  assert.equal(declining.tam_interpretation, UNKNOWN);
});

// ================== J. low coverage cannot create unjustified conviction change ==================
test("J - coverage por debajo del minimo (30%) -> classifyEvidenceSufficiency.sufficient=false aunque haya componentes conocidos", () => {
  const r = classifyEvidenceSufficiency({ coverage: 0.143, componentsKnown: 2 });
  assert.equal(r.sufficient, false);
  assert.match(r.reason, /below_minimum/);
});

test("J - componentes conocidos por debajo del minimo (3) -> insuficiente aunque coverage nominal sea alta", () => {
  const r = classifyEvidenceSufficiency({ coverage: 0.5, componentsKnown: 2 });
  assert.equal(r.sufficient, false);
});

test("J - coverage y componentes conocidos ambos cumplen el minimo -> sufficient=true, recomendacion permitida", () => {
  const r = classifyEvidenceSufficiency({ coverage: MIN_COVERAGE_FOR_RECOMMENDATION, componentsKnown: MIN_COMPONENTS_FOR_RECOMMENDATION });
  assert.equal(r.sufficient, true);
  assert.match(r.reason, /meet_minimum/);
});

// ================== EXECUTION real (AMD, datos ya ingeridos) ==================
test("EXECUTION real AMD: 3 trimestres reales, todo beat, promedio ~+7.1% (franja >=0.05<0.10) -> value=4, sin penalizacion por ser ALL_BEAT", () => {
  const surprises = [
    { surprisePct: 0.0176, period_end: "2025-Q1" },
    { surprisePct: 0.0479, period_end: "2025-Q2" },
    { surprisePct: 0.1483, period_end: "2025-Q3" },
  ];
  const r = computeExecutionFromEarnings(surprises);
  assert.equal(r.consistency, "ALL_BEAT");
  assert.equal(r.beat_count, 3);
  assert.equal(r.avg_surprise_pct, 7.1);
  assert.equal(r.value, 4.0);
});

test("EXECUTION: resultados mixtos (beat + miss) aplican penalizacion de consistencia -0.5", () => {
  const surprises = [
    { surprisePct: 0.08, period_end: "Q1" },
    { surprisePct: -0.02, period_end: "Q2" },
  ];
  const r = computeExecutionFromEarnings(surprises);
  assert.equal(r.consistency, "MIXED");
  const noPenalty = computeExecutionFromEarnings([{ surprisePct: 0.08, period_end: "Q1" }, { surprisePct: 0.08, period_end: "Q2" }]);
  assert.ok(r.value < noPenalty.value, "MIXED debe puntuar mas bajo que ALL_BEAT con el mismo promedio");
});
