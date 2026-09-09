// lib/materialEventConfidence.js
// Sprint P3.1A (Event Ingestion Foundation). Breakdown de confidence en
// 4 factores nombrados (Final Architecture Review, seccion 3) -- nunca
// un numero suelto. Puro: no toca red ni Supabase.

import { CONFIDENCE_WEIGHTS, CONFIDENCE_POLICY_VERSION } from "./materialEventVersioning.js";
import { tierScore } from "./materialEventSources.js";
import { countIndependentSources } from "./materialEventSources.js";
import { FRESHNESS_STATUS } from "./materialEventTemporal.js";

const FRESHNESS_SCORE = Object.freeze({
  [FRESHNESS_STATUS.FRESH]: 100,
  [FRESHNESS_STATUS.RECENT]: 60,
  [FRESHNESS_STATUS.STALE]: 20,
});

// corroboration: retornos decrecientes despues de la 2da-3ra fuente
// independiente -- 1 fuente = base, 2 = buen salto, 3+ = casi tope, sin
// premiar infinitamente por acumular mas de lo mismo.
const CORROBORATION_SCORE_BY_COUNT = Object.freeze({ 0: 0, 1: 40, 2: 75, 3: 90 });
function corroborationScore(independentCount) {
  if (independentCount >= 4) return 100;
  return CORROBORATION_SCORE_BY_COUNT[independentCount] ?? 0;
}

// primaryEvidenceTier: tier (1-4) de la PRIMARY_EVIDENCE_SOURCE actual.
// knownFactKeys/expectedFactKeys: para DATA_COMPLETENESS -- cuantos de
//   los campos de facts esperados para este event_type se conocen
//   realmente (no UNKNOWN/null).
// freshnessStatus: FRESH|RECENT|STALE (de lib/materialEventTemporal.js).
// sources: array de sources del cluster, para CORROBORATION_CONFIDENCE.
export function computeConfidenceBreakdown({ primaryEvidenceTier, knownFactKeys, expectedFactKeys, freshnessStatus, sources }) {
  const sourceConfidence = tierScore(primaryEvidenceTier);

  const expected = expectedFactKeys && expectedFactKeys.length ? expectedFactKeys.length : 1;
  const known = Math.min(knownFactKeys || 0, expected);
  const dataCompleteness = Math.round((known / expected) * 100);

  const freshnessConfidence = FRESHNESS_SCORE[freshnessStatus] ?? 0;

  const independentCount = countIndependentSources(sources);
  const corroborationConfidence = corroborationScore(independentCount);

  const overall = Math.round(
    sourceConfidence * CONFIDENCE_WEIGHTS.source +
    dataCompleteness * CONFIDENCE_WEIGHTS.completeness +
    freshnessConfidence * CONFIDENCE_WEIGHTS.freshness +
    corroborationConfidence * CONFIDENCE_WEIGHTS.corroboration
  );

  return {
    source_confidence: sourceConfidence,
    data_completeness: dataCompleteness,
    freshness_confidence: freshnessConfidence,
    corroboration_confidence: corroborationConfidence,
    overall_confidence: Math.max(0, Math.min(100, overall)),
    confidence_policy_version: CONFIDENCE_POLICY_VERSION,
    independent_source_count: independentCount,
  };
}
