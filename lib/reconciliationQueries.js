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

// Busca transacciones existentes relevantes (misma cuenta y/o mismo
// asset, segun lo que el candidate traiga) y delega la clasificacion de
// duplicado a la funcion pura. El filtro de fetch es intencionalmente
// amplio (no intenta pre-adivinar el nivel de match) -- classifyDuplicate
// decide con la jerarquia completa de 3 niveles.
//
// NORMALIZACION IMPORTANTE (descubierta probando contra datos reales,
// no en los unit tests con fixtures a mano): `transactions.amount` es
// signed (negativo = salida de dinero, compra), pero classifyDuplicate
// espera `total` sin signo. Se normaliza aqui, en la frontera de I/O --
// la funcion pura nunca necesita saber de este detalle del schema.
function normalizeTransactionRow(row) {
  return { ...row, total: row.amount != null ? Math.abs(row.amount) : null };
}

export async function resolveDuplicateCheck(supabase, candidate) {
  let query = supabase.from("transactions").select("*");
  if (candidate.account_id != null) query = query.eq("account_id", candidate.account_id);
  if (candidate.asset_id != null) query = query.eq("asset_id", candidate.asset_id);
  const { data, error } = await query;
  if (error) throw error;
  const normalized = (data || []).map(normalizeTransactionRow);
  return classifyDuplicate(candidate, normalized);
}
