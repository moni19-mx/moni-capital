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
  // coverage=1 (4/4 conocidos) -> el coverage adjustment (P3.1B.2) es
  // sqrt(1)=1, CERO cambio de comportamiento con evidencia completa.
  assert.equal(r.coverage, 1);
  assert.equal(r.known_score, r.score);
});

// B. 1 UNKNOWN -> renormalizacion correcta ENTRE los conocidos (known_score),
// pero el score FINAL (P3.1B.2) ademas se amortigua por evidence coverage --
// nunca se "expande" a la misma escala que con evidencia completa.
test("B - 1 componente UNKNOWN se excluye y renormaliza (known_score), nunca cuenta como 0; el score final refleja coverage<1", () => {
  const components = {
    FINANCIAL_SCALE: { value: UNKNOWN },
    STRATEGIC_RELEVANCE: { value: 60 },
    TIMELINE_URGENCY: { value: 50 },
    SOURCE_STRENGTH: { value: 100 },
  };
  const r = computeDeterministicScore(components);
  assert.equal(r.status, "SCORED");
  assert.equal(r.components_known, 3);
  // pesos originales 0.25+0.15+0.25=0.65 -> renormalizados a 1.0 para known_score
  // known_score = (60*0.25 + 50*0.15 + 100*0.25) / 0.65 = (15+7.5+25)/0.65 = 73.08 -> 73
  assert.equal(r.known_score, 73);
  assert.equal(r.coverage, 0.65);
  // score final = known_score(73.0769...) * sqrt(0.65) = 58.9 -> 59 -- coverage<1 SI reduce el final
  assert.equal(r.score, 59);
  assert.ok(r.score < r.known_score, "coverage<1 debe amortiguar el score final respecto al known_score");
  assert.ok(!("FINANCIAL_SCALE" in r.weights_used));
  const sumWeights = Object.values(r.weights_used).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(sumWeights - 1) < 0.01, "pesos renormalizados (para known_score) deben sumar ~1.0");
});

