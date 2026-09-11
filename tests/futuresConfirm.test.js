import test from "node:test";
import assert from "node:assert/strict";
import {
  resolveObservedAt, buildAccountSnapshotConfirmPlan, buildAccountSnapshotRpcParams,
  resolvePositionConfirmDecision, buildPositionSnapshotRpcParams,
} from "../lib/futuresConfirm.js";
import { validateUserEditKeys, FUTURES_USER_EDIT_WHITELIST } from "../lib/smartImportConfirm.js";

// ================== L. user_edits invalidos ==================
test("L - Futures user_edits: account_id es el unico campo permitido", () => {
  assert.equal(validateUserEditKeys({ account_id: 3 }, FUTURES_USER_EDIT_WHITELIST).valid, true);
});

test("L2 - Futures user_edits: intentar editar un campo financiero (quantity) -> bloqueado, INVALID_USER_EDIT", () => {
  const r = validateUserEditKeys({ quantity: 999 }, FUTURES_USER_EDIT_WHITELIST);
  assert.equal(r.valid, false);
  assert.equal(r.field, "quantity");
});

test("L3 - Futures user_edits: intentar editar equity_value directamente -> bloqueado", () => {
  const r = validateUserEditKeys({ account_id: 3, equity_value: 999999 }, FUTURES_USER_EDIT_WHITELIST);
  assert.equal(r.valid, false);
  assert.equal(r.field, "equity_value");
});

test("L4 - el whitelist de compra/venta sigue funcionando exactamente igual sin pasar el segundo argumento (default)", () => {
  assert.equal(validateUserEditKeys({ quantity: 5, price: 100 }).valid, true);
  assert.equal(validateUserEditKeys({ account_id: 3 }).valid, true); // ya estaba en USER_EDIT_WHITELIST
});

// ================== observed_at ==================
test("resolveObservedAt: usa el timestamp del screenshot cuando existe", () => {
  const r = resolveObservedAt("2026-09-08T18:07:54.707979+00:00", "2026-09-08T18:00:00Z");
  assert.equal(r.value, "2026-09-08T18:07:54.707979+00:00");
  assert.equal(r.source, "SOURCE_TIMESTAMP");
});

test("resolveObservedAt: cae a import.created_at si el screenshot no trae timestamp", () => {
  const r = resolveObservedAt(null, "2026-09-08T18:00:00Z");
  assert.equal(r.value, "2026-09-08T18:00:00Z");
  assert.equal(r.source, "IMPORT_CREATED_AT");
});

// ================== A/B. Account snapshot valido (USD-M / COIN-M) ==================
test("A - USD-M account snapshot valido: balance relevante + equity OK + asset resuelto -> PERSIST, RPC params correctos", () => {
  const balances = [
    { asset_symbol: "USDT", wallet_balance_value: 4366.34644577, margin_balance_value: 4338.65594577, available_balance_value: 3845.05005244, unrealized_pnl_value: -27.69049999, equity_value: 4338.65594577, equity_status: "OK", equity_source_type: "REPORTED_EQUIVALENT_FIELD" },
  ];
  const plan = buildAccountSnapshotConfirmPlan(balances, { USDT: 56 });
  assert.equal(plan.blocked, false);
  assert.equal(plan.persist.length, 1);
  assert.equal(plan.persist[0].asset_id, 56);
  assert.equal(plan.persist[0].equity_value, 4338.65594577);
  assert.equal(plan.persist[0].equity_source_type, "REPORTED_EQUIVALENT_FIELD");

  const rpcParams = buildAccountSnapshotRpcParams({
    importId: 61, accountId: 3, observedAt: "2026-09-08T18:07:54.707979+00:00",
    balancesPayload: plan.persist, approvedChanges: { entity: "account_snapshot" }, userEdits: {},
  });
  assert.equal(rpcParams.p_import_id, 61);
  assert.equal(rpcParams.p_account_id, 3);
  assert.equal(rpcParams.p_balances.length, 1);
  assert.equal(rpcParams.p_balances[0].asset_id, 56);
});

test("B - COIN-M account snapshot valido: balance en BTC + equity OK + asset resuelto -> PERSIST, RPC params correctos", () => {
  const balances = [
    { asset_symbol: "BTC", wallet_balance_value: 0.06816069, margin_balance_value: 0.06818617, available_balance_value: 0.05129614, unrealized_pnl_value: 0.00002548, equity_value: 0.06818617, equity_status: "OK", equity_source_type: "REPORTED_EQUIVALENT_FIELD" },
  ];
  const plan = buildAccountSnapshotConfirmPlan(balances, { BTC: 34 });
  assert.equal(plan.blocked, false);
  assert.equal(plan.persist.length, 1);
  assert.equal(plan.persist[0].asset_id, 34);
  assert.equal(plan.persist[0].equity_value, 0.06818617);

  const rpcParams = buildAccountSnapshotRpcParams({
    importId: 64, accountId: 4, observedAt: "2026-09-08T18:10:36.72619+00:00",
    balancesPayload: plan.persist, approvedChanges: { entity: "account_snapshot" }, userEdits: {},
  });
  assert.equal(rpcParams.p_account_id, 4);
  assert.equal(rpcParams.p_balances[0].asset_id, 34);
});

