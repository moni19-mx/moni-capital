// lib/reconciliationQueries.js
// Unico archivo del Reconciliation Engine que toca Supabase. Cada
// funcion aqui hace el fetch minimo necesario y delega TODA la decision
// a las funciones puras de reconciliationEngine.js -- nunca decide nada
// por su cuenta.

import { matchDerivativePositionIdentity, classifyDuplicate } from "./reconciliationEngine.js";

// Busca las posiciones OPEN de una cuenta y delega la identidad a la
// funcion pura. No filtra por instrument/side aqui -- eso ya lo hace
// matchDerivativePositionIdentity internamente, evitando logica de
// filtrado duplicada en dos lugares.
export async function resolveDerivativePositionMatch(supabase, normalizedFacts) {
  const { data, error } = await supabase
    .from("derivative_positions")
    .select("*")
    .eq("account_id", normalizedFacts.account_id)
    .eq("status", "OPEN");
  if (error) throw error;
  return matchDerivativePositionIdentity(normalizedFacts, data || []);
}

// PENDIENTE -- requiere que `transactions` tenga provider_transaction_id,
// transaction_at y transaction_date (Pasos 11-13 de Fase 0, nunca
// ejecutados). No se implementa todavia para no escribir una funcion que
// asuma columnas inexistentes.
export async function resolveDuplicateCheck(/* supabase, candidate */) {
  throw new Error(
    "resolveDuplicateCheck: no implementado -- transactions.provider_transaction_id / transaction_at / transaction_date no existen todavia (Fase 0, Pasos 11-13 pendientes)"
  );
}