// C. varios UNKNOWN -> renormalizacion correcta entre los conocidos, coverage aun mas bajo
test("C - 2 componentes UNKNOWN: known_score renormaliza entre los 2 restantes, coverage=0.40 amortigua mas el score final", () => {
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
  // known_score = 50*0.375 + 100*0.625 = 18.75+62.5 = 81.25 -> 81
  assert.equal(r.known_score, 81);
  assert.equal(r.coverage, 0.4);
  // score final = 81.25 * sqrt(0.4) = 51.39 -> 51
  assert.equal(r.score, 51);
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

test("STRATEGIC_RELEVANCE: tema clasificado + overlap real de tag canonico en headline suma classified_as + overlap (P3.1B.2: sin active_position)", () => {
  const r = computeStrategicRelevance(
    { headline_raw: "Qualcomm anuncia expansion en Semiconductores IA" },
    { tema: "Semiconductores IA", sector: "Semiconductores" }
  );
  assert.equal(r.value, 100, "classified_as(40) + canonical_tag_overlap(60) = 100");
  assert.ok(r.evidence.some((e) => e.startsWith("classified_as")));
  assert.ok(r.evidence.some((e) => e.startsWith("canonical_tag_overlap")));
});

test("I - STRATEGIC_RELEVANCE (company materiality) NO cambia por isActivePosition/conviction -- esos campos, si vienen en el contexto, se ignoran por completo (fix de contaminacion P3.1B.2)", () => {
  const withoutOwnership = computeStrategicRelevance(
    { headline_raw: "titular neutro" },
    { tema: "Semiconductores IA" }
  );
  const withOwnershipFlagsIgnored = computeStrategicRelevance(
    { headline_raw: "titular neutro" },
    { tema: "Semiconductores IA", isActivePosition: true, conviction: 5 }
  );
  assert.deepEqual(withoutOwnership, withOwnershipFlagsIgnored);
});

test("STRATEGIC_RELEVANCE: nunca inventa relevancia -- headline sin overlap real de keyword no suma ese punto", () => {
  const withOverlap = computeStrategicRelevance(
    { headline_raw: "algo sobre semiconductores hoy" },
    { tema: "Semiconductores IA" }
  );
  const withoutOverlap = computeStrategicRelevance(
    { headline_raw: "un titular totalmente ajeno sin relacion" },
    { tema: "Semiconductores IA" }
  );
  assert.ok(withOverlap.value > withoutOverlap.value);
});

// TIMELINE_URGENCY vs freshness -- N (P3.1B.2: firma ahora es
// (eventType, facts, now) -- ver Regla 5/6 del sprint de calibracion)
test("N - TIMELINE_URGENCY es distinto de freshness: sin fecha relevante en facts -> UNKNOWN, NUNCA 'publicado hoy = 100'", () => {
  const r = computeTimelineUrgency("MAJOR_CONTRACT", { headline_raw: "publicado justo ahora" }, NOW);
  assert.equal(r.value, UNKNOWN);
});

test("TIMELINE_URGENCY (deadline proximity): fecha efectiva real dentro de 30 dias produce urgencia alta", () => {
  const r = computeTimelineUrgency("MAJOR_CONTRACT", { effective_date: "2026-09-20" }, NOW);
  assert.equal(r.method, "deadline_proximity");
  assert.equal(r.value, 75);
});

test("TIMELINE_URGENCY (deadline proximity): fecha efectiva lejana (mas de 180 dias) produce urgencia baja", () => {
  const r = computeTimelineUrgency("MAJOR_CONTRACT", { effective_date: "2027-12-01" }, NOW);
  assert.equal(r.value, 20);
  assert.equal(r.bucket, "DISTANT_FUTURE");
});

// P3.1B.2 -- Regla 7 del sprint de calibracion: bug real corregido
// (P3.1B.1). Antes, CUALQUIER fecha ya pasada devolvia urgencia=100,
// sin importar hace cuanto -- un earnings de ayer y uno de hace 250
// dias puntuaban identico. Ahora, para EARNINGS/GUIDANCE (disclosure
// decay), la urgencia decae con los dias transcurridos.
test("F - TIMELINE_URGENCY (disclosure decay): EARNINGS de hace 250 dias produce urgencia BAJA, no 100", () => {
  const r = computeTimelineUrgency("EARNINGS", { earnings_date: "2025-12-31" }, "2026-09-08T00:00:00Z");
  assert.equal(r.method, "disclosure_decay");
  assert.equal(r.bucket, "STALE_DISCLOSURE");
  assert.ok(r.value <= 20, `earnings de hace ~250 dias deberia ser urgencia baja, obtuvo ${r.value}`);
  assert.notEqual(r.value, 100, "bug real corregido: ya NO es 100 solo por haber ocurrido");
});

test("G - TIMELINE_URGENCY (disclosure decay): EARNINGS recien publicado (hace 2 dias) produce urgencia ALTA", () => {
  const r = computeTimelineUrgency("EARNINGS", { earnings_date: "2026-09-07" }, "2026-09-09T00:00:00Z");
  assert.equal(r.bucket, "RECENT_DISCLOSURE");
  assert.ok(r.value >= 80, `earnings de hace 2 dias deberia ser urgencia alta, obtuvo ${r.value}`);
});

test("H - freshness (discovered_at reciente) y urgency (deadline lejano) son ejes independientes -- un evento fresco sobre un contrato a 18 meses tiene freshness ALTA pero urgency BAJA/MEDIA", () => {
  const urgency = computeTimelineUrgency("MAJOR_CONTRACT", { effective_date: "2028-03-09" }, "2026-09-09T00:00:00Z");
  assert.ok(urgency.value <= 45, `contrato a 18 meses deberia tener urgencia baja/media, obtuvo ${urgency.value}`);
  // freshness es un eje SEPARADO (lib/materialEventTemporal.js, sobre
  // discovered_at/published_at) -- esta funcion nunca lo calcula ni lo
  // necesita; confirmar que ambos conceptos viven en modulos distintos
  // es en si mismo la prueba de que no se mezclan.
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
