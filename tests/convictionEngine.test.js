// tests/convictionEngine.test.js
// Sprint P3.2 (Thesis / Conviction Engine 2.0). Tests A-F de la Regla 21.

import { test } from "node:test";
import assert from "node:assert/strict";
import { computeOverallConviction, computeConvictionConfidence, roundToConvictionStep, applyComponentDeltas, UNKNOWN } from "../lib/convictionEngine.js";
import { CONVICTION_WEIGHTS, CONVICTION_ENGINE_VERSION, CONVICTION_SCORING_POLICY_VERSION, CONVICTION_CONFIDENCE_POLICY_VERSION, REVIEW_POLICY_VERSION } from "../lib/thesisConvictionVersioning.js";

test("pesos: los 9 componentes (Portfolio Fit ya removido) suman exactamente 1.0", () => {
  const sum = Object.values(CONVICTION_WEIGHTS).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(sum - 1) < 1e-9, `suma real: ${sum}`);
  assert.equal(Object.keys(CONVICTION_WEIGHTS).length, 9);
  assert.ok(!("PORTFOLIO_FIT" in CONVICTION_WEIGHTS), "Portfolio Fit no debe existir como componente de conviction");
});

// ================== A. full coverage ==================
test("A - 9/9 componentes conocidos: coverage=1, proposed_conviction = known_score exacto (redondeado al paso 0.5)", () => {
  const components = {
    BUSINESS_QUALITY: { value: 4.5 }, GROWTH_TAM: { value: 5.0 }, VALUATION: { value: 3.5 },
    COMPETITIVE_POSITION: { value: 4.5 }, EXECUTION: { value: 4.0 }, FINANCIAL_STRENGTH: { value: 4.0 },
    CATALYSTS: { value: 4.5 }, THESIS_CONFIRMATION: { value: 4.5 }, RISK: { value: 4.0 },
  };
  const r = computeOverallConviction(components);
  assert.equal(r.status, "SCORED");
  assert.equal(r.coverage, 1);
  assert.equal(r.components_known, 9);
  assert.equal(r.proposed_conviction, r.known_score === 4.5 ? 4.5 : roundToConvictionStep(r.known_score));
  assert.ok(r.proposed_conviction >= 1.0 && r.proposed_conviction <= 5.0);
});

// ================== B. partial coverage ==================
test("B - 5/9 componentes conocidos: coverage entre 0 y 1, proposed_conviction distinto del known_score (amortiguado)", () => {
  const components = {
    BUSINESS_QUALITY: { value: 4.5 }, GROWTH_TAM: { value: 4.5 }, VALUATION: { value: 4.0 },
    CATALYSTS: { value: 4.0 }, RISK: { value: 4.0 },
  };
  const r = computeOverallConviction(components);
  assert.equal(r.status, "SCORED");
  assert.ok(r.coverage > 0 && r.coverage < 1);
  assert.equal(r.components_known, 5);
  assert.notEqual(r.proposed_conviction, r.known_score, "con coverage<1 el score final debe diferir del known_score");
  assert.ok(r.proposed_conviction < r.known_score, "shrinkage hacia el neutral(3.0) debe bajar un known_score alto (~4.2)");
});

// ================== C. low coverage no produce falsa alta conviction ==================
test("C - solo 2 componentes conocidos, ambos en el maximo (5.0): NO produce conviction 4.5/5.0 falsa", () => {
  const components = { BUSINESS_QUALITY: { value: 5.0 }, VALUATION: { value: 5.0 } };
  const r = computeOverallConviction(components);
  assert.equal(r.known_score, 5.0);
  assert.ok(r.coverage < 0.30, `coverage real: ${r.coverage}`);
  assert.ok(r.proposed_conviction <= 4.0, `2 señales perfectas con baja coverage no deberian superar ~4.0, obtuvo ${r.proposed_conviction}`);
  assert.ok(r.proposed_conviction > 3.0, "sigue siendo una señal positiva real, no colapsa a neutral puro");
});

test("C - solo 1 componente conocido (RISK=5.0, el mejor posible): nunca produce conviction 5.0 por si solo", () => {
  const r = computeOverallConviction({ RISK: { value: 5.0 } });
  assert.equal(r.known_score, 5.0);
  assert.ok(r.proposed_conviction < 5.0, `una sola señal maxima no deberia bastar para conviction 5.0, obtuvo ${r.proposed_conviction}`);
});

