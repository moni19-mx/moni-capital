// lib/materialEventVersioning.js
// Sprint P3.1A (Event Ingestion Foundation). Fuente unica de las
// versiones de politica que acompanan cada evento/score de Moni
// Intelligence -- mismo patron que PROMPT_VERSION en api/ai.js o
// SMART_IMPORT_PROMPT_VERSION en lib/aiGateway.js: un string en un solo
// lugar, nunca repetido a mano en cada archivo que lo necesita.
//
// Por que 3 versiones separadas y no una sola: el CODIGO (engine_version)
// cambia cuando se modifica la logica de normalizacion/dedupe/persistencia.
// Los PESOS de materialidad (scoring_policy_version, P3.1B) y los pesos de
// confidence (confidence_policy_version, ya usados desde P3.1A aunque
// materiality final todavia no existe) pueden re-tunearse SIN un deploy de
// codigo -- son policy, no verdad matematica (correccion explicita del
// P3.1A Final Architecture Review). Versionarlos por separado es lo que
// permite reproducir un score historico meses despues aunque el codigo,
// los pesos de materialidad, o los pesos de confidence hayan cambiado de
// forma independiente unos de otros.

export const ENGINE_VERSION = "material-events-ingestion-v1.0.0";

// P3.1A no calcula materiality final (eso es P3.1B) -- este valor existe
// para que un evento persistido en P3.1A ya declare CON que normalizador
// fue procesado, sin esperar a que exista scoring real.
export const NORMALIZATION_POLICY_VERSION = "normalization-v1.0.0";

export const CONFIDENCE_POLICY_VERSION = "confidence-v1.0.0";

// Pesos del breakdown de confidence (ver lib/materialEventConfidence.js).
// Viven aqui, no en ese archivo, para que CONFIDENCE_POLICY_VERSION y los
// pesos que describe cambien juntos siempre -- imposible actualizar uno
// sin el otro por accidente.
export const CONFIDENCE_WEIGHTS = Object.freeze({
  source: 0.30,
  completeness: 0.30,
  freshness: 0.20,
  corroboration: 0.20,
});

// Umbrales de freshness (ver lib/materialEventTemporal.js). Mismo
// razonamiento: versionados junto con el resto de la politica.
export const FRESHNESS_POLICY_VERSION = "freshness-v1.0.0";
export const FRESHNESS_THRESHOLDS = Object.freeze({
  freshDiscoveredWithinHours: 48,
  freshOccurredWithinDays: 7,
  // RECENT depende solo de la edad del evento (occurred), nunca de que
  // tan reciente fue el descubrimiento como alternativa independiente --
  // ver lib/materialEventTemporal.js::classifyFreshness para el porque
  // (un evento viejo descubierto hoy no debe leerse como "reciente").
  recentOccurredWithinDays: 30,
});

// Sprint P3.1B (Materiality Engine). MATERIALITY_ENGINE_VERSION es
// deliberadamente distinto de ENGINE_VERSION (ingestion) -- son motores
// de codigo independientes, cada uno puede cambiar sin el otro. Los
// pesos deterministicos son policy (scoring_policy_version), igual que
// CONFIDENCE_WEIGHTS -- re-tuneables sin deploy de codigo, versionados
// juntos para que un score historico siga siendo reproducible aunque
// los pesos cambien despues.
// Sprint P3.1B.2 (Materiality Calibration Fix). MATERIALITY_ENGINE_VERSION
// sube porque la logica de codigo cambio (evidence coverage model,
// timeline urgency rediseñado, entity relevance nuevo, decontaminacion
// de STRATEGIC_RELEVANCE) -- SCORING_POLICY_VERSION sube porque, aunque
// los pesos base (DETERMINISTIC_WEIGHTS) no cambiaron, el METODO de
// combinarlos si (coverage adjustment, entity penalty) -- ambos son
// policy, no verdad matematica, y deben poder re-tunearse sin romper la
// reproducibilidad de scores historicos.
export const MATERIALITY_ENGINE_VERSION = "materiality-engine-v1.1.0";
export const SCORING_POLICY_VERSION = "scoring-v1.1.0";
export const DETERMINISTIC_WEIGHTS = Object.freeze({
  FINANCIAL_SCALE: 0.35,
  STRATEGIC_RELEVANCE: 0.25,
  TIMELINE_URGENCY: 0.15,
  SOURCE_STRENGTH: 0.25,
});
