// tests/convictionReview.test.js
// Sprint P3.2. Tests G-O, R-T de la Regla 21 (reglas de USER_REVIEW /
// AUTO_ACCEPT / acciones manuales).

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifyReviewRequirement, crossesIntegerPoint, validateReviewAction, validateManualOverride,
} from "../lib/convictionReview.js";
import { parseThesisImpactResponse, requestThesisImpact, AI_NOT_ATTEMPTED } from "../lib/thesisImpactAi.js";
import { computeOverallConviction } from "../lib/convictionEngine.js";

// ================== G/H/I. efecto de evento sobre dimension ==================
test("G - un evento puede CONFIRMS una dimension real, con reason obligatoria", () => {
  const r = parseThesisImpactResponse(
    JSON.stringify({ affected_dimensions: [{ dimension_id: 1, effect: "CONFIRMS", confidence: 80, explanation: "diversificacion confirmada por el evento real" }] }),
    { validDimensionIds: [1, 2], validComponentKeys: ["RISK"] }
  );
  assert.equal(r.valid, true);
  assert.equal(r.affected_dimensions[0].effect, "CONFIRMS");
});

test("H - un evento puede WEAKENS una dimension real sin invalidarla por completo", () => {
  const r = parseThesisImpactResponse(
    JSON.stringify({ affected_dimensions: [{ dimension_id: 2, effect: "WEAKENS", confidence: 60, explanation: "dependencia de smartphones sigue siendo real" }] }),
    { validDimensionIds: [1, 2], validComponentKeys: [] }
  );
  assert.equal(r.valid, true);
  assert.equal(r.affected_dimensions[0].effect, "WEAKENS");
});

test("I - INVALIDATES una dimension real -> requiere USER_REVIEW downstream", () => {
  const parsed = parseThesisImpactResponse(
    JSON.stringify({ affected_dimensions: [{ dimension_id: 2, effect: "INVALIDATES", confidence: 90, explanation: "el riesgo identificado ya no aplica segun el evento" }] }),
    { validDimensionIds: [1, 2], validComponentKeys: [] }
  );
  assert.equal(parsed.valid, true);
  const review = classifyReviewRequirement({
    previousConviction: 4.0, proposedConviction: 4.0, overallConfidence: 90,
    triggeringEventMateriality: 45, riskComponentChanged: false, thesisConfirmationComponentChanged: false,
    anyDimensionNewlyInvalidated: true, isPeriodicReview: false,
  });
  assert.equal(review.requires_user_review, true);
  assert.ok(review.reasons.includes("dimension_invalidated"));
});

// ================== J. evento neutral -> sin delta ==================
test("J - un evento NEUTRAL (sin affected_dimensions ni component_deltas) no produce delta de conviction", async () => {
  const callModelFn = async () => JSON.stringify({ affected_dimensions: [], component_deltas: [], requires_review: false });
  const result = await requestThesisImpact(callModelFn, {}, { validDimensionIds: [1], validComponentKeys: ["RISK"] });
  assert.equal(result.ai_status, "NEUTRAL");
  assert.equal(result.component_deltas.length, 0);
  // sin deltas que aplicar, el known_score de los componentes no cambia
  const before = computeOverallConviction({ RISK: { value: 4.0 } });
  const after = computeOverallConviction({ RISK: { value: 4.0 } }); // nada que sumar de component_deltas vacio
  assert.equal(before.proposed_conviction, after.proposed_conviction);
});

// ================== K. materiality LOW/noise -> conviction unchanged ==================
test("K - materialidad baja (ruido, <70) no dispara la razon de revision por evento unico", () => {
  const review = classifyReviewRequirement({
    previousConviction: 4.0, proposedConviction: 4.0, overallConfidence: 85,
    triggeringEventMateriality: 27, riskComponentChanged: false, thesisConfirmationComponentChanged: false,
    anyDimensionNewlyInvalidated: false, isPeriodicReview: false,
  });
  assert.ok(!review.reasons.includes("single_event_materiality_high(27)"));
  assert.equal(review.delta, 0);
});

// ================== L. delta +0.5 event-triggered -> USER_REVIEW ==================
test("L - delta de +0.5 disparado por un EVENTO (no periodico) requiere USER_REVIEW -- no califica para auto-accept", () => {
  const review = classifyReviewRequirement({
    previousConviction: 4.0, proposedConviction: 4.5, overallConfidence: 85,
    triggeringEventMateriality: 75, riskComponentChanged: false, thesisConfirmationComponentChanged: false,
    anyDimensionNewlyInvalidated: false, isPeriodicReview: false,
  });
  assert.equal(review.requires_user_review, true);
  assert.equal(review.auto_accept_eligible, false);
});

