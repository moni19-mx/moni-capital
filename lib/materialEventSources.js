// lib/materialEventSources.js
// Sprint P3.1A (Event Ingestion Foundation). Logica pura de los 3 roles
// de fuente (Final Architecture Review, punto 1.3) y la regla anti-doble
// conteo de corroboracion. Nunca toca Supabase ni hace fetch -- opera
// sobre arrays de "source" en memoria, testeable sin red.

export const SOURCE_ROLE = {
  DISCOVERY_SOURCE: "DISCOVERY_SOURCE",
  PRIMARY_EVIDENCE_SOURCE: "PRIMARY_EVIDENCE_SOURCE",
  CORROBORATING_SOURCE: "CORROBORATING_SOURCE",
};

export const SOURCE_TIER = { TIER_1: 1, TIER_2: 2, TIER_3: 3, TIER_4: 4 };

// Puntaje numerico de tier -- usado por lib/materialEventConfidence.js
// (SOURCE_CONFIDENCE) y por la regla de promocion de abajo. Un solo lugar
// para esta tabla, no un numero repetido en cada archivo que lo necesita.
export const TIER_SCORE = Object.freeze({ 1: 100, 2: 70, 3: 50, 4: 25 });

export function tierScore(tier) {
  return TIER_SCORE[tier] ?? 0;
}

// Dado un array de sources ya asignadas a un cluster (cada una con
// {tier, ingested_at}), decide cual debe ser DISCOVERY (la que llego
// primero, por ingested_at) y cual debe ser PRIMARY_EVIDENCE (la de
// mayor tier -- nunca la que llego primero si una mejor existe). El
// resto queda CORROBORATING. Puro: no muta el array de entrada, siempre
// devuelve un array nuevo con `role` asignado.
//
// Regla dura (Final Architecture Review + GO P3.1A): si dos sources
// EMPATAN en tier, gana la que llego primero como PRIMARY -- nunca
// ambiguo, nunca aleatorio.
export function assignSourceRoles(sources) {
  if (!sources || sources.length === 0) return [];
  const sorted = [...sources].sort((a, b) => new Date(a.ingested_at) - new Date(b.ingested_at));
  const discoveryId = sorted[0].id;

  let best = sorted[0];
  for (const s of sorted) {
    if (tierScore(s.tier) > tierScore(best.tier)) best = s;
  }
  const primaryId = best.id;

  return sources.map((s) => {
    let role;
    if (s.id === primaryId) role = SOURCE_ROLE.PRIMARY_EVIDENCE_SOURCE;
    else if (s.id === discoveryId) role = SOURCE_ROLE.DISCOVERY_SOURCE;
    else role = SOURCE_ROLE.CORROBORATING_SOURCE;
    return { ...s, role };
  });
}

// Reevalua roles cuando llega UNA fuente nueva a un cluster ya existente
// -- caso central del sprint ("si llega una fuente primaria Tier 1
// despues, debe poder promoverse"). Devuelve { roles, promoted } donde
// `promoted` es true si el primary_evidence_source cambio respecto al
// estado anterior -- el llamador (persistencia) usa ese flag para saber
// si debe actualizar material_events.primary_source_id (mutable, ver
// docs/intelligence/SPRINT-P3.1A-EVENT-INGESTION.md) o si ademas los
// FACTS de la nueva fuente entran en conflicto real con los ya
// persistidos (lo cual, en ese caso, nunca se sobreescribe en el lugar
// -- dispara una fila de re-proceso nueva, nunca un UPDATE de `facts`).
export function reassignRolesWithNewSource(existingSourcesWithRoles, newSource) {
  const all = [...existingSourcesWithRoles, newSource];
  const previousPrimary = existingSourcesWithRoles.find((s) => s.role === SOURCE_ROLE.PRIMARY_EVIDENCE_SOURCE);
  const nextRoles = assignSourceRoles(all);
  const nextPrimary = nextRoles.find((s) => s.role === SOURCE_ROLE.PRIMARY_EVIDENCE_SOURCE);
  const promoted = !!nextPrimary && nextPrimary.id !== (previousPrimary && previousPrimary.id);
  return { roles: nextRoles, promoted, previousPrimaryId: previousPrimary ? previousPrimary.id : null, newPrimaryId: nextPrimary ? nextPrimary.id : null };
}

// Anti-doble-conteo de corroboracion (Final Architecture Review, seccion
// 4/6): 2 sources cuentan como corroboracion independiente solo si
// tienen `provider` distinto Y no comparten `attributed_wire`. 5
// republicaciones del mismo wire de Reuters cuentan como 1, no 5.
// Devuelve el conteo de fuentes INDEPENDIENTES (para
// CORROBORATION_CONFIDENCE), nunca el conteo crudo de filas.
export function countIndependentSources(sources) {
  const seen = new Set();
  let count = 0;
  for (const s of sources || []) {
    const key = s.attributed_wire ? `wire:${s.attributed_wire}` : `provider:${s.provider}`;
    if (!seen.has(key)) {
      seen.add(key);
      count++;
    }
  }
  return count;
}
