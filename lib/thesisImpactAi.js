// lib/thesisImpactAi.js
// Sprint P3.2 (Thesis / Conviction Engine 2.0). El AI NUNCA calcula el
// conviction score ni inventa facts -- solo puede interpretar como un
// material_event REAL afecta las thesis_dimensions REALES de una
// posicion (CONFIRMS/WEAKENS/INVALIDATES/NEUTRAL, seccion 9-10 del
// sprint) y proponer un ajuste ACOTADO por componente (seccion 15,
// "AI puede proponer component delta"). Mismo patron que
// lib/materialityAiAdjustment.js: `callModelFn` inyectado, un fallo
// (red, JSON invalido, enum invalido, delta fuera de rango, reason
// faltante) NUNCA lanza -- siempre devuelve un resultado con ai_status
// explicito, y el estado deterministico (conviction actual) queda
// intacto. Un solo evento NUNCA puede reescribir toda la tesis: si
// CUALQUIER parte de la respuesta es invalida, se rechaza COMPLETA
// (conservador, mismo criterio que materialityAiAdjustment) -- nunca
// se aplica "a medias" una interpretacion parcialmente invalida.

const VALID_EFFECTS = new Set(["CONFIRMS", "WEAKENS", "INVALIDATES", "NEUTRAL"]);
export const COMPONENT_DELTA_MIN = -1.0;
export const COMPONENT_DELTA_MAX = 1.0;

function isNum(v) {
  return typeof v === "number" && !Number.isNaN(v);
}

// Pura: parsea y valida la respuesta cruda del modelo. Nunca lanza.
// validDimensionIds/validComponentKeys: los universos reales conocidos
//   por el llamador -- un dimension_id o component inventado invalida
//   toda la respuesta (nunca se acepta una referencia a algo que no
//   existe en la tesis real).
export function parseThesisImpactResponse(rawText, { validDimensionIds, validComponentKeys }) {
  let parsed;
  try {
    const cleaned = (rawText || "").replace(/```json|```/g, "").trim();
    parsed = JSON.parse(cleaned);
  } catch (e) {
    return { valid: false, error: "invalid_json" };
  }

  const affectedDimensions = Array.isArray(parsed.affected_dimensions) ? parsed.affected_dimensions : [];
  const componentDeltas = Array.isArray(parsed.component_deltas) ? parsed.component_deltas : [];
  const validDimSet = new Set(validDimensionIds || []);
  const validCompSet = new Set(validComponentKeys || []);

  for (const d of affectedDimensions) {
    if (!validDimSet.has(d.dimension_id)) return { valid: false, error: `unknown_dimension_id(${d.dimension_id})` };
    if (!VALID_EFFECTS.has(d.effect)) return { valid: false, error: `invalid_effect(${d.effect})` };
    if (!isNum(d.confidence) || d.confidence < 0 || d.confidence > 100) return { valid: false, error: `invalid_confidence(${d.confidence})` };
    if (d.effect !== "NEUTRAL" && !(typeof d.explanation === "string" && d.explanation.trim())) {
      return { valid: false, error: "explanation_required_for_nonneutral_effect" };
    }
  }

  for (const c of componentDeltas) {
    if (!validCompSet.has(c.component)) return { valid: false, error: `unknown_component(${c.component})` };
    if (!isNum(c.delta) || c.delta < COMPONENT_DELTA_MIN || c.delta > COMPONENT_DELTA_MAX) {
      return { valid: false, error: `delta_out_of_range(${c.delta})` };
    }
    if (c.delta !== 0 && !(typeof c.reason === "string" && c.reason.trim())) {
      return { valid: false, error: "reason_required_for_nonzero_component_delta" };
    }
  }

  return {
    valid: true,
    affected_dimensions: affectedDimensions,
    component_deltas: componentDeltas,
    requires_review: parsed.requires_review !== false, // por defecto true si no viene explicito
  };
}

// Orquesta la llamada (impura, con la red totalmente inyectada via
// callModelFn). context es lo que el llamador real arma (facts del
// evento + dimensiones reales + componentes actuales) -- este modulo
// nunca construye el prompt.
export async function requestThesisImpact(callModelFn, context, { validDimensionIds, validComponentKeys }) {
  try {
    const rawText = await callModelFn(context);
    if (!rawText) {
      return { ai_status: "FAILED", affected_dimensions: [], component_deltas: [], requires_review: true, error: "empty_response" };
    }
    const parsed = parseThesisImpactResponse(rawText, { validDimensionIds, validComponentKeys });
    if (!parsed.valid) {
      return { ai_status: "FAILED", affected_dimensions: [], component_deltas: [], requires_review: true, error: parsed.error };
    }
    if (parsed.affected_dimensions.length === 0 && parsed.component_deltas.length === 0) {
      return { ai_status: "NEUTRAL", affected_dimensions: [], component_deltas: [], requires_review: parsed.requires_review, error: null };
    }
    return {
      ai_status: "APPLIED", affected_dimensions: parsed.affected_dimensions,
      component_deltas: parsed.component_deltas, requires_review: parsed.requires_review, error: null,
    };
  } catch (e) {
    return { ai_status: "FAILED", affected_dimensions: [], component_deltas: [], requires_review: true, error: String(e.message || e) };
  }
}

export const AI_NOT_ATTEMPTED = Object.freeze({
  ai_status: "NOT_ATTEMPTED", affected_dimensions: [], component_deltas: [], requires_review: true, error: null,
});