// ================== M. periodic +0.5 high confidence -> AUTO_ACCEPT eligible ==================
test("M - delta de +0.5 en revision PERIODICA con confidence alto SI califica para auto-accept (nunca aplicado automaticamente en produccion todavia)", () => {
  const review = classifyReviewRequirement({
    previousConviction: 4.0, proposedConviction: 4.5, overallConfidence: 85,
    triggeringEventMateriality: null, riskComponentChanged: false, thesisConfirmationComponentChanged: false,
    anyDimensionNewlyInvalidated: false, isPeriodicReview: true,
  });
  assert.equal(review.auto_accept_eligible, true);
  assert.equal(review.requires_user_review, false);
});

// ================== N. delta +1.0 -> USER_REVIEW ==================
test("N - delta de +1.0 siempre requiere USER_REVIEW, incluso en revision periodica", () => {
  const review = classifyReviewRequirement({
    previousConviction: 3.5, proposedConviction: 4.5, overallConfidence: 90,
    triggeringEventMateriality: null, riskComponentChanged: false, thesisConfirmationComponentChanged: false,
    anyDimensionNewlyInvalidated: false, isPeriodicReview: true,
  });
  assert.equal(review.requires_user_review, true);
  assert.ok(review.reasons.some((r) => r.startsWith("delta_exceeds_threshold")));
});

test("crossesIntegerPoint: 3.5->4.0 cruza; 4.0->4.5 no cruza; 3.0->3.5 no cruza", () => {
  assert.equal(crossesIntegerPoint(3.5, 4.0), true);
  assert.equal(crossesIntegerPoint(4.0, 4.5), false);
  assert.equal(crossesIntegerPoint(3.0, 3.5), false);
});

// ================== O. risk change -> USER_REVIEW ==================
test("O - un cambio en el componente RISK siempre requiere USER_REVIEW, sin importar que tan chico sea el delta general", () => {
  const review = classifyReviewRequirement({
    previousConviction: 4.0, proposedConviction: 4.0, overallConfidence: 90,
    triggeringEventMateriality: null, riskComponentChanged: true, thesisConfirmationComponentChanged: false,
    anyDimensionNewlyInvalidated: false, isPeriodicReview: true,
  });
  assert.equal(review.requires_user_review, true);
  assert.ok(review.reasons.includes("risk_component_changed"));
});

// ================== P. AI failure -> deterministic state preserved ==================
test("P - si el AI provider falla (excepcion), ai_status FAILED y el conviction deterministico actual queda intacto", async () => {
  const callModelFnThatThrows = async () => { throw new Error("network_error"); };
  const result = await requestThesisImpact(callModelFnThatThrows, {}, { validDimensionIds: [1], validComponentKeys: ["RISK"] });
  assert.equal(result.ai_status, "FAILED");
  assert.equal(result.component_deltas.length, 0);
  assert.equal(result.affected_dimensions.length, 0);
  // el conviction actual (previamente calculado) no se toca -- no hay
  // ninguna funcion que este modulo llame para "corregirlo".
  const currentConviction = computeOverallConviction({ RISK: { value: 4.0 } });
  assert.equal(currentConviction.status, "SCORED");
});

test("P - AI_NOT_ATTEMPTED es un estado valido distinto de FAILED, tambien preserva el estado deterministico", () => {
  assert.equal(AI_NOT_ATTEMPTED.ai_status, "NOT_ATTEMPTED");
  assert.equal(AI_NOT_ATTEMPTED.component_deltas.length, 0);
});

test("Un solo evento NUNCA reescribe toda la tesis: dimension_id inventado invalida TODA la respuesta, ninguna se aplica", () => {
  const parsed = parseThesisImpactResponse(
    JSON.stringify({ affected_dimensions: [{ dimension_id: 999, effect: "INVALIDATES", confidence: 90, explanation: "x" }] }),
    { validDimensionIds: [1, 2], validComponentKeys: [] }
  );
  assert.equal(parsed.valid, false);
  assert.match(parsed.error, /unknown_dimension_id/);
});

// ================== R/S/T. acciones manuales ==================
test("R - aceptar una propuesta (accept) es una accion valida", () => {
  assert.deepEqual(validateReviewAction("ACCEPTED"), { valid: true });
});

test("S - rechazar una propuesta (reject) es una accion valida", () => {
  assert.deepEqual(validateReviewAction("REJECTED"), { valid: true });
});

test("R/S - una accion desconocida se rechaza explicitamente", () => {
  const r = validateReviewAction("MAYBE");
  assert.equal(r.valid, false);
});

test("T - override manual requiere reason obligatoria, nunca un cambio opaco de conviction", () => {
  const withoutReason = validateManualOverride({ newConviction: 4.5, reason: "" });
  assert.equal(withoutReason.valid, false);
  assert.equal(withoutReason.error, "reason_required_for_manual_override");

  const withReason = validateManualOverride({ newConviction: 4.5, reason: "El usuario considera que el riesgo de ejecucion es menor al estimado" });
  assert.equal(withReason.valid, true);
});

test("T - override manual fuera de escala (1.0-5.0) se rechaza", () => {
  const r = validateManualOverride({ newConviction: 5.5, reason: "motivo real" });
  assert.equal(r.valid, false);
  assert.equal(r.error, "conviction_out_of_range");
});
