// lib/convictionEngine.js
// Sprint P3.2 (Thesis / Conviction Engine 2.0). Formula deterministica
// para el conviction OVERALL a partir de los 9 componentes (ver
// lib/thesisConvictionVersioning.js) -- CERO LLM, CERO red, CERO
// Supabase. Cada componente es {value: 1.0-5.0 | "UNKNOWN", ...}.
//
// Diferencia deliberada con lib/materialityEngine.js::computeDeterministicScore:
// aqui NO se reusa sqrt(coverage) hacia CERO sin mas. Ese modelo tenia
// sentido en Materiality porque 0 es un ancla real ("definitivamente no
// material"). En Conviction, la escala es 1.0-5.0 con 3.0 como punto
// NEUTRAL explicito (ni tesis fuerte ni debil) -- no hay equivalente a
// "0". Amortiguar hacia el limite inferior (1.0) por falta de
// evidencia afirmaria falsamente "tesis debil" cuando lo unico que
// sabemos es "todavia no la evaluamos". La forma correcta es
// shrinkage hacia el PUNTO NEUTRAL (3.0), no hacia el piso de la
// escala -- mismo principio estadistico que un estimador con prior
// neutral (regression to the mean), reusando la MISMA curva de
// amortiguacion (sqrt) que ya demostro funcionar en Materiality, pero
// aplicada alrededor del ancla correcta para esta escala.

import { CONVICTION_WEIGHTS, CONVICTION_SCALE_MIN, CONVICTION_SCALE_MAX, CONVICTION_SCALE_STEP, CONVICTION_SCALE_MIDPOINT } from "./thesisConvictionVersioning.js";

export const UNKNOWN = "UNKNOWN";

function isNum(v) {
  return typeof v === "number" && !Number.isNaN(v);
}

// Redondea al paso de 0.5 mas cercano y recorta a [1.0, 5.0] -- unico
// lugar donde la escala se aplica, nunca repetido a mano.
export function roundToConvictionStep(v) {
  const stepped = Math.round(v / CONVICTION_SCALE_STEP) * CONVICTION_SCALE_STEP;
  return Math.max(CONVICTION_SCALE_MIN, Math.min(CONVICTION_SCALE_MAX, Math.round(stepped * 100) / 100));
}

// components: { BUSINESS_QUALITY, GROWTH_TAM, COMPETITIVE_POSITION,
//   EXECUTION, FINANCIAL_STRENGTH, VALUATION, CATALYSTS,
//   THESIS_CONFIRMATION, RISK } -- cada uno {value: 1.0-5.0 | "UNKNOWN"}.
//
// known_score = promedio ponderado SOLO entre los conocidos
//   (renormalizado entre ellos, escala 1.0-5.0 real -- igual de
//   concepto que antes en Materiality).
// coverage = fraccion del peso TOTAL de la policy que esta conocida
//   (0..1).
// FINAL = MIDPOINT + (known_score - MIDPOINT) * sqrt(coverage) --
//   con coverage=1, FINAL=known_score exacto (cero cambio de
//   comportamiento con evidencia completa). Con coverage bajo, el
//   score colapsa hacia 3.0 (neutral), nunca hacia 1.0 (debil) ni se
//   "expande" hacia 5.0 (fuerte) a partir de pocas señales.
export function computeOverallConviction(components) {
  components = components || {};
  const known = {};
  let knownWeight = 0;
  for (const key of Object.keys(CONVICTION_WEIGHTS)) {
    const v = components[key]?.value;
    if (isNum(v)) {
      known[key] = v;
      knownWeight += CONVICTION_WEIGHTS[key];
    }
  }
  const componentsKnown = Object.keys(known).length;
  const componentsTotal = Object.keys(CONVICTION_WEIGHTS).length;

  if (componentsKnown === 0) {
    return {
      status: "DATA_UNAVAILABLE", proposed_conviction: null, known_score: null, coverage: 0,
      weights_used: {}, components_known: 0, components_total: componentsTotal,
    };
  }

  let knownScore = 0;
  const weightsUsed = {};
  for (const key of Object.keys(known)) {
    const renormalized = CONVICTION_WEIGHTS[key] / knownWeight;
    weightsUsed[key] = Math.round(renormalized * 1000) / 1000;
    knownScore += known[key] * renormalized;
  }

  const coverage = knownWeight;
  const shrunk = CONVICTION_SCALE_MIDPOINT + (knownScore - CONVICTION_SCALE_MIDPOINT) * Math.sqrt(coverage);
  const proposed = roundToConvictionStep(shrunk);

  return {
    status: "SCORED",
    proposed_conviction: proposed,
    known_score: Math.round(knownScore * 100) / 100,
    coverage: Math.round(coverage * 1000) / 1000,
    weights_used: weightsUsed,
    components_known: componentsKnown,
    components_total: componentsTotal,
  };
}

