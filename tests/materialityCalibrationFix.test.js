// tests/materialityCalibrationFix.test.js
// Micro-sprint P3.1B.2 (Materiality Calibration Fix). Tests A-O
// exigidos explicitamente por la Regla 14 del sprint -- usan los
// mismos casos conceptuales (A-E) y numeros que el reporte de
// calibracion, para que cada afirmacion del reporte sea verificable
// aqui letra por letra. No reemplaza los tests ya existentes en
// tests/materialityEngine.test.js (que cubren los mismos mecanismos
// con otros ejemplos) -- este archivo es la referencia 1:1 con la
// Regla 14 del sprint.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  computeFinancialScale, computeStrategicRelevance, computeTimelineUrgency,
  computeSourceStrength, computeEntityRelevance, computeDeterministicScore,
  classifyPortfolioRelevance, UNKNOWN,
} from "../lib/materialityEngine.js";
import { requestAiAdjustment, AI_NOT_ATTEMPTED } from "../lib/materialityAiAdjustment.js";
import { computeFinalMateriality } from "../lib/materialityFormula.js";
import { tagsFromText } from "../lib/canonicalThemeTags.js";

// ================== A. full evidence -> comportamiento esperado ==================
test("A - 4/4 componentes conocidos: coverage=1, score final identico al known_score (cero cambio de comportamiento)", () => {
  const r = computeDeterministicScore({
    FINANCIAL_SCALE: { value: 62 }, STRATEGIC_RELEVANCE: { value: 60 },
    TIMELINE_URGENCY: { value: 45 }, SOURCE_STRENGTH: { value: 50 },
  });
  assert.equal(r.status, "SCORED");
  assert.equal(r.coverage, 1);
  assert.equal(r.score, r.known_score);
});

// ================== B. 50% coverage + signals debiles -> NO medium automatico ==================
// Caso B exacto del sprint: STRATEGIC=40 + SOURCE=50 conocidos
// (exactamente lo que ocurria en 8/9 eventos de ruido real de
// P3.1B.1). known_score=45 (identico al bug viejo), pero el score
// FINAL con coverage=0.5 ya no llega a MEDIUM.
test("B - Strategic=40 + Source=50 (coverage=0.5): known_score=45 pero el score final NO es automaticamente MEDIUM", () => {
  const r = computeDeterministicScore({
    STRATEGIC_RELEVANCE: { value: 40 }, SOURCE_STRENGTH: { value: 50 },
  });
  assert.equal(r.coverage, 0.5);
  assert.equal(r.known_score, 45);
  assert.ok(r.score < 40, `score deberia caer en LOW (<40), obtuvo ${r.score}`);
});

// ================== C. Financial=95 + Source=100 -> sigue pudiendo ser material ==================
test("C - Financial=95 + Source=100 (coverage=0.60): la falta de timeline NO castiga tanto que un filing financieramente enorme termine LOW", () => {
  const r = computeDeterministicScore({
    FINANCIAL_SCALE: { value: 95 }, SOURCE_STRENGTH: { value: 100 },
  });
  assert.equal(r.coverage, 0.6);
  assert.ok(r.score >= 40, `deberia seguir siendo material (>=40), obtuvo ${r.score}`);
});

// ================== D. solo Source=100 conocido -> nunca HIGH ==================
test("D - solo Source=100 conocido (coverage=0.25): una sola señal, aunque maxima, nunca se convierte en HIGH por si sola", () => {
  const r = computeDeterministicScore({ SOURCE_STRENGTH: { value: 100 } });
  assert.equal(r.coverage, 0.25);
  assert.equal(r.known_score, 100);
  assert.ok(r.score < 70, `no deberia llegar a HIGH (>=70), obtuvo ${r.score}`);
});

// ================== E. todos UNKNOWN -> DATA_UNAVAILABLE ==================
test("E - los 4 componentes UNKNOWN -> DATA_UNAVAILABLE, nunca un score de 0", () => {
  const r = computeDeterministicScore({
    FINANCIAL_SCALE: { value: UNKNOWN }, STRATEGIC_RELEVANCE: { value: UNKNOWN },
    TIMELINE_URGENCY: { value: UNKNOWN }, SOURCE_STRENGTH: { value: UNKNOWN },
  });
  assert.equal(r.status, "DATA_UNAVAILABLE");
  assert.equal(r.score, null);
  assert.notEqual(r.score, 0);
});

