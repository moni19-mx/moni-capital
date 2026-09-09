// lib/convictionReview.js
// Sprint P3.2 (Thesis / Conviction Engine 2.0). Reglas deterministicas
// de USER_REVIEW/AUTO_ACCEPT (seccion 12 del sprint) -- CERO LLM.
// P3.2 nunca aplica un cambio de conviction automaticamente en
// produccion (eso queda para un sprint futuro que audite el workflow
// real) -- esta funcion solo CLASIFICA si una propuesta calificaria
// para auto-accept, el llamador siempre persiste status='PENDING'.

import { REVIEW_THRESHOLDS, CONVICTION_SCALE_MIN, CONVICTION_SCALE_MAX } from "./thesisConvictionVersioning.js";

function isNum(v) {
  return typeof v === "number" && !Number.isNaN(v);
}

// Cruza un "punto entero" (una estrella completa en la UI existente)
// si existe un entero N tal que min(prev,proposed) < N <= max(prev,proposed).
// 3.5->4.0 cruza (N=4). 4.0->4.5 NO cruza. 3.0->3.5 NO cruza.
export function crossesIntegerPoint(previous, proposed) {
  if (previous == null || proposed == null) return false;
  const lo = Math.min(previous, proposed);
  const hi = Math.max(previous, proposed);
  return Math.ceil(lo + 1e-9) <= hi;
}

// Todas las razones de USER_REVIEW obligatorio, evaluadas de forma
// independiente -- cualquiera de ellas basta, nunca se "promedian".
export function classifyReviewRequirement({
  previousConviction, proposedConviction, overallConfidence,
  triggeringEventMateriality, riskComponentChanged, thesisConfirmationComponentChanged,
  anyDimensionNewlyInvalidated, isPeriodicReview,
}) {
  const reasons = [];
  const delta = (previousConviction != null && proposedConviction != null) ? Math.round((proposedConviction - previousConviction) * 100) / 100 : null;

  if (delta != null && Math.abs(delta) > REVIEW_THRESHOLDS.deltaRequiresReview) reasons.push(`delta_exceeds_threshold(${delta})`);
  if (crossesIntegerPoint(previousConviction, proposedConviction)) reasons.push("crosses_integer_point");
  if (isNum(triggeringEventMateriality) && triggeringEventMateriality >= REVIEW_THRESHOLDS.triggeringEventMaterialityThreshold) {
    reasons.push(`single_event_materiality_high(${triggeringEventMateriality})`);
  }
  if (isNum(overallConfidence) && overallConfidence < REVIEW_THRESHOLDS.minConfidenceForAutoAccept) reasons.push(`confidence_below_threshold(${overallConfidence})`);
  if (riskComponentChanged) reasons.push("risk_component_changed");
  if (thesisConfirmationComponentChanged) reasons.push("thesis_confirmation_component_changed");
  if (anyDimensionNewlyInvalidated) reasons.push("dimension_invalidated");

  if (reasons.length > 0) {
    return { requires_user_review: true, auto_accept_eligible: false, delta, reasons };
  }

  // AUTO_ACCEPT SOLO para revision periodica (nunca disparada por un
  // evento unico), delta pequeño, y confidence alto -- ninguna de las
  // razones anteriores presente.
  const autoAcceptEligible = isPeriodicReview === true
    && delta != null && Math.abs(delta) <= REVIEW_THRESHOLDS.maxDeltaForAutoAccept
    && isNum(overallConfidence) && overallConfidence >= REVIEW_THRESHOLDS.minConfidenceForAutoAccept;

  return {
    requires_user_review: !autoAcceptEligible,
    auto_accept_eligible: autoAcceptEligible,
    delta,
    reasons: autoAcceptEligible ? [] : ["not_periodic_review_or_confidence_insufficient_for_auto_accept"],
  };
}

// ================== Acciones manuales del usuario (seccion 18) ==================
// Validacion pura -- el llamador (endpoint) hace el INSERT/UPDATE real.
// "Nunca borrar recomendacion AI": accept/reject solo cambian
// status/reviewed_at/reviewed_by de la fila EXISTENTE (columnas
// mutables del trigger). Un override manual (valor distinto al
// propuesto) es SIEMPRE una fila NUEVA (source='MANUAL_OVERRIDE'),
// nunca una mutacion del valor propuesto original.
export function validateReviewAction(action) {
  if (action !== "ACCEPTED" && action !== "REJECTED") {
    return { valid: false, error: `invalid_action(${action})` };
  }
  return { valid: true };
}

export function validateManualOverride({ newConviction, reason }) {
  if (typeof newConviction !== "number" || Number.isNaN(newConviction) || newConviction < CONVICTION_SCALE_MIN || newConviction > CONVICTION_SCALE_MAX) {
    return { valid: false, error: "conviction_out_of_range" };
  }
  if (!reason || !String(reason).trim()) {
    return { valid: false, error: "reason_required_for_manual_override" };
  }
  return { valid: true };
}