// Aplica deltas de AI (acotados, ver lib/thesisImpactAi.js) sobre los
// componentes previos. Un componente previamente UNKNOWN que recibe un
// delta arranca desde el punto NEUTRAL (3.0), nunca desde 0 ni desde un
// valor inventado -- mismo principio de ancla neutral que
// computeOverallConviction. Un componente sin delta propuesto
// permanece exactamente como estaba (UNKNOWN sigue UNKNOWN si no hay
// evidencia nueva que lo mueva).
export function applyComponentDeltas(previousComponents, componentDeltas) {
  const result = { ...(previousComponents || {}) };
  for (const { component, delta } of componentDeltas || []) {
    const prevValue = result[component]?.value;
    const base = isNum(prevValue) ? prevValue : CONVICTION_SCALE_MIDPOINT;
    const next = Math.max(CONVICTION_SCALE_MIN, Math.min(CONVICTION_SCALE_MAX, base + delta));
    result[component] = { value: Math.round(next * 100) / 100, method: isNum(prevValue) ? "ai_delta_on_known_value" : "ai_delta_from_neutral_anchor" };
  }
  return result;
}

// ================== CONVICTION CONFIDENCE (separado del score) ==================
// Mismo principio que materiality: "Conviction 4.5, Confidence 52%"
// deben poder coexistir -- confidence nunca se mezcla en el numero de
// conviction. 4 factores nombrados, nunca un numero suelto.
const FRESHNESS_SCORE = Object.freeze({ FRESH: 100, RECENT: 60, STALE: 20 });

export function classifyDimensionFreshness(daysSinceUpdated) {
  if (daysSinceUpdated <= 30) return "FRESH";
  if (daysSinceUpdated <= 180) return "RECENT";
  return "STALE";
}

// sourceTierScores: array de tierScore() (0-100) de las evidence_refs
//   citadas por los componentes CONOCIDOS -- vacio si ninguno cito
//   evidencia real (nunca inventado).
// coverage: mismo valor que devuelve computeOverallConviction.
// oldestUpdatedAtDaysAgo: dias desde el updated_at MAS antiguo entre
//   las thesis_dimensions que respaldan los componentes conocidos.
// invalidatedDimensionsReferenced: cuantas de las dimensiones citadas
//   como evidencia estan en status INVALIDATED (señal real de
//   inconsistencia -- una dimension invalidada que sigue respaldando un
//   componente sin ajustar es una bandera honesta, no un juicio de IA).
export function computeConvictionConfidence({ sourceTierScores, coverage, oldestUpdatedAtDaysAgo, invalidatedDimensionsReferenced }) {
  const sourceConfidence = (sourceTierScores && sourceTierScores.length)
    ? Math.round(sourceTierScores.reduce((a, b) => a + b, 0) / sourceTierScores.length)
    : 0;
  const dataCompleteness = Math.round((coverage || 0) * 100);
  const freshnessConfidence = isNum(oldestUpdatedAtDaysAgo)
    ? FRESHNESS_SCORE[classifyDimensionFreshness(oldestUpdatedAtDaysAgo)]
    : 0;
  // Penalizacion simple y explicita: -20 puntos por cada dimension
  // invalidada que sigue citada como evidencia de un componente, piso 0.
  const evidenceConsistency = Math.max(0, 100 - 20 * (invalidatedDimensionsReferenced || 0));

  const overall = Math.round(
    sourceConfidence * 0.30 + dataCompleteness * 0.30 + freshnessConfidence * 0.20 + evidenceConsistency * 0.20
  );

  return {
    overall_confidence: overall,
    source_confidence: sourceConfidence,
    data_completeness: dataCompleteness,
    freshness_confidence: freshnessConfidence,
    evidence_consistency: evidenceConsistency,
  };
}