// ================== F. earnings 250 dias atras -> urgency LOW ==================
test("F - EARNINGS de hace ~250 dias -> TIMELINE_URGENCY baja (disclosure decay), nunca el 100 fijo del bug viejo", () => {
  const r = computeTimelineUrgency("EARNINGS", { earnings_date: "2025-12-31" }, "2026-09-08T00:00:00Z");
  assert.equal(r.bucket, "STALE_DISCLOSURE");
  assert.ok(r.value <= 20);
});

// ================== G. fresh filing immediate effect -> urgency HIGH ==================
test("G - filing con effective_date HOY (efecto inmediato) -> TIMELINE_URGENCY alta (deadline proximity, IMMINENT/JUST_CROSSED)", () => {
  const r = computeTimelineUrgency("REGULATORY_LEGAL", { regulatory_deadline: "2026-09-08" }, "2026-09-09T00:00:00Z");
  assert.ok(["IMMINENT", "JUST_CROSSED"].includes(r.bucket));
  assert.ok(r.value >= 90);
});

// ================== H. fresh contract long-dated -> freshness HIGH / urgency menor ==================
test("H - contrato anunciado hoy pero que inicia en 18 meses -> TIMELINE_URGENCY baja/media (freshness es un eje SEPARADO, no calculado aqui)", () => {
  const r = computeTimelineUrgency("MAJOR_CONTRACT", { effective_date: "2028-03-09" }, "2026-09-09T00:00:00Z");
  assert.ok(r.value <= 45, `contrato a 18 meses deberia tener urgencia baja/media, obtuvo ${r.value}`);
  assert.equal(r.bucket, "DISTANT_FUTURE");
});

// ================== I. portfolio ownership NO aumenta company materiality ==================
test("I - STRATEGIC_RELEVANCE (company) es identico con y sin isActivePosition/conviction en el contexto -- esos campos se ignoran", () => {
  const facts = { headline_raw: "titular neutro sin relacion tematica" };
  const withOwnership = computeStrategicRelevance(facts, { tema: "Energia", isActivePosition: true, conviction: 5 });
  const withoutOwnership = computeStrategicRelevance(facts, { tema: "Energia" });
  assert.deepEqual(withOwnership, withoutOwnership);
});

// ================== J. portfolio ownership SI aumenta portfolio relevance ==================
test("J - classifyPortfolioRelevance (portfolio, funcion SEPARADA) SI depende de isActivePosition/conviction -- esa es la dimension correcta para ownership", () => {
  const owned = classifyPortfolioRelevance({ isActivePosition: true, conviction: 5 });
  const notOwned = classifyPortfolioRelevance({ isActivePosition: false, conviction: 5 });
  assert.equal(owned.level, "HIGH");
  assert.equal(notOwned.level, "LOW");
});

// ================== K. provider ticker noise -> entity relevance degradada ==================
test("K - headline que NO menciona ni el ticker ni el nombre real de la empresa -> LOW_ENTITY_CONFIDENCE + requires_review (caso real: articulo de Super Micro Computer etiquetado a AMD)", () => {
  const r = computeEntityRelevance("AMD", "Advanced Micro Devices", { headline_raw: "Super Micro Computer Sees AI Demand Driving Growth, Diversification and Cash Flow" });
  assert.equal(r.level, "LOW_ENTITY_CONFIDENCE");
  assert.equal(r.requires_review, true);
});

test("K - headline que SI menciona el ticker -> HIGH, nunca degradado sin razon", () => {
  const r = computeEntityRelevance("AMD", "Advanced Micro Devices", { headline_raw: "AMD Reaffirms TSMC Ties Amid Intel Foundry Buzz" });
  assert.equal(r.level, "HIGH");
});

test("K - headline que menciona el nombre real de la empresa pero no el ticker -> HIGH (fallback por nombre)", () => {
  const r = computeEntityRelevance("QCOM", "Qualcomm Inc", { headline_raw: "Intel, Amkor, Nova, Qualcomm, and FormFactor Stocks Trade Up" });
  assert.equal(r.level, "HIGH");
});

