// lib/materialityAiAdjustment.js
// Sprint P3.1B (Materiality Engine). El AI NUNCA calcula el score
// deterministico -- solo puede proponer un ajuste acotado (-15..+15)
// sobre un score que ya existe completo. Un fallo de AI (red, JSON
// invalido, rango invalido, falta de reason) NUNCA destruye el score
// deterministico -- siempre se devuelve un resultado usable con
// ai_status explicito (APPLIED|NEUTRAL|FAILED), nunca una excepcion sin
// manejar propagandose hacia el llamador.
//
// `callModelFn` se inyecta (mismo patron que `executorFn` en
// api/ai.js::runQuestion) -- permite probar toda la logica de
// validacion/parsing sin tocar la red real. La llamada real al AI
// Gateway (lib/aiGateway.js::callModel) vive en el endpoint que use
// este modulo, no aqui.

import { validateAiAdjustment } from "./materialityFormula.js";

// Pura: parsea y valida la respuesta cruda del modelo (texto, se espera
// JSON). Nunca lanza -- siempre devuelve {valid, ...}.
export function parseAiAdjustmentResponse(rawText) {
  let parsed;
  try {
    const cleaned = (rawText || "").replace(/```json|```/g, "").trim();
    parsed = JSON.parse(cleaned);
  } catch (e) {
    return { valid: false, error: "invalid_json", adjustment: 0, reason: null, interpretation: null };
  }
  const adjustment = typeof parsed.adjustment === "number" ? parsed.adjustment : NaN;
  const validation = validateAiAdjustment(adjustment, parsed.reason);
  if (!validation.valid) {
    return { valid: false, error: validation.error, adjustment: 0, reason: null, interpretation: null };
  }
  return {
    valid: true,
    adjustment,
    reason: parsed.reason || null,
    interpretation: typeof parsed.interpretation === "string" ? parsed.interpretation : null,
    confidence: typeof parsed.confidence === "number" ? parsed.confidence : null,
  };
}

// Orquesta la llamada (impura, pero con la parte de red totalmente
// inyectada). `context` es lo que el llamador real arma con facts +
// deterministic components + confidence + portfolio/thesis context
// permitido -- este modulo no construye el prompt, solo maneja la
// respuesta con seguridad.
export async function requestAiAdjustment(callModelFn, context) {
  try {
    const rawText = await callModelFn(context);
    if (!rawText) {
      return { ai_status: "FAILED", adjustment: 0, reason: null, interpretation: null, model_confidence: null, error: "empty_response" };
    }
    const parsed = parseAiAdjustmentResponse(rawText);
    if (!parsed.valid) {
      return { ai_status: "FAILED", adjustment: 0, reason: null, interpretation: null, model_confidence: null, error: parsed.error };
    }
    if (parsed.adjustment === 0) {
      return { ai_status: "NEUTRAL", adjustment: 0, reason: parsed.reason, interpretation: parsed.interpretation, model_confidence: parsed.confidence, error: null };
    }
    return { ai_status: "APPLIED", adjustment: parsed.adjustment, reason: parsed.reason, interpretation: parsed.interpretation, model_confidence: parsed.confidence, error: null };
  } catch (e) {
    return { ai_status: "FAILED", adjustment: 0, reason: null, interpretation: null, model_confidence: null, error: String(e.message || e) };
  }
}

// Resultado usado cuando el ajuste de AI ni siquiera se intenta (ej.
// scoring puramente deterministico, o AI Gateway deshabilitado para
// esta corrida) -- distinto de FAILED (que implica que se intento y no
// funciono). Ver Test V y el reporte del sprint.
export const AI_NOT_ATTEMPTED = Object.freeze({
  ai_status: "NOT_ATTEMPTED", adjustment: 0, reason: null, interpretation: null, model_confidence: null, error: null,
});