// ================== M. Balance economicamente irrelevante ==================
test("M - balance con todos los campos economicos en 0/null -> IGNORE, nunca bloquea, nunca en persist", () => {
  const balances = [
    { asset_symbol: "BNB", wallet_balance_value: 0, margin_balance_value: null, available_balance_value: 0, unrealized_pnl_value: null, equity_value: null, equity_status: "DATA_UNAVAILABLE" },
  ];
  const plan = buildAccountSnapshotConfirmPlan(balances, {});
  assert.equal(plan.blocked, false);
  assert.equal(plan.persist.length, 0);
  assert.equal(plan.ignored.length, 1);
  assert.equal(plan.blockedEquity.length, 0);
});

// ================== N. Balance relevante sin equity OK ==================
test("N - balance relevante con equity_status != OK -> bloquea el confirm ENTERO, no RPC", () => {
  const balances = [
    { asset_symbol: "USDT", wallet_balance_value: 4366.34, margin_balance_value: null, available_balance_value: 3845.05, unrealized_pnl_value: -27.69, equity_value: null, equity_status: "DATA_UNAVAILABLE" },
  ];
  const plan = buildAccountSnapshotConfirmPlan(balances, { USDT: 56 });
  assert.equal(plan.blocked, true);
  assert.equal(plan.blockedEquity.length, 1);
  assert.equal(plan.persist.length, 0);
});

test("N2 - balance relevante con REQUIRES_REVIEW (mismatch reportado vs derivado) -> tambien bloquea", () => {
  const balances = [
    { asset_symbol: "USDT", wallet_balance_value: 100, margin_balance_value: 50, available_balance_value: 90, unrealized_pnl_value: -5, equity_value: null, equity_status: "REQUIRES_REVIEW" },
  ];
  const plan = buildAccountSnapshotConfirmPlan(balances, { USDT: 56 });
  assert.equal(plan.blocked, true);
});

// ================== I (mitad "asset"). Asset no resuelto para un balance PERSIST ==================
test("I - balance relevante + equity OK pero el asset ya no resuelve (desapareceria entre extract y confirm) -> bloquea, mismo trato que equity mala", () => {
  const balances = [
    { asset_symbol: "SHIB", wallet_balance_value: 1000, margin_balance_value: 1000, available_balance_value: 1000, unrealized_pnl_value: 0, equity_value: 1000, equity_status: "OK" },
  ];
  const plan = buildAccountSnapshotConfirmPlan(balances, { SHIB: null }); // resolveAsset no lo encontro
  assert.equal(plan.blocked, true);
  assert.equal(plan.blockedAsset.length, 1);
  assert.equal(plan.persist.length, 0);
});

// ================== C. USD-M NEW_POSITION ==================
test("C - USD-M NEW_POSITION: identity NEW_POSITION -> allowed, operation NEW_POSITION, position_id null", () => {
  const decision = resolvePositionConfirmDecision({ decision: "NEW_POSITION", matchedPositionId: null, reconciliation_confidence: null });
  assert.equal(decision.allowed, true);
  assert.equal(decision.operation, "NEW_POSITION");
  assert.equal(decision.positionId, null);

  const normalizedFacts = {
    instrument: "BTCUSDT", contract_type: "perpetual", side: "long", leverage: 5, margin_mode: "isolated",
    provider_position_id: null, position_quantity_value: null, position_quantity_unit: null,
    margin_used_value: 521.29, entry_price: 79307.10, mark_price: 78533.80, liquidation_price: 63765.30,
    price_currency: "USDT", unrealized_pnl_value: -25.52, unrealized_pnl_asset_id: 56, roi_pct: -4.92,
    notional_value: 2591.62, notional_asset_id: 56, unit_semantics_status: "VERIFIED",
  };
  const params = buildPositionSnapshotRpcParams({
    importId: 62, decision, accountId: 3, underlyingAssetId: 34, normalizedFacts,
    observedAt: "2026-09-08T18:09:09.405402+00:00", approvedChanges: {}, userEdits: {},
  });
  assert.equal(params.p_operation, "NEW_POSITION");
  assert.equal(params.p_position_id, null);
  assert.equal(params.p_snapshot_fields.notional_value, 2591.62);
  assert.equal(params.p_snapshot_fields.position_quantity_value, null); // USD-M: nunca se deriva quantity BTC
});

