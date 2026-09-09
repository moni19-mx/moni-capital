// lib/materialEventTemporal.js
// Sprint P3.1A (Event Ingestion Foundation). Contrato temporal puro --
// nunca hace fetch, nunca toca Date.now() internamente (todo "ahora" se
// inyecta desde el llamador, mismo patron que lib/dataSourceState.js de
// Sprint P0.1, para que esto sea 100% determinista y testeable sin
// mockear el reloj).
//
// PRECISION del Final Architecture Review: "processed_at" NO se asume
// automaticamente como "el primer momento en que el sistema pudo haber
// actuado". Este modulo declara explicitamente esa definicion como una
// funcion (resolveDecisionAvailableAt), no como una convencion de
// nombre de columna -- si en el futuro decision_available_at necesita
// ser distinto de processed_at (ej. un delay de revision humana antes
// de que un score cuente como "disponible para decision"), este es el
// unico lugar que hay que cambiar.
//
// Regla dura (Final Architecture Review, seccion 5): CUALQUIER analisis
// retrospectivo (backtesting, decision review, "did Moni Intelligence
// add value") debe filtrar/unir por decision_available_at, NUNCA por
// occurred_at. occurred_at es un hecho sobre el mundo;
// decision_available_at es un hecho sobre que sabia el sistema y cuando.

import { FRESHNESS_THRESHOLDS, FRESHNESS_POLICY_VERSION } from "./materialEventVersioning.js";

export const FRESHNESS_STATUS = {
  FRESH: "FRESH",
  RECENT: "RECENT",
  STALE: "STALE",
};

// occurred_at puede ser null (evento cuya fecha real de ocurrencia no se
// pudo determinar todavia) -- fallback conservador: published_at, y si
// tampoco existe, discovered_at. Nunca se asume "esto acaba de pasar"
// sin evidencia (Final Architecture Review, seccion 5).
export function resolveEffectiveOccurredAt({ occurred_at, published_at, discovered_at }) {
  return occurred_at || published_at || discovered_at || null;
}

// decision_available_at: el momento en que este evento, tal como fue
// procesado, pudo haber informado una decision real. Para P3.1A (sin
// materiality/conviction todavia), esto es exactamente processed_at --
// pero se expone como funcion nombrada, no como un alias implicito, para
// que fases futuras (ej. si se agrega una demora de revision humana
// antes de que un evento "cuente") puedan redefinir esto sin tener que
// releer cada lugar que hoy asume processed_at.
export function resolveDecisionAvailableAt({ processed_at }) {
  return processed_at || null;
}

// Clasificacion de freshness. Usa SIEMPRE discovered_at + el
// effectiveOccurredAt (nunca decision_available_at -- freshness es sobre
// que tan reciente es el HECHO, no sobre cuando se pudo actuar).
// `now` inyectado (ISO string), nunca Date.now() interno.
export function classifyFreshness({ discovered_at, occurred_at, published_at }, now) {
  const effectiveOccurredAt = resolveEffectiveOccurredAt({ occurred_at, published_at, discovered_at });
  if (!discovered_at || !effectiveOccurredAt) {
    return { status: FRESHNESS_STATUS.STALE, policyVersion: FRESHNESS_POLICY_VERSION, reason: "missing_required_timestamp" };
  }
  const nowMs = new Date(now).getTime();
  const discoveredHoursAgo = (nowMs - new Date(discovered_at).getTime()) / 3_600_000;
  const occurredDaysAgo = (nowMs - new Date(effectiveOccurredAt).getTime()) / 86_400_000;

  if (
    discoveredHoursAgo <= FRESHNESS_THRESHOLDS.freshDiscoveredWithinHours &&
    occurredDaysAgo <= FRESHNESS_THRESHOLDS.freshOccurredWithinDays
  ) {
    return { status: FRESHNESS_STATUS.FRESH, policyVersion: FRESHNESS_POLICY_VERSION, reason: null };
  }
  // RECENT depende SOLO de que tan viejo es el evento en si
  // (occurredDaysAgo) -- deliberadamente NO usa discoveredDaysAgo como
  // alternativa independiente. Un evento ocurrido hace 60 dias y
  // descubierto hoy NO es "RECENT" solo porque lo acabamos de encontrar
  // -- eso es exactamente el tipo de "noticia vieja disfrazada de nueva"
  // que este modulo existe para prevenir (Test G).
  if (occurredDaysAgo <= FRESHNESS_THRESHOLDS.recentOccurredWithinDays) {
    return { status: FRESHNESS_STATUS.RECENT, policyVersion: FRESHNESS_POLICY_VERSION, reason: null };
  }
  return { status: FRESHNESS_STATUS.STALE, policyVersion: FRESHNESS_POLICY_VERSION, reason: null };
}

// Validacion de orden temporal minima -- no una garantia contra datos de
// proveedor maliciosos/erroneos, pero atrapa inconsistencias obvias antes
// de persistir (ej. discovered_at anterior a published_at, que violaria
// la causalidad basica del pipeline).
export function validateTemporalOrder({ occurred_at, published_at, discovered_at, processed_at }) {
  const errors = [];
  const t = (v) => (v ? new Date(v).getTime() : null);
  const o = t(occurred_at), p = t(published_at), d = t(discovered_at), pr = t(processed_at);

  if (p != null && d != null && p > d) errors.push("published_at_after_discovered_at");
  if (d != null && pr != null && d > pr) errors.push("discovered_at_after_processed_at");
  if (o != null && p != null && o > p) errors.push("occurred_at_after_published_at");

  return { valid: errors.length === 0, errors };
}
