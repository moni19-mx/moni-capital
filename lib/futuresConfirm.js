// lib/futuresConfirm.js
// Sprint P1.2 (Smart Import Futures Confirm). Nucleo PURO para la accion
// "confirm" de los 2 tipos de snapshot de Futures. Ninguna funcion aqui
// hace fetch ni conoce Supabase -- reciben datos ya cargados
// (normalized_extraction persistido, resoluciones de account/asset ya
// hechas, resultado de matchDerivativePositionIdentity ya recalculado
// contra derivative_positions ACTUAL) y devuelven decisiones
// deterministicas + los parametros exactos para los RPCs ya existentes
// (confirm_smart_import_futures_account_snapshot /
// ..._position_snapshot). api/smart-import.js hace todo el I/O y llama
// a estas funciones en secuencia -- nunca al reves.
//
// Regla dura (igual que el resto de Smart Import): NUNCA se deriva un
// dato financiero que no este ya verificado. notional USD, contract
// size, BTC equivalent, exposure USD -- ninguno se calcula aqui ni en
// ningun otro punto de este archivo.

import { classifyBalanceForPersistence } from "./futuresImportNormalize.js";

// ================== observed_at ==================
// Mismo contrato A/B ya usado en el extract de FUTURES_POSITION_SNAPSHOT
// (SOURCE_TIMESTAMP si el screenshot lo trae, si no
// smart_imports.created_at -- nunca "ahora mismo", nunca inventado).
// FUTURES_ACCOUNT_SNAPSHOT no aplicaba este fallback en extract -- se
// aplica aqui, en confirm, para los dos tipos de snapshot por igual.
export function resolveObservedAt(normalizedObservedAt, importCreatedAt) {
  if (normalizedObservedAt) return { value: normalizedObservedAt, source: "SOURCE_TIMESTAMP" };
  return { value: importCreatedAt, source: "IMPORT_CREATED_AT" };
}

// ================== FUTURES_ACCOUNT_SNAPSHOT confirm ==================
// balances: normalized_extraction.balances YA PERSISTIDO (con
// equity_value/equity_status ya calculados en extract por
// normalizeFuturesAccountBalance -- nunca se recalculan aqui, la
// "REGLA CENTRAL" de no confiar en el cliente aplica al INPUT del
// usuario, no a datos que el propio servidor ya calculo y guardo).
// assetIdBySymbol: { [asset_symbol]: asset_id|null } -- resuelto por
// resolveAsset() en el endpoint (I/O), un balance a la vez, ANTES de
// llamar esta funcion.
//
// Clasificacion (igual jerarquia ya aprobada en
// futuresImportNormalize.js::classifyBalanceForPersistence):
//   A. economicamente irrelevante (todo 0/null) -> IGNORE, nunca bloquea
//   B. relevante + equity_status "OK" -> PERSIST (si el asset tambien resolvio)
//   C. relevante + equity_status != "OK" -> bloquea el confirm ENTERO
//      (nunca se persiste una cuenta a medias sin que el usuario lo sepa)
// Un asset que no resolvio (asset_id null) para un balance PERSIST
// tambien bloquea el confirm entero -- mismo principio que C.
export function buildAccountSnapshotConfirmPlan(balances, assetIdBySymbol) {
  const persist = [];
  const ignored = [];
  const blockedEquity = [];
  const blockedAsset = [];

  for (const b of balances || []) {
    const classification = classifyBalanceForPersistence(b);
    if (classification === "IGNORE") { ignored.push(b); continue; }
    if (classification === "REVIEW") { blockedEquity.push(b); continue; }

    const assetId = (assetIdBySymbol || {})[b.asset_symbol];
    if (assetId == null) { blockedAsset.push(b); continue; }

    persist.push({
      asset_id: assetId,
      wallet_balance_value: b.wallet_balance_value ?? null,
      equity_value: b.equity_value ?? null,
      available_balance_value: b.available_balance_value ?? null,
      margin_balance_value: b.margin_balance_value ?? null,
      initial_margin_value: b.initial_margin_value ?? null,
      maintenance_margin_value: b.maintenance_margin_value ?? null,
      unrealized_pnl_value: b.unrealized_pnl_value ?? null,
      confidence: "HIGH",
      equity_source_type: b.equity_source_type ?? null,
    });
  }

  return {
    persist, ignored, blockedEquity, blockedAsset,
    blocked: blockedEquity.length > 0 || blockedAsset.length > 0,
  };
}

