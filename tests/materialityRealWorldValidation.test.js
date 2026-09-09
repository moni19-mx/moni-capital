// tests/materialityRealWorldValidation.test.js
// Sprint P3.1B.1 (Materiality Real-World Validation). Tests B-J
// exigidos por la Regla 16 del sprint -- Test A (canonical strategic
// tags) ya vive en tests/canonicalThemeTags.test.js. Estos son
// deliberadamente "real-shaped": usan la forma REAL de un registro de
// Finnhub /stock/earnings normalizado (no un fixture arbitrario
// desconectado del proveedor real), aunque los valores numericos
// puntuales pueden ser sinteticos donde el sandbox no tiene acceso a
// red real.

import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeFinnhubEarnings, normalizeFinnhubNews } from "../lib/materialEventNormalize.js";
import {
  computeFinancialScale, computeStrategicRelevance, computeTimelineUrgency,
  computeSourceStrength, computeDeterministicScore,
} from "../lib/materialityEngine.js";
import { tierScore } from "../lib/materialEventSources.js";
import { requestAiAdjustment, AI_NOT_ATTEMPTED } from "../lib/materialityAiAdjustment.js";
import { computeFinalMateriality } from "../lib/materialityFormula.js";
import { classifyPredictionOutcome } from "../lib/materialityValidation.js";

// ================== B. FINANCIAL_SCALE con input real-shaped ==================
test("B - FINANCIAL_SCALE: registro real-shaped de Finnhub /stock/earnings (actual/estimate reales) produce un score computable, no UNKNOWN", () => {
  const raw = { symbol: "QCOM", period: "2026-06-30", year: 2026, quarter: 3, actual: 2.62, estimate: 2.51, surprise: 0.11, surprisePercent: 4.38 };
  const normalized = normalizeFinnhubEarnings(raw, { asset_id: 29, ticker: "QCOM" });
  const result = computeFinancialScale(normalized.event_type, normalized.facts, {});
  assert.notEqual(result.value, "UNKNOWN");
  assert.equal(result.method, "earnings_surprise_pct");
  // surprisePct real = |2.62-2.51|/|2.51| ~ 0.0438 -- verificado a mano.
  assert.ok(Math.abs(result.surprisePct - 0.0438) < 0.001);
  assert.equal(result.value, Math.round(0.0438 * 400)); // formula real, sin numeros magicos nuevos aqui
});

// ================== C. TIMELINE_URGENCY con input real-shaped ==================
// P3.1B.2: el bug real encontrado aqui en P3.1B.1 (un earnings_date
// pasado SIEMPRE devolvia urgencia=100, sin importar hace cuanto) ya
// esta corregido -- este mismo test ahora verifica el comportamiento
// nuevo (disclosure decay) en vez del bug.
test("C - TIMELINE_URGENCY: earnings_date real-shaped (periodo ocurrido hace ~71 dias) -> disclosure decay, nunca UNKNOWN ni 100 fijo", () => {
  const raw = { symbol: "QCOM", period: "2026-06-30", year: 2026, quarter: 3, actual: 2.62, estimate: 2.51 };
  const normalized = normalizeFinnhubEarnings(raw, { asset_id: 29, ticker: "QCOM" });
  const result = computeTimelineUrgency(normalized.event_type, normalized.facts, "2026-09-09T00:00:00.000Z");
  assert.notEqual(result.value, "UNKNOWN");
  assert.equal(result.method, "disclosure_decay");
  assert.equal(result.bucket, "MEDIUM_TERM_DISCLOSURE");
  assert.equal(result.value, 30);
  assert.notEqual(result.value, 100, "bug real corregido en P3.1B.2: ya no es 100 fijo solo por haber ocurrido");
  assert.ok(result.days_since_published > 0, "un earnings_date pasado debe dar days_since_published positivo");
});

test("C - TIMELINE_URGENCY: noticia de texto libre (Finnhub company-news) sin fecha estructurada -> UNKNOWN honesto", () => {
  const raw = { headline: "Qualcomm signs new agreement with major customer", datetime: 1735689600, source: "Reuters", url: "https://example.com" };
  const normalized = normalizeFinnhubNews(raw, { asset_id: 29, ticker: "QCOM" });
  const result = computeTimelineUrgency(normalized.event_type, normalized.facts, "2026-09-09T00:00:00.000Z");
  assert.equal(result.value, "UNKNOWN");
});

// ================== D. Spectacular wording no altera el score deterministico ==================
test("D - un headline espectacular SIN facts estructurados no sube FINANCIAL_SCALE por el lenguaje", () => {
  const raw = { headline: "Qualcomm announces HISTORIC game-changing massive blockbuster deal with Amazon", datetime: 1735689600, source: "Reuters", url: "https://example.com" };
  const normalized = normalizeFinnhubNews(raw, { asset_id: 29, ticker: "QCOM" });
  const result = computeFinancialScale(normalized.event_type, normalized.facts, {});
  assert.equal(result.value, "UNKNOWN", "sin deal_value real en facts, ningun adjetivo del headline puede producir un numero");
});

test("D - un filing 'aburrido' con facts numericos reales SI puede llegar a HIGH, aunque el headline no suene dramatico", () => {
  const boringFacts = { deal_value: 5_000_000_000, source_url: "UNKNOWN" };
  const context = { trailing_annual_revenue: 10_000_000_000 }; // ratio real 0.5 -> escala alta
  const result = computeFinancialScale("MAJOR_CONTRACT", boringFacts, context);
  assert.notEqual(result.value, "UNKNOWN");
  assert.ok(result.value >= 70, `un ratio deal/revenue real de 0.5 deberia producir FINANCIAL_SCALE alto (obtuvo ${result.value}), sin importar que el headline sea neutro`);
});