test("K - una palabra generica compartida (ej. 'Micro') NUNCA produce un match falso -- se exige la frase completa del nombre, no palabras sueltas", () => {
  const r = computeEntityRelevance("AMD", "Advanced Micro Devices", { headline_raw: "Micro-cap stocks rally today across the board" });
  assert.equal(r.level, "LOW_ENTITY_CONFIDENCE", "'Micro' suelto no debe matchear 'Advanced Micro Devices' como frase");
});

test("K - LOW_ENTITY_CONFIDENCE degrada la cobertura efectiva del score final (no solo un flag cosmetico)", () => {
  const withGoodEntity = computeDeterministicScore(
    { STRATEGIC_RELEVANCE: { value: 40 }, SOURCE_STRENGTH: { value: 50 } },
    { entityRelevanceLevel: "HIGH" }
  );
  const withBadEntity = computeDeterministicScore(
    { STRATEGIC_RELEVANCE: { value: 40 }, SOURCE_STRENGTH: { value: 50 } },
    { entityRelevanceLevel: "LOW_ENTITY_CONFIDENCE" }
  );
  assert.equal(withGoodEntity.known_score, withBadEntity.known_score, "known_score no cambia -- la degradacion es solo en el score final via coverage");
  assert.ok(withBadEntity.score < withGoodEntity.score);
  assert.equal(withBadEntity.entity_relevance_penalty_applied, true);
  assert.equal(withGoodEntity.entity_relevance_penalty_applied, false);
});

test("K - eventos estructurados (sin headline, ej. EARNINGS) nunca sufren el riesgo de ticker noise -- HIGH por construccion", () => {
  const r = computeEntityRelevance("AMD", "Advanced Micro Devices", { eps_actual: 1.53, eps_estimated: 1.3324 });
  assert.equal(r.level, "HIGH");
  assert.equal(r.reason, "structured_source_no_headline_ambiguity");
});

// ================== L. canonical tags cross-language sigue pasando ==================
test("L - fix de idioma (P3.1B.1) sigue intacto tras la calibracion: 'Energia' (es) y 'energy' (en) resuelven al mismo tag", () => {
  assert.deepEqual(tagsFromText("Energia"), ["ENERGY"]);
  assert.deepEqual(tagsFromText("The energy sector rallied today"), ["ENERGY"]);
});

// ================== M. AI neutral conserva deterministic ==================
test("M - AI adjustment NEUTRAL (0) conserva el score deterministico exacto", async () => {
  const det = { status: "SCORED", score: 42 };
  const callModelFn = async () => JSON.stringify({ adjustment: 0, reason: null, interpretation: "score ya parece razonable" });
  const aiResult = await requestAiAdjustment(callModelFn, {});
  assert.equal(aiResult.ai_status, "NEUTRAL");
  assert.equal(aiResult.adjustment, 0);
  assert.equal(computeFinalMateriality(det.score, aiResult.adjustment), det.score);
});

// ================== N. AI failure conserva deterministic ==================
test("N - AI adjustment FAILED (JSON invalido) conserva el score deterministico exacto", async () => {
  const det = { status: "SCORED", score: 58 };
  const callModelFn = async () => "esto no es JSON valido";
  const aiResult = await requestAiAdjustment(callModelFn, {});
  assert.equal(aiResult.ai_status, "FAILED");
  assert.equal(aiResult.adjustment, 0);
  assert.equal(computeFinalMateriality(det.score, aiResult.adjustment), det.score);
});

// ================== O. OLD vs NEW scores reproducibles ==================
test("O - computeDeterministicScore (formula P3.1B.2) es determinista: mismos inputs -> exactamente el mismo score, siempre", () => {
  const components = {
    FINANCIAL_SCALE: { value: 59 }, STRATEGIC_RELEVANCE: { value: 40 },
    TIMELINE_URGENCY: { value: 15 }, SOURCE_STRENGTH: { value: 50 },
  };
  const runs = [1, 2, 3, 4, 5].map(() => computeDeterministicScore(JSON.parse(JSON.stringify(components))));
  for (const r of runs) assert.deepEqual(r, runs[0]);
});
