// tests/reviewDecisionGate.test.js
// Micro-sprint P3.2.1. Regresion del bug real encontrado en la corrida
// en vivo de validacion (QCOM/AMD/ANET/VRT, 2026-09-09): los 4 activos
// reales tuvieron requires_user_review=true y
// recommendation_status=PROPOSED_CHANGE, pero decision_id quedo null
// en los 4 porque la condicion original exigia events.length>0 --
// ninguno tuvo eventos nuevos en esa corrida (solo evidencia
// fundamental). shouldCreateReviewDecision() es la version corregida:
// "hay evidencia nueva de cualquier tipo" (evento O fundamental
// aplicado), no "hubo un evento".

import { test } from "node:test";
import assert from "node:assert/strict";
import { shouldCreateReviewDecision } from "../lib/convictionReview.js";

test("REGRESION: sin eventos nuevos pero con fundamentales aplicados + review requerido + PROPOSED_CHANGE -> SI crea decision (caso real QCOM 3->4)", () => {
  const r = shouldCreateReviewDecision({
    hasNewEvidenceThisRun: true, // events.length===0 pero fundamentalsApplied.length>0
    requiresUserReview: true, recommendationStatus: "PROPOSED_CHANGE",
  });
  assert.equal(r, true);
});

test("sin evidencia nueva de ningun tipo (ni eventos ni fundamentales) -> nunca crea decision aunque requires_user_review sea true", () => {
  const r = shouldCreateReviewDecision({
    hasNewEvidenceThisRun: false, requiresUserReview: true, recommendationStatus: "PROPOSED_CHANGE",
  });
  assert.equal(r, false);
});

test("evidencia nueva presente pero requires_user_review=false -> no crea decision (no amerita revision)", () => {
  const r = shouldCreateReviewDecision({
    hasNewEvidenceThisRun: true, requiresUserReview: false, recommendationStatus: "PROPOSED_CHANGE",
  });
  assert.equal(r, false);
});

test("LOW COVERAGE GUARD: evidencia nueva + requires_user_review=true pero recommendation_status=INSUFFICIENT_EVIDENCE_FOR_CHANGE -> nunca crea decision", () => {
  const r = shouldCreateReviewDecision({
    hasNewEvidenceThisRun: true, requiresUserReview: true, recommendationStatus: "INSUFFICIENT_EVIDENCE_FOR_CHANGE",
  });
  assert.equal(r, false);
});

test("recommendation_status=NO_CHANGE -> nunca crea decision aunque haya evidencia nueva", () => {
  const r = shouldCreateReviewDecision({
    hasNewEvidenceThisRun: true, requiresUserReview: true, recommendationStatus: "NO_CHANGE",
  });
  assert.equal(r, false);
});

test("evento interpretado (sin fundamentales nuevos) sigue disparando decision igual que antes -- no se rompio el caso original de P3.2", () => {
  const r = shouldCreateReviewDecision({
    hasNewEvidenceThisRun: true, // events.length>0, fundamentalsApplied.length pudo ser 0
    requiresUserReview: true, recommendationStatus: "PROPOSED_CHANGE",
  });
  assert.equal(r, true);
});
