// lib/materialityFormula.js
// Sprint P3.1B (Materiality Engine). La formula final -- "ancora +
// perturbacion acotada", NUNCA blend convexo. Ver Sprint P3.1 Final
// Architecture Review (seccion 2) para el analisis matematico completo
// del bug real que esta formula corrige: un blend `det*0.7 + ai*0.3`
// reduce el score determinista incluso con ai_adjustment neutral (0),
// lo cual es incorrecto -- ai_adjustment es un DELTA acotado, no una
// segunda estimacion independiente en la misma escala.

export const AI_ADJUSTMENT_MIN = -15;
export const AI_ADJUSTMENT_MAX = 15;

// Valida un ai_adjustment antes de aplicarlo. Nunca se persiste un
// ajuste invalido -- el llamador debe tratar `valid:false` como
// "descartar el ajuste, usar 0".
export function validateAiAdjustment(adjustment, reason) {
  if (typeof adjustment !== "number" || Number.isNaN(adjustment)) {
    return { valid: false, error: "adjustment_not_a_number" };
  }
  if (adjustment < AI_ADJUSTMENT_MIN || adjustment > AI_ADJUSTMENT_MAX) {
    return { valid: false, error: "adjustment_out_of_range" };
  }
  if (adjustment !== 0 && (!reason || !String(reason).trim())) {
    return { valid: false, error: "reason_required_for_nonzero_adjustment" };
  }
  return { valid: true };
}

// FINAL_MATERIALITY = clamp(deterministic_score + ai_adjustment, 0, 100)
// ai_adjustment == 0 -> final === deterministic_score, EXACTO, siempre.
export function computeFinalMateriality(deterministicScore, aiAdjustment) {
  return Math.max(0, Math.min(100, deterministicScore + aiAdjustment));
}

// Umbrales explicitos, versionados junto con MATERIALITY_LEVEL_POLICY_VERSION
// en lib/materialEventVersioning.js -- nunca un numero magico suelto en
// el punto de uso.
export function deriveMaterialityLevel(score) {
  if (score == null) return null;
  if (score >= 70) return "HIGH";
  if (score >= 40) return "MEDIUM";
  return "LOW";
}

// Invariante de ordenamiento historico (Final Architecture Review de
// P3.1A, seccion 5, reaplicado aqui): un score nunca puede haberse
// calculado ANTES de que el sistema tuviera el evento procesado
// (material_events.processed_at). Cualquier analisis retrospectivo
// futuro (backtesting, "que sabia Moni Intelligence y cuando") debe
// poder confiar en que scored_at >= processed_at siempre -- esta
// funcion es la que lo verifica, en vez de dejarlo como una regla no
// verificada.
export function validateScoreOrdering(materialEventProcessedAt, scoreScoredAt) {
  if (!materialEventProcessedAt || !scoreScoredAt) {
    return { valid: false, error: "missing_timestamp" };
  }
  const eventTime = new Date(materialEventProcessedAt).getTime();
  const scoreTime = new Date(scoreScoredAt).getTime();
  if (scoreTime < eventTime) {
    return { valid: false, error: "score_predates_event_processing -- look-ahead bias real" };
  }
  return { valid: true };
}