// ================== D. all UNKNOWN -> DATA_UNAVAILABLE ==================
test("D - los 9 componentes UNKNOWN -> DATA_UNAVAILABLE, nunca conviction 3.0 (neutral) como si fuera una evaluacion real", () => {
  const components = Object.fromEntries(Object.keys(CONVICTION_WEIGHTS).map((k) => [k, { value: UNKNOWN }]));
  const r = computeOverallConviction(components);
  assert.equal(r.status, "DATA_UNAVAILABLE");
  assert.equal(r.proposed_conviction, null);
  assert.notEqual(r.proposed_conviction, 3.0, "DATA_UNAVAILABLE nunca debe verse identico a 'evaluamos y es neutral'");
});

// ================== E. component evidence required ==================
test("E - sin evidence_refs citados (sourceTierScores vacio), source_confidence es 0 real, nunca inventado", () => {
  const conf = computeConvictionConfidence({ sourceTierScores: [], coverage: 0.5, oldestUpdatedAtDaysAgo: 10, invalidatedDimensionsReferenced: 0 });
  assert.equal(conf.source_confidence, 0);
});

test("E - con evidence_refs reales citados (tier scores conocidos), source_confidence refleja el promedio real", () => {
  const conf = computeConvictionConfidence({ sourceTierScores: [100, 50], coverage: 0.5, oldestUpdatedAtDaysAgo: 10, invalidatedDimensionsReferenced: 0 });
  assert.equal(conf.source_confidence, 75);
});

// ================== F. confidence separado del score ==================
test("F - Conviction alto (known_score/coverage=1) puede coexistir con confidence bajo -- ejes independientes, nunca mezclados en un numero", () => {
  const conviction = computeOverallConviction({
    BUSINESS_QUALITY: { value: 4.5 }, GROWTH_TAM: { value: 4.5 }, VALUATION: { value: 4.5 },
    COMPETITIVE_POSITION: { value: 4.5 }, EXECUTION: { value: 4.5 }, FINANCIAL_STRENGTH: { value: 4.5 },
    CATALYSTS: { value: 4.5 }, THESIS_CONFIRMATION: { value: 4.5 }, RISK: { value: 4.5 },
  });
  const confidence = computeConvictionConfidence({ sourceTierScores: [25], coverage: conviction.coverage, oldestUpdatedAtDaysAgo: 400, invalidatedDimensionsReferenced: 1 });
  assert.equal(conviction.proposed_conviction, 4.5);
  assert.ok(confidence.overall_confidence < 60, `confidence deberia ser bajo pese al conviction alto, obtuvo ${confidence.overall_confidence}`);
});

// ================== U. policy versioning ==================
test("U - todas las versiones de policy de conviction estan definidas y son strings no vacios", () => {
  for (const v of [CONVICTION_ENGINE_VERSION, CONVICTION_SCORING_POLICY_VERSION, CONVICTION_CONFIDENCE_POLICY_VERSION, REVIEW_POLICY_VERSION]) {
    assert.equal(typeof v, "string");
    assert.ok(v.length > 0);
  }
});

test("applyComponentDeltas: un componente previamente UNKNOWN que recibe delta arranca desde el neutral(3.0), nunca desde 0", () => {
  const result = applyComponentDeltas({}, [{ component: "RISK", delta: 0.5 }]);
  assert.equal(result.RISK.value, 3.5);
  assert.equal(result.RISK.method, "ai_delta_from_neutral_anchor");
});

test("applyComponentDeltas: un componente conocido se ajusta desde su valor real, clamped a [1.0, 5.0]", () => {
  const result = applyComponentDeltas({ RISK: { value: 4.7 } }, [{ component: "RISK", delta: 1.0 }]);
  assert.equal(result.RISK.value, 5.0, "1.0+4.7 excede 5.0, debe recortarse");
});

test("applyComponentDeltas: un componente sin delta propuesto permanece exactamente igual (UNKNOWN sigue UNKNOWN)", () => {
  const previous = { RISK: { value: 4.0 } };
  const result = applyComponentDeltas(previous, [{ component: "GROWTH_TAM", delta: 0.5 }]);
  assert.equal(result.RISK.value, 4.0);
  assert.equal(result.GROWTH_TAM.value, 3.5);
  assert.equal(result.BUSINESS_QUALITY, undefined, "sin delta ni valor previo, sigue sin existir (UNKNOWN implicito)");
});

test("O - computeOverallConviction es puro y reproducible: mismos inputs -> mismo resultado siempre", () => {
  const components = { BUSINESS_QUALITY: { value: 3.5 }, RISK: { value: 4.0 }, CATALYSTS: { value: 3.0 } };
  const r1 = computeOverallConviction(components);
  const r2 = computeOverallConviction(JSON.parse(JSON.stringify(components)));
  assert.deepEqual(r1, r2);
});
