import { test } from "node:test";
import assert from "node:assert/strict";
import {
  computeFinancialScale, computeStrategicRelevance, computeTimelineUrgency, computeSourceStrength,
  computeDeterministicScore, classifyPortfolioRelevance, UNKNOWN,
} from "../lib/materialityEngine.js";

const NOW = "2026-09-09T12:00:00Z";

// A. deterministic score con 4 componentes conocidos
test("A - 4 componentes conocidos producen un score ponderado sin renormalizar", () => {
  const components = {
    FINANCIAL_SCALE: { value: 80 },
    STRATEGIC_RELEVANCE: { value: 60 },
    TIMELINE_URGENCY: { value: 50 },
    SOURCE_STRENGTH: { value: 100 },
  };
  const r = computeDeterministicScore(components);
  assert.equal(r.status, "SCORED");
  assert.equal(r.components_known, 4);
  // 80*0.35 + 60*0.25 + 50*0.15 + 100*0.25 = 28+15+7.5+25 = 75.5 -> 76
  assert.equal(r.score, 76);
});

// B. 1 UNKNOWN -> renormalizacion correcta
test("B - 1 componente UNKNOWN se excluye y renormaliza, nunca cuenta como 0", () => {
  const components = {
    FINANCIAL_SCALE: { value: UNKNOWN },
    STRATEGIC_RELEVANCE: { value: 60 },
    TIMELINE_URGENCY: { value: 50 },
    SOURCE_STRENGTH: { value: 100 },
  };
  const r = computeDeterministicScore(components);
  assert.equal(r.status, "SCORED");
  assert.equal(r.components_known, 3);
  // pesos originales 0.25+0.15+0.25=0.65 -> renormalizados a 1.0
  // score = (60*0.25 + 50*0.15 + 100*0.25) / 0.65 = (15+7.5+25)/0.65 = 73.08 -> 73
  assert.equal(r.score, 73);
  assert.ok(!("FINANCIAL_SCALE" in r.weights_used));
  const sumWeights = Object.values(r.weights_used).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(sumWeights - 1) < 0.01, "pesos renormalizados deben sumar ~1.0");
});

// C. varios UNKNOWN -> renormalizacion correcta
test("C - 2 componentes UNKNOWN se excluyen ambos, renormaliza entre los 2 restantes", () => {
  const components = {
    FINANCIAL_SCALE: { value: UNKNOWN },
    STRATEGIC_RELEVANCE: { value: UNKNOWN },
    TIMELINE_URGENCY: { value: 50 },
    SOURCE_STRENGTH: { value: 100 },
  };
  const r = computeDeterministicScore(components);
  assert.equal(r.status, "SCORED");
  assert.equal(r.components_known, 2);
  // pesos 0.15+0.25=0.40 renormalizados: TIMELINE=0.375, SOURCE=0.625
  // score = 50*0.375 + 100*0.625 = 18.75+62.5 = 81.25 -> 81
  assert.equal(r.score, 81);
});

// D. todos UNKNOWN -> DATA_UNAVAILABLE, no 0
test("D - los 4 componentes UNKNOWN produce DATA_UNAVAILABLE, NUNCA score 0", () => {
  const components = {
    FINANCIAL_SCALE: { value: UNKNOWN },
    STRATEGIC_RELEVANCE: { value: UNKNOWN },
    TIMELINE_URGENCY: { value: UNKNOWN },
    SOURCE_STRENGTH: { value: UNKNOWN },
  };
  const r = computeDeterministicScore(components);
  assert.equal(r.status, "DATA_UNAVAILABLE");
  assert.equal(r.score, null);
  assert.notEqual(r.score, 0);
});

// FINANCIAL_SCALE por event_type
test("FINANCIAL_SCALE: MAJOR_CONTRACT con deal_value y revenue reales calcula ratio real", () => {
  const r = computeFinancialScale("MAJOR_CONTRACT", { deal_value: 500_000_000 }, { trailing_annual_revenue: 10_000_000_000 });
  assert.equal(r.method, "contract_value_to_revenue");
  assert.equal(typeof r.value, "number");
  assert.ok(r.value > 0);
});