// Parametros exactos para confirm_smart_import_futures_account_snapshot.
export function buildAccountSnapshotRpcParams({ importId, accountId, observedAt, balancesPayload, approvedChanges, userEdits }) {
  return {
    p_import_id: importId,
    p_account_id: accountId,
    p_observed_at: observedAt,
    p_balances: balancesPayload,
    p_approved_changes: approvedChanges,
    p_user_edits: userEdits || {},
  };
}

// ================== FUTURES_POSITION_SNAPSHOT confirm ==================
// identityResult: resultado FRESCO de matchDerivativePositionIdentity(),
// recalculado en el endpoint contra derivative_positions ACTUAL (nunca
// el identity_result guardado en extract, que puede estar obsoleto).
//
// Politica final (ya aprobada): solo NEW_POSITION y MATCH_EXISTING_HIGH
// pueden confirmarse. MATCH_EXISTING_MEDIUM, POSITION_IDENTITY_AMBIGUOUS
// e INSUFFICIENT_DATA SIEMPRE bloquean -- nunca confirman, sin importar
// que tan "cerca" este la confianza.
export function resolvePositionConfirmDecision(identityResult) {
  if (!identityResult || typeof identityResult !== "object") {
    throw new Error("resolvePositionConfirmDecision: se requiere identityResult");
  }
  const { decision, matchedPositionId } = identityResult;
  if (decision === "NEW_POSITION") {
    return { allowed: true, operation: "NEW_POSITION", positionId: null, blockReason: null };
  }
  if (decision === "MATCH_EXISTING_HIGH") {
    return { allowed: true, operation: "MATCH_EXISTING_HIGH", positionId: matchedPositionId, blockReason: null };
  }
  return { allowed: false, operation: null, positionId: null, blockReason: decision };
}

// Parametros exactos para confirm_smart_import_futures_position_snapshot.
// normalizedFacts: normalized_extraction.normalized_facts YA PERSISTIDO
// (notional_value/unit_semantics_status ya resueltos en extract via
// deriveNotional() -- nunca se recalculan aqui).
export function buildPositionSnapshotRpcParams({ importId, decision, accountId, underlyingAssetId, normalizedFacts, observedAt, approvedChanges, userEdits }) {
  return {
    p_import_id: importId,
    p_operation: decision.operation,
    p_position_id: decision.positionId,
    p_account_id: accountId,
    p_underlying_asset_id: underlyingAssetId,
    p_instrument: normalizedFacts.instrument,
    p_contract_type: normalizedFacts.contract_type,
    p_side: normalizedFacts.side,
    p_margin_mode: normalizedFacts.margin_mode ?? null,
    p_provider_position_id: normalizedFacts.provider_position_id ?? null,
    p_observed_at: observedAt,
    p_snapshot_fields: {
      position_quantity_value: normalizedFacts.position_quantity_value ?? null,
      position_quantity_unit: normalizedFacts.position_quantity_unit ?? null,
      leverage: normalizedFacts.leverage ?? null,
      margin_used_value: normalizedFacts.margin_used_value ?? null,
      margin_used_asset_id: normalizedFacts.margin_used_asset_id ?? null,
      entry_price: normalizedFacts.entry_price ?? null,
      mark_price: normalizedFacts.mark_price ?? null,
      liquidation_price: normalizedFacts.liquidation_price ?? null,
      price_currency: normalizedFacts.price_currency ?? null,
      unrealized_pnl_value: normalizedFacts.unrealized_pnl_value ?? null,
      unrealized_pnl_asset_id: normalizedFacts.unrealized_pnl_asset_id ?? null,
      roi_pct: normalizedFacts.roi_pct ?? null,
      notional_value: normalizedFacts.notional_value ?? null,
      notional_asset_id: normalizedFacts.notional_asset_id ?? null,
      unit_semantics_status: normalizedFacts.unit_semantics_status ?? "UNIT_SEMANTICS_UNVERIFIED",
    },
    p_approved_changes: approvedChanges,
    p_user_edits: userEdits || {},
  };
}