// ================== D. USD-M MATCH_EXISTING_HIGH ==================
test("D - USD-M MATCH_EXISTING_HIGH: mismo derivative_position, nuevo snapshot", () => {
  const decision = resolvePositionConfirmDecision({ decision: "MATCH_EXISTING_HIGH", matchedPositionId: 21, reconciliation_confidence: "HIGH" });
  assert.equal(decision.allowed, true);
  assert.equal(decision.operation, "MATCH_EXISTING_HIGH");
  assert.equal(decision.positionId, 21);

  const params = buildPositionSnapshotRpcParams({
    importId: 62, decision, accountId: 3, underlyingAssetId: 34,
    normalizedFacts: { instrument: "BTCUSDT", contract_type: "perpetual", side: "long", notional_value: 2591.62, notional_asset_id: 56, unit_semantics_status: "VERIFIED" },
    observedAt: "2026-09-08T18:09:09.405402+00:00", approvedChanges: {}, userEdits: {},
  });
  assert.equal(params.p_position_id, 21); // el mismo derivative_position, no uno nuevo
  assert.equal(params.p_operation, "MATCH_EXISTING_HIGH");
});

// ================== E. COIN-M quantity BTC + notional NULL ==================
test("E - COIN-M: position_quantity_value + unit, notional_value NULL, UNVERIFIED -> permitido, nada derivado", () => {
  const decision = resolvePositionConfirmDecision({ decision: "NEW_POSITION", matchedPositionId: null });
  const normalizedFacts = {
    instrument: "BTCUSD_PERP", contract_type: "perpetual", side: "long", leverage: 3, margin_mode: "isolated",
    position_quantity_value: 0.051, position_quantity_unit: "BTC",
    notional_value: null, notional_asset_id: null, unit_semantics_status: "UNIT_SEMANTICS_UNVERIFIED",
    unrealized_pnl_value: 0,
  };
  const params = buildPositionSnapshotRpcParams({
    importId: 63, decision, accountId: 4, underlyingAssetId: 34, normalizedFacts,
    observedAt: "2026-09-08T18:09:44.283928+00:00", approvedChanges: {}, userEdits: {},
  });
  assert.equal(params.p_snapshot_fields.position_quantity_value, 0.051);
  assert.equal(params.p_snapshot_fields.position_quantity_unit, "BTC");
  assert.equal(params.p_snapshot_fields.notional_value, null); // NUNCA derivado
  assert.equal(params.p_snapshot_fields.notional_asset_id, null);
  assert.equal(params.p_snapshot_fields.unit_semantics_status, "UNIT_SEMANTICS_UNVERIFIED");
});
// F (COIN-M notional no-null -> COIN_M_NOTIONAL_NOT_SUPPORTED) se prueba
// contra el RPC real (la validacion vive en el RPC, no se duplica en JS
// -- ver verificacion en vivo en el reporte del sprint).

// ================== G. MEDIUM match ==================
test("G - MATCH_EXISTING_MEDIUM: bloqueado ANTES del RPC, nunca confirma", () => {
  const decision = resolvePositionConfirmDecision({ decision: "MATCH_EXISTING_MEDIUM", matchedPositionId: 21, reconciliation_confidence: "MEDIUM" });
  assert.equal(decision.allowed, false);
  assert.equal(decision.operation, null);
  assert.equal(decision.blockReason, "MATCH_EXISTING_MEDIUM");
});

// ================== H. AMBIGUOUS match ==================
test("H - POSITION_IDENTITY_AMBIGUOUS: bloqueado", () => {
  const decision = resolvePositionConfirmDecision({ decision: "POSITION_IDENTITY_AMBIGUOUS", matchedPositionId: null });
  assert.equal(decision.allowed, false);
  assert.equal(decision.blockReason, "POSITION_IDENTITY_AMBIGUOUS");
});

test("H2 - INSUFFICIENT_DATA: tambien bloqueado, mismo trato que AMBIGUOUS", () => {
  const decision = resolvePositionConfirmDecision({ decision: "INSUFFICIENT_DATA", matchedPositionId: null });
  assert.equal(decision.allowed, false);
  assert.equal(decision.blockReason, "INSUFFICIENT_DATA");
});

test("resolvePositionConfirmDecision: sin identityResult -> throw (error de programacion)", () => {
  assert.throws(() => resolvePositionConfirmDecision(null));
});