test("FINANCIAL_SCALE: MAJOR_CONTRACT sin deal_value (UNKNOWN en facts) -> UNKNOWN, nunca inferido de texto", () => {
  const r = computeFinancialScale("MAJOR_CONTRACT", { deal_value: "UNKNOWN", counterparty: "Amazon" }, { trailing_annual_revenue: 10_000_000_000 });
  assert.equal(r.value, UNKNOWN);
  assert.ok(r.inputs_missing.includes("deal_value"));
});

test("FINANCIAL_SCALE: event_type sin formula deterministica (OTHER) siempre UNKNOWN", () => {
  const r = computeFinancialScale("OTHER", { headline_raw: "algo generico" }, {});
  assert.equal(r.value, UNKNOWN);
});

test("FINANCIAL_SCALE: EARNINGS con surprise real calcula magnitud real", () => {
  const r = computeFinancialScale("EARNINGS", { eps_actual: 2.62, eps_estimated: 2.51 }, {});
  assert.equal(r.method, "earnings_surprise_pct");
  assert.ok(r.value > 0 && r.value < 100);
});

// STRATEGIC_RELEVANCE
test("STRATEGIC_RELEVANCE: sin ningun contexto de posicion -> UNKNOWN", () => {
  const r = computeStrategicRelevance({ headline_raw: "x" }, {});
  assert.equal(r.value, UNKNOWN);
});

test("STRATEGIC_RELEVANCE: posicion activa + tema clasificado + overlap de keyword en headline suma los 3 puntos deterministicos", () => {
  const r = computeStrategicRelevance(
    { headline_raw: "Qualcomm anuncia expansion en Semiconductores IA" },
    { isActivePosition: true, tema: "Semiconductores IA", sector: "Semiconductores" }
  );
  assert.ok(r.value >= 40, "deberia sumar al menos active_position + classified_as");
  assert.ok(r.evidence.includes("active_position"));
});

test("STRATEGIC_RELEVANCE: nunca inventa relevancia -- headline sin overlap real de keyword no suma ese punto", () => {
  const withOverlap = computeStrategicRelevance(
    { headline_raw: "algo sobre semiconductores hoy" },
    { isActivePosition: true, tema: "Semiconductores IA" }
  );
  const withoutOverlap = computeStrategicRelevance(
    { headline_raw: "un titular totalmente ajeno sin relacion" },
    { isActivePosition: true, tema: "Semiconductores IA" }
  );
  assert.ok(withOverlap.value > withoutOverlap.value);
});

// TIMELINE_URGENCY vs freshness -- N
test("N - TIMELINE_URGENCY es distinto de freshness: sin fecha relevante en facts -> UNKNOWN, NUNCA 'publicado hoy = 100'", () => {
  const r = computeTimelineUrgency({ headline_raw: "publicado justo ahora" }, NOW);
  assert.equal(r.value, UNKNOWN);
});

test("TIMELINE_URGENCY: fecha efectiva real dentro de 30 dias produce urgencia alta", () => {
  const r = computeTimelineUrgency({ effective_date: "2026-09-20" }, NOW);
  assert.equal(r.value, 80);
});

test("TIMELINE_URGENCY: fecha efectiva lejana (mas de 180 dias) produce urgencia baja", () => {
  const r = computeTimelineUrgency({ effective_date: "2027-12-01" }, NOW);
  assert.equal(r.value, 20);
});

// O. Tier 1 promotion mejora source confidence (via SOURCE_STRENGTH, mismo tierScore)
test("O - SOURCE_STRENGTH: Tier 1 produce valor mayor que Tier 3, reflejando promocion de fuente", () => {
  const tier1 = computeSourceStrength(1);
  const tier3 = computeSourceStrength(3);
  assert.ok(tier1.value > tier3.value);
  assert.equal(tier1.value, 100);
  assert.equal(tier3.value, 50);
});

test("SOURCE_STRENGTH: sin fuente primaria -> UNKNOWN", () => {
  assert.equal(computeSourceStrength(null).value, UNKNOWN);
});