// ================== E. UNKNOWN permanece UNKNOWN en la corrida real ==================
test("E - earnings real-shaped sin actual/estimate (registro incompleto de Finnhub) -> FINANCIAL_SCALE UNKNOWN, nunca 0", () => {
  const raw = { symbol: "QCOM", period: "2026-06-30", year: 2026, quarter: 3, actual: null, estimate: null };
  const normalized = normalizeFinnhubEarnings(raw, { asset_id: 29, ticker: "QCOM" });
  const result = computeFinancialScale(normalized.event_type, normalized.facts, {});
  assert.equal(result.value, "UNKNOWN");
  assert.notEqual(result.value, 0, "UNKNOWN nunca debe colapsarse a 0 -- son afirmaciones distintas");
});

// ================== F. SEC Tier 1 > Finnhub Tier 3 (jerarquia real de fuentes) ==================
test("F - SOURCE_STRENGTH: Tier 1 (SEC EDGAR, evidencia primaria regulatoria) supera a Tier 3 (Finnhub, agregador de noticias)", () => {
  const sec = computeSourceStrength(1);
  const finnhub = computeSourceStrength(3);
  assert.ok(sec.value > finnhub.value, `Tier 1 (${sec.value}) deberia superar a Tier 3 (${finnhub.value})`);
  assert.equal(sec.value, tierScore(1));
  assert.equal(finnhub.value, tierScore(3));
});

// ================== G. Score deterministico reproducible ==================
test("G - computeDeterministicScore es puro: mismos componentes de entrada -> exactamente el mismo score, sin importar cuantas veces se llame", () => {
  const components = {
    FINANCIAL_SCALE: { value: 62 }, STRATEGIC_RELEVANCE: { value: 60 },
    TIMELINE_URGENCY: { value: "UNKNOWN" }, SOURCE_STRENGTH: { value: 50 },
  };
  const first = computeDeterministicScore(components);
  const second = computeDeterministicScore(components);
  const third = computeDeterministicScore(JSON.parse(JSON.stringify(components))); // clon independiente, mismos valores
  assert.deepEqual(first, second);
  assert.deepEqual(first, third);
});

// ================== H. AI nunca modifica facts ==================
test("H - requestAiAdjustment nunca modifica el objeto de facts que se le pasa como contexto", async () => {
  const facts = Object.freeze({ deal_value: 5_000_000_000, source_url: "https://example.com" });
  const contextSnapshot = JSON.stringify(facts);
  const callModelFn = async () => JSON.stringify({ adjustment: 5, reason: "matiz cualitativo razonable", interpretation: "test" });
  const result = await requestAiAdjustment(callModelFn, { facts });
  assert.equal(JSON.stringify(facts), contextSnapshot, "facts no debe haber cambiado de forma alguna");
  assert.equal(result.ai_status, "APPLIED");
  assert.equal(result.adjustment, 5);
});

// ================== I. Fallo de AI conserva el score deterministico ==================
test("I - si el AI provider falla (excepcion de red), el ai_status es FAILED y el score deterministico se preserva intacto", async () => {
  const det = { status: "SCORED", score: 45 };
  const callModelFnThatThrows = async () => { throw new Error("network_error: ECONNRESET"); };
  const aiResult = await requestAiAdjustment(callModelFnThatThrows, {});
  assert.equal(aiResult.ai_status, "FAILED");
  assert.equal(aiResult.adjustment, 0);
  const finalScore = computeFinalMateriality(det.score, aiResult.adjustment);
  assert.equal(finalScore, det.score, "un fallo de AI nunca debe alterar el score deterministico -- adjustment 0 lo preserva exacto");
});

test("I - AI_NOT_ATTEMPTED es un estado distinto de FAILED, y tambien preserva el score deterministico intacto", () => {
  const det = { status: "SCORED", score: 45 };
  const finalScore = computeFinalMateriality(det.score, AI_NOT_ATTEMPTED.adjustment);
  assert.equal(AI_NOT_ATTEMPTED.ai_status, "NOT_ATTEMPTED");
  assert.equal(finalScore, det.score);
});

// ================== J. La evaluacion EXPECTED vs ACTUAL nunca modifica el engine ==================
test("J - classifyPredictionOutcome es puro (solo strings, sin side effects) y no requiere ni toca ningun modulo del engine", () => {
  assert.deepEqual(classifyPredictionOutcome({ expected: "MEDIUM", actual: "MEDIUM" }), { outcome: "MATCH", distance: 0 });
  assert.deepEqual(classifyPredictionOutcome({ expected: "LOW", actual: "HIGH" }), { outcome: "FALSE_POSITIVE", distance: 2 });
  assert.deepEqual(classifyPredictionOutcome({ expected: "HIGH", actual: "LOW" }), { outcome: "FALSE_NEGATIVE", distance: -2 });
  assert.deepEqual(classifyPredictionOutcome({ expected: "LOW", actual: "MEDIUM" }), { outcome: "NEAR_MISS", distance: 1 });
  assert.deepEqual(classifyPredictionOutcome({ expected: "MEDIUM", actual: "HIGH" }), { outcome: "NEAR_MISS", distance: 1 });
});

test("J - llamar classifyPredictionOutcome repetidamente no cambia el resultado de computeDeterministicScore para los mismos componentes (no hay estado compartido)", () => {
  const components = { FINANCIAL_SCALE: { value: 30 }, STRATEGIC_RELEVANCE: { value: 40 }, TIMELINE_URGENCY: { value: 20 }, SOURCE_STRENGTH: { value: 50 } };
  const before = computeDeterministicScore(components);
  for (let i = 0; i < 5; i++) classifyPredictionOutcome({ expected: "LOW", actual: "HIGH" });
  const after = computeDeterministicScore(components);
  assert.deepEqual(before, after);
});