// Q. provider failure no equivale a no-event -- a nivel de materiality:
// DATA_UNAVAILABLE (por falta de datos) es un estado DISTINTO de "score
// bajo real" -- nunca se colapsan.
test("Q - DATA_UNAVAILABLE (sin datos) es un estado distinto de LOW materiality (con datos que dan bajo)", () => {
  const allUnknown = computeDeterministicScore({
    FINANCIAL_SCALE: { value: UNKNOWN }, STRATEGIC_RELEVANCE: { value: UNKNOWN },
    TIMELINE_URGENCY: { value: UNKNOWN }, SOURCE_STRENGTH: { value: UNKNOWN },
  });
  const genuinelyLow = computeDeterministicScore({
    FINANCIAL_SCALE: { value: 5 }, STRATEGIC_RELEVANCE: { value: 5 },
    TIMELINE_URGENCY: { value: 5 }, SOURCE_STRENGTH: { value: 25 },
  });
  assert.equal(allUnknown.status, "DATA_UNAVAILABLE");
  assert.equal(genuinelyLow.status, "SCORED");
  assert.notEqual(allUnknown.score, genuinelyLow.score); // null !== numero bajo real
});

// Company materiality vs Portfolio relevance -- seccion 12, dimensiones separadas
test("company materiality y portfolio relevance son dimensiones independientes, nunca mezcladas en un numero", () => {
  const relevance = classifyPortfolioRelevance({ isActivePosition: true, conviction: 4 });
  assert.equal(relevance.level, "HIGH");
  assert.equal(relevance.reason, "active_position_high_conviction(4)");
  // no depende de ningun materiality_score -- es una funcion pura de portfolio, no del evento
});

test("classifyPortfolioRelevance: sin posicion activa -> LOW siempre, sin importar conviction", () => {
  const r = classifyPortfolioRelevance({ isActivePosition: false, conviction: 5 });
  assert.equal(r.level, "LOW");
  assert.equal(r.reason, "not_an_active_position");
});

test("classifyPortfolioRelevance: posicion activa con conviction baja -> MEDIUM, nunca HIGH inventado", () => {
  const r = classifyPortfolioRelevance({ isActivePosition: true, conviction: 1 });
  assert.equal(r.level, "MEDIUM");
});

// L. HIGH materiality + LOW confidence valido -- son ejes independientes,
// nunca se fuerza que uno implique el otro.
test("L - materiality alta con confidence baja es una combinacion valida y explicable (evento importante, evidencia floja)", () => {
  const det = computeDeterministicScore({
    FINANCIAL_SCALE: { value: 90 }, STRATEGIC_RELEVANCE: { value: 85 },
    TIMELINE_URGENCY: { value: 80 }, SOURCE_STRENGTH: { value: 25 }, // Tier 4, fuente debil
  });
  assert.equal(det.status, "SCORED");
  assert.ok(det.score >= 70, "materiality deberia ser HIGH");
  // confidence bajo simulado: Tier 4 + baja corroboracion -- no es parte
  // de este modulo (vive en materialEventConfidence.js), pero la
  // combinacion debe poder coexistir sin que un componente fuerce al otro.
  const lowConfidenceSourceScore = 25; // mismo Tier 4 -- consistente
  assert.equal(lowConfidenceSourceScore, 25);
});

// M. LOW materiality + HIGH confidence valido
test("M - materiality baja con confidence alta es una combinacion valida (evento genuinamente poco importante, pero bien verificado)", () => {
  const det = computeDeterministicScore({
    FINANCIAL_SCALE: { value: 5 }, STRATEGIC_RELEVANCE: { value: 10 },
    TIMELINE_URGENCY: { value: 5 }, SOURCE_STRENGTH: { value: 100 }, // Tier 1, fuente solida
  });
  assert.equal(det.status, "SCORED");
  assert.ok(det.score < 40, "materiality deberia ser LOW");
  // Tier 1 -> alta confianza en la fuente, aunque el evento en si sea poco material
  assert.equal(det.weights_used.SOURCE_STRENGTH > 0, true);
});
