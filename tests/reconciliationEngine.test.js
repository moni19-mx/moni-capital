import test from "node:test";
import assert from "node:assert/strict";
import {
  getTransactionEffects, isInternalTransfer, classifyTransfer,
  getAccountEquity, computeNetWorth, computeAssetOwnership,
  deriveNotional, computeDerivativeExposure, computeEffectiveExposure,
  matchDerivativePositionIdentity,
} from "../lib/reconciliationEngine.js";

// ================== A. GEV PENDING BUY ==================
test("A - GEV PENDING BUY: holdings/cost_basis/cash/net_worth todo NONE, sin evidencia de reserved_cash -> warning", () => {
  const r = getTransactionEffects({ status: "PENDING", type: "BUY" });
  assert.equal(r.holdings, "NONE");
  assert.equal(r.cost_basis, "NONE");
  assert.equal(r.cash_balance, "NONE");
  assert.equal(r.realized_pnl, "NONE");
  assert.equal(r.net_worth.principal, "NONE");
  assert.equal(r.cash_reserved, "NONE");
  assert.ok(r.warnings.includes("PENDING_RESERVED_CASH_NO_EVIDENCE"));
});

// ================== A2. GEV EXECUTED BUY ==================
test("A2 - GEV EXECUTED BUY: holdings INCREASE, cost_basis UPDATE, cash DECREASE, principal NW neutral", () => {
  const r = getTransactionEffects({ status: "EXECUTED", type: "BUY", fee: 0 });
  assert.equal(r.holdings, "INCREASE");
  assert.equal(r.cost_basis, "UPDATE");
  assert.equal(r.cash_balance, "DECREASE");
  assert.equal(r.net_worth.principal, "NONE");
  assert.equal(r.net_worth.fee, "NONE");
});

// ================== B. Binance Spot -> Binance USD-M ==================
test("B - Internal transfer Spot->USD-M: source DECREASE, destination INCREASE, NW neutral", () => {
  const known = new Set([2, 3]); // Binance Spot=2, Binance USD-M=3
  assert.equal(isInternalTransfer(2, 3, known), true);
  const { type, effects } = classifyTransfer({ sourceAccountId: 2, destinationAccountId: 3, knownAccountIds: known });
  assert.equal(type, "INTERNAL_TRANSFER");
  assert.equal(effects.source_account_balance, "DECREASE");
  assert.equal(effects.destination_account_balance, "INCREASE");
  assert.equal(effects.net_worth.transfer, "NONE");
  assert.equal(effects.net_worth.principal, "NONE");
  assert.equal(effects.net_worth.external_movement, "NONE");
});

// ================== N. Executed BUY with fee ==================
test("N - Executed BUY con fee > 0: principal neutral, fee DECREASE", () => {
  const r = getTransactionEffects({ status: "EXECUTED", type: "BUY", fee: 4.5 });
  assert.equal(r.net_worth.principal, "NONE");
  assert.equal(r.net_worth.fee, "DECREASE");
});

test("N2 - Executed BUY con fee ausente (undefined): fee DATA_UNAVAILABLE + warning, nunca asumido 0", () => {
  const r = getTransactionEffects({ status: "EXECUTED", type: "BUY" });
  assert.equal(r.net_worth.fee, "DATA_UNAVAILABLE");
  assert.ok(r.warnings.includes("FEE_UNKNOWN"));
});

test("N3 - Executed SELL con fee = 0 explicito: fee NONE, no DATA_UNAVAILABLE", () => {
  const r = getTransactionEffects({ status: "EXECUTED", type: "SELL", fee: 0 });
  assert.equal(r.net_worth.fee, "NONE");
  assert.equal(r.holdings, "DECREASE");
  assert.equal(r.realized_pnl, "UPDATE");
});

// ================== O1. External -> ARQ (deposito) ==================
test("O1 - External -> ARQ: EXTERNAL_DEPOSIT, NW increase", () => {
  const known = new Set([1]); // ARQ=1
  const { type, effects } = classifyTransfer({ sourceAccountId: null, destinationAccountId: 1, knownAccountIds: known });
  assert.equal(type, "EXTERNAL_DEPOSIT");
  assert.equal(effects.destination_account_balance, "INCREASE");
  assert.equal(effects.net_worth.external_movement, "INCREASE");
  assert.equal(effects.source_account_balance, "NONE");
});

// ================== O2. ARQ -> External (retiro) ==================
test("O2 - ARQ -> External: EXTERNAL_WITHDRAWAL, NW decrease", () => {
  const known = new Set([1]);
  const { type, effects } = classifyTransfer({ sourceAccountId: 1, destinationAccountId: null, knownAccountIds: known });
  assert.equal(type, "EXTERNAL_WITHDRAWAL");
  assert.equal(effects.source_account_balance, "DECREASE");
  assert.equal(effects.net_worth.external_movement, "DECREASE");
  assert.equal(effects.destination_account_balance, "NONE");
});

// ================== O3. Direccion indeterminable ==================
test("O3 - Ningun extremo identificado: TRANSFER_DIRECTION_UNKNOWN, cero efecto NW inventado", () => {
  const known = new Set([1, 2, 3]);
  const { type, effects } = classifyTransfer({ sourceAccountId: null, destinationAccountId: null, knownAccountIds: known });
  assert.equal(type, "TRANSFER_DIRECTION_UNKNOWN");
  assert.equal(effects.net_worth.external_movement, "NONE");
  assert.equal(effects.net_worth.transfer, "NONE");
  assert.equal(effects.source_account_balance, "NONE");
  assert.equal(effects.destination_account_balance, "NONE");
  assert.ok(effects.warnings.includes("TRANSFER_DIRECTION_UNKNOWN"));
});

// ================== PENDING reserved cash, con y sin evidencia ==================
test("PENDING con reserved_cash=true explicito: cash_reserved INCREASE", () => {
  const r = getTransactionEffects({ status: "PENDING", type: "SELL", reserved_cash: true });
  assert.equal(r.cash_reserved, "INCREASE");
  assert.equal(r.warnings.includes("PENDING_RESERVED_CASH_NO_EVIDENCE"), false);
});

test("PENDING sin campo reserved_cash: cash_reserved NONE, nunca asumido bloqueado", () => {
  const r = getTransactionEffects({ status: "PENDING", type: "BUY" });
  assert.equal(r.cash_reserved, "NONE");
});

test("CANCELLED: todos los efectos NONE", () => {
  const r = getTransactionEffects({ status: "CANCELLED" });
  assert.deepEqual(r.holdings, "NONE");
  assert.deepEqual(r.net_worth, { principal: "NONE", fee: "NONE", transfer: "NONE", external_movement: "NONE" });
});

test("REJECTED: todos los efectos NONE", () => {
  const r = getTransactionEffects({ status: "REJECTED" });
  assert.equal(r.holdings, "NONE");
  assert.equal(r.cash_balance, "NONE");
});

// ================== Validacion de errores (programming errors -> throw) ==================
test("getTransactionEffects: status invalido -> throw", () => {
  assert.throws(() => getTransactionEffects({ status: "BOGUS" }));
});

test("getTransactionEffects: EXECUTED sin type -> throw", () => {
  assert.throws(() => getTransactionEffects({ status: "EXECUTED" }));
});

test("getTransactionEffects: fee no numerico -> throw", () => {
  assert.throws(() => getTransactionEffects({ status: "EXECUTED", type: "BUY", fee: "cinco" }));
});

test("getTransactionEffects: sin argumento -> throw", () => {
  assert.throws(() => getTransactionEffects());
});

test("classifyTransfer: falta destinationAccountId -> throw", () => {
  assert.throws(() => classifyTransfer({ sourceAccountId: 1, knownAccountIds: [1] }));
});

test("isInternalTransfer: knownAccountIds invalido -> throw", () => {
  assert.throws(() => isInternalTransfer(1, 2, "no-es-un-set"));
});

test("isInternalTransfer: acepta array ademas de Set", () => {
  assert.equal(isInternalTransfer(1, 2, [1, 2]), true);
  assert.equal(isInternalTransfer(1, 99, [1, 2]), false);
});

// ================== C. Ledger BTC balance snapshot ==================
test("C - Ledger BTC: owned=available=0.46996, encumbered=0", () => {
  const r = computeAssetOwnership("BTC", [{ asset_id: "BTC", owned_value: 0.46996, encumbered_value: 0 }]);
  assert.equal(r.owned, 0.46996);
  assert.equal(r.available, 0.46996);
  assert.equal(r.encumbered, 0);
});

test("computeAssetOwnership: encumbrance desconocida -> owned conocido, available/encumbered DATA_UNAVAILABLE", () => {
  const r = computeAssetOwnership("BTC", [{ asset_id: "BTC", owned_value: 0.05 }]);
  assert.equal(r.owned, 0.05);
  assert.equal(r.available, "DATA_UNAVAILABLE");
  assert.equal(r.encumbered, "DATA_UNAVAILABLE");
});

test("computeAssetOwnership: asset sin entradas -> todo 0", () => {
  const r = computeAssetOwnership("ETH", [{ asset_id: "BTC", owned_value: 1, encumbered_value: 0 }]);
  assert.equal(r.owned, 0);
  assert.equal(r.available, 0);
});

// ================== getAccountEquity ==================
test("getAccountEquity: equity explicita del proveedor -> se usa esa, sin recalcular", () => {
  const r = getAccountEquity({ asset_id: "USDT", equity_value: 5000, wallet_balance_value: 999 }, "futures");
  assert.equal(r.status, "OK");
  assert.equal(r.value, 5000);
});

test("getAccountEquity: spot sin equity explicita -> usa wallet_balance_value", () => {
  const r = getAccountEquity({ asset_id: "BTC", wallet_balance_value: 0.5 }, "spot");
  assert.equal(r.status, "OK");
  assert.equal(r.value, 0.5);
});

test("getAccountEquity: spot sin wallet_balance_value -> DATA_UNAVAILABLE, nunca 0", () => {
  const r = getAccountEquity({ asset_id: "BTC" }, "spot");
  assert.equal(r.status, "DATA_UNAVAILABLE");
});

test("getAccountEquity: futures con los 3 componentes -> suma", () => {
  const r = getAccountEquity({ asset_id: "USDT", available_balance_value: 100, margin_balance_value: 50, unrealized_pnl_value: -5 }, "futures");
  assert.equal(r.status, "OK");
  assert.equal(r.value, 145);
});

test("getAccountEquity: futures con un componente faltante -> DATA_UNAVAILABLE, nunca asume 0", () => {
  const r = getAccountEquity({ asset_id: "USDT", available_balance_value: 100, margin_balance_value: 50 }, "futures");
  assert.equal(r.status, "DATA_UNAVAILABLE");
});

// ================== M. Double-count prevention ==================
test("M - Binance Spot holding + Binance Spot account_equity: NO se suman ambos, gana account_equity", () => {
  const holdings = [{ account_id: 2, asset_id: "BTC", value: 1000 }];
  const accountEquities = [{ account_id: 2, value: 1200 }];
  const r = computeNetWorth({ holdings, accountEquities });
  assert.equal(r.value, 1200); // NUNCA 2200
  assert.equal(r.conflicts.length, 1);
  assert.equal(r.conflicts[0].resolution, "USED_ACCOUNT_EQUITY");
});

test("M2 - Mismo conflicto pero equity DATA_UNAVAILABLE (null) -> cae a holdings, sigue sin sumar ambos", () => {
  const holdings = [{ account_id: 2, asset_id: "BTC", value: 1000 }];
  const accountEquities = [{ account_id: 2, value: null }];
  const r = computeNetWorth({ holdings, accountEquities });
  assert.equal(r.value, 1000);
  assert.equal(r.conflicts[0].resolution, "USED_HOLDINGS_FALLBACK");
});

test("computeNetWorth: cuentas sin overlap se suman normal, holdings sin account_id nunca conflictan", () => {
  const holdings = [
    { account_id: null, asset_id: "AAPL", value: 500 }, // posicion legacy sin account_id
    { account_id: 5, asset_id: "BTC", value: 300 }, // Ledger, solo holdings
  ];
  const accountEquities = [{ account_id: 3, value: 800 }]; // Binance USD-M, solo equity
  const r = computeNetWorth({ holdings, accountEquities });
  assert.equal(r.value, 500 + 300 + 800);
  assert.equal(r.conflicts.length, 0);
  assert.equal(r.missingComponents.length, 0);
});

test("computeNetWorth: cuenta solo en accountEquities con value null -> missingComponents, no se rellena con 0", () => {
  const r = computeNetWorth({ holdings: [], accountEquities: [{ account_id: 9, value: null }] });
  assert.equal(r.value, 0);
  assert.deepEqual(r.missingComponents, [9]);
});

// ================== F. COIN-M semantica no verificada ==================
test("F - COIN-M sin entrada en el registry: UNIT_SEMANTICS_UNVERIFIED, nada derivado", () => {
  const rawFacts = { position_quantity_value: 0.0514, position_quantity_unit: "BTC", entry_price: null, price_currency: null };
  const key = "binance::coin_margined_futures::BTCUSD_PERP::perpetual";
  const r = deriveNotional(rawFacts, key, {}); // registry vacio -- el caso real hoy
  assert.equal(r.status, "UNIT_SEMANTICS_UNVERIFIED");
  assert.equal(r.underlying_equivalent_value, null);
  assert.equal(r.notional_value, null);
  assert.ok(r.warnings.includes("UNIT_SEMANTICS_UNVERIFIED"));
});

test("deriveNotional: key desconocida en absoluto (registry con otras keys) -> tambien UNVERIFIED", () => {
  const rawFacts = { position_quantity_value: 1, position_quantity_unit: "ETH" };
  const r = deriveNotional(rawFacts, "otra::key::no::relacionada", { "algo::mas": { mode: "DIRECT_QUANTITY_IS_UNDERLYING" } });
  assert.equal(r.status, "UNIT_SEMANTICS_UNVERIFIED");
});

test("deriveNotional: modo VERIFIED (DIRECT_QUANTITY_IS_UNDERLYING) sintetico, con precio -> notional calculado", () => {
  const rawFacts = { position_quantity_value: 2, entry_price: 100, price_currency: "USD" };
  const key = "test::linear::FOO::perpetual";
  const registry = { [key]: { mode: "DIRECT_QUANTITY_IS_UNDERLYING", underlyingAssetId: "FOO" } };
  const r = deriveNotional(rawFacts, key, registry);
  assert.equal(r.status, "VERIFIED");
  assert.equal(r.underlying_equivalent_value, 2);
  assert.equal(r.underlying_equivalent_asset_id, "FOO");
  assert.equal(r.notional_value, 200);
  assert.equal(r.notional_asset_id, "USD");
});

test("deriveNotional: modo VERIFIED pero sin precio -> underlying_equivalent conocido, notional null + warning", () => {
  const rawFacts = { position_quantity_value: 2 };
  const key = "test::linear::FOO::perpetual";
  const registry = { [key]: { mode: "DIRECT_QUANTITY_IS_UNDERLYING", underlyingAssetId: "FOO" } };
  const r = deriveNotional(rawFacts, key, registry);
  assert.equal(r.status, "VERIFIED");
  assert.equal(r.notional_value, null);
  assert.ok(r.warnings.includes("NOTIONAL_PRICE_MISSING"));
});

// ================== computeDerivativeExposure ==================
test("computeDerivativeExposure: long y short verificados -> gross suma abs, net resta", () => {
  const snapshots = [
    { instrument: "BTCUSDT", side: "long", notional_value: 700, notional_asset_id: "USDT", unit_semantics_status: "VERIFIED" },
    { instrument: "ETHUSDT", side: "short", notional_value: 300, notional_asset_id: "USDT", unit_semantics_status: "VERIFIED" },
  ];
  const r = computeDerivativeExposure(snapshots, { notionalAssetId: "USDT" });
  assert.equal(r.gross, 1000);
  assert.equal(r.net, 400);
  assert.equal(r.excludedUnverified.length, 0);
});

test("computeDerivativeExposure: posicion UNVERIFIED se excluye del calculo pero se reporta, nunca se pierde en silencio", () => {
  const snapshots = [
    { instrument: "BTCUSDT", side: "long", notional_value: 700, notional_asset_id: "USDT", unit_semantics_status: "VERIFIED" },
    { instrument: "BTCUSD_PERP", side: "long", notional_value: null, notional_asset_id: null, unit_semantics_status: "UNIT_SEMANTICS_UNVERIFIED" },
  ];
  const r = computeDerivativeExposure(snapshots, { notionalAssetId: "USDT" });
  assert.equal(r.gross, 700);
  assert.deepEqual(r.excludedUnverified, ["BTCUSD_PERP"]);
});

test("computeDerivativeExposure: asset distinto al pedido se excluye por mismatch, no se convierte a ciegas", () => {
  const snapshots = [
    { instrument: "BTCUSD_PERP", side: "long", notional_value: 0.05, notional_asset_id: "BTC", unit_semantics_status: "VERIFIED" },
  ];
  const r = computeDerivativeExposure(snapshots, { notionalAssetId: "USDT" });
  assert.equal(r.gross, 0);
  assert.deepEqual(r.excludedAssetMismatch, ["BTCUSD_PERP"]);
});

// ================== computeEffectiveExposure ==================
test("computeEffectiveExposure: owned + derivative net, status OK sin exclusiones", () => {
  const ownership = { owned: 0.5, available: 0.5, encumbered: 0 };
  const exposure = { gross: 0.1, net: 0.1, excludedUnverified: [], excludedAssetMismatch: [] };
  const r = computeEffectiveExposure(ownership, exposure);
  assert.equal(r.status, "OK");
  assert.equal(r.value, 0.6);
});

test("computeEffectiveExposure: con posiciones excluidas -> status PARTIAL, warning explicito", () => {
  const ownership = { owned: 0.5, available: 0.5, encumbered: 0 };
  const exposure = { gross: 0, net: 0, excludedUnverified: ["BTCUSD_PERP"], excludedAssetMismatch: [] };
  const r = computeEffectiveExposure(ownership, exposure);
  assert.equal(r.status, "PARTIAL");
  assert.ok(r.warnings.includes("EXCLUDED_UNVERIFIED_POSITIONS"));
});

test("computeEffectiveExposure: ownership.owned no numerico -> DATA_UNAVAILABLE, nunca inventa un total", () => {
  const r = computeEffectiveExposure({ owned: "DATA_UNAVAILABLE" }, { net: 5 });
  assert.equal(r.status, "DATA_UNAVAILABLE");
  assert.equal(r.value, null);
});

// ================== D. USD-M primer snapshot (sin candidatas) ==================
test("D - USD-M primera vez, sin candidatas OPEN: NEW_POSITION", () => {
  const facts = { account_id: 3, instrument: "BTCUSDT", side: "long", contract_type: "perpetual", provider_position_id: null, margin_mode: "isolated" };
  const r = matchDerivativePositionIdentity(facts, []);
  assert.equal(r.decision, "NEW_POSITION");
  assert.equal(r.matchedPositionId, null);
});

// ================== E. USD-M snapshot actualizado (misma posicion) ==================
test("E - USD-M snapshot actualizado: misma cuenta/instrumento/side/contract_type OPEN -> MATCH_EXISTING_HIGH, mismo id", () => {
  const existing = [{ id: 42, account_id: 3, instrument: "BTCUSDT", side: "long", contract_type: "perpetual", status: "OPEN", provider_position_id: null, margin_mode: "isolated" }];
  const facts = { account_id: 3, instrument: "BTCUSDT", side: "long", contract_type: "perpetual", provider_position_id: null, margin_mode: "isolated" };
  const r = matchDerivativePositionIdentity(facts, existing);
  assert.equal(r.decision, "MATCH_EXISTING_HIGH");
  assert.equal(r.matchedPositionId, 42);
  assert.equal(r.reconciliation_confidence, "HIGH");
});

test("E2 - margin_mode cambia respecto al candidato existente: baja a MEDIUM, no crea posicion nueva ni AMBIGUOUS", () => {
  const existing = [{ id: 42, account_id: 3, instrument: "BTCUSDT", side: "long", contract_type: "perpetual", status: "OPEN", provider_position_id: null, margin_mode: "isolated" }];
  const facts = { account_id: 3, instrument: "BTCUSDT", side: "long", contract_type: "perpetual", provider_position_id: null, margin_mode: "cross" };
  const r = matchDerivativePositionIdentity(facts, existing);
  assert.equal(r.decision, "MATCH_EXISTING_MEDIUM");
  assert.equal(r.matchedPositionId, 42);
  assert.equal(r.reconciliation_confidence, "MEDIUM");
});

// ================== G. Close/reopen mismo dia ==================
test("G - Posicion previa CLOSED no participa en el match: nueva evidencia OPEN -> NEW_POSITION", () => {
  const existing = [{ id: 10, account_id: 3, instrument: "BTCUSDT", side: "long", contract_type: "perpetual", status: "CLOSED", provider_position_id: null, margin_mode: "isolated" }];
  const facts = { account_id: 3, instrument: "BTCUSDT", side: "long", contract_type: "perpetual", provider_position_id: null, margin_mode: "isolated" };
  const r = matchDerivativePositionIdentity(facts, existing);
  assert.equal(r.decision, "NEW_POSITION"); // el CLOSED se filtra, nunca se reengancha
});

// ================== H. Hedge mode ==================
test("H - Hedge mode: existe LONG OPEN, llega evidencia SHORT del mismo instrumento -> NEW_POSITION, nunca se fusionan", () => {
  const existing = [{ id: 20, account_id: 3, instrument: "BTCUSDT", side: "long", contract_type: "perpetual", status: "OPEN", provider_position_id: null, margin_mode: "isolated" }];
  const factsShort = { account_id: 3, instrument: "BTCUSDT", side: "short", contract_type: "perpetual", provider_position_id: null, margin_mode: "isolated" };
  const r = matchDerivativePositionIdentity(factsShort, existing);
  assert.equal(r.decision, "NEW_POSITION"); // side distinto = tupla distinta desde el inicio
});

// ================== J. Identidad ambigua ==================
test("J - Tupla coincide pero provider_position_id conflictivo: POSITION_IDENTITY_AMBIGUOUS, no merge ni new silencioso", () => {
  const existing = [{ id: 30, account_id: 3, instrument: "BTCUSDT", side: "long", contract_type: "perpetual", status: "OPEN", provider_position_id: "OLD_ID_999", margin_mode: "isolated" }];
  const facts = { account_id: 3, instrument: "BTCUSDT", side: "long", contract_type: "perpetual", provider_position_id: "NEW_ID_123", margin_mode: "isolated" };
  const r = matchDerivativePositionIdentity(facts, existing);
  assert.equal(r.decision, "POSITION_IDENTITY_AMBIGUOUS");
  assert.equal(r.matchedPositionId, null);
  assert.equal(r.reconciliation_confidence, "AMBIGUOUS");
});

test("matchDerivativePositionIdentity: provider_position_id coincide exacto -> HIGH, gana sobre la tupla", () => {
  const existing = [{ id: 55, account_id: 3, instrument: "BTCUSDT", side: "long", contract_type: "perpetual", status: "OPEN", provider_position_id: "ABC123", margin_mode: "isolated" }];
  const facts = { account_id: 3, instrument: "BTCUSDT", side: "long", contract_type: "perpetual", provider_position_id: "ABC123", margin_mode: "isolated" };
  const r = matchDerivativePositionIdentity(facts, existing);
  assert.equal(r.decision, "MATCH_EXISTING_HIGH");
  assert.equal(r.matchedPositionId, 55);
  assert.ok(r.reasons.includes("provider_position_id_match"));
});

test("matchDerivativePositionIdentity: side ausente -> INSUFFICIENT_DATA, resultado estructurado, no throw", () => {
  const facts = { account_id: 3, instrument: "BTCUSDT", contract_type: "perpetual" };
  const r = matchDerivativePositionIdentity(facts, []);
  assert.equal(r.decision, "INSUFFICIENT_DATA");
});

test("matchDerivativePositionIdentity: account_id faltante -> throw (error de programacion)", () => {
  assert.throws(() => matchDerivativePositionIdentity({ instrument: "BTCUSDT", side: "long", contract_type: "perpetual" }, []));
});

test("matchDerivativePositionIdentity: dos candidatas OPEN con la misma tupla (violacion hipotetica) -> AMBIGUOUS defensivo", () => {
  const existing = [
    { id: 1, account_id: 3, instrument: "BTCUSDT", side: "long", contract_type: "perpetual", status: "OPEN", provider_position_id: null },
    { id: 2, account_id: 3, instrument: "BTCUSDT", side: "long", contract_type: "perpetual", status: "OPEN", provider_position_id: null },
  ];
  const facts = { account_id: 3, instrument: "BTCUSDT", side: "long", contract_type: "perpetual", provider_position_id: null };
  const r = matchDerivativePositionIdentity(facts, existing);
  assert.equal(r.decision, "POSITION_IDENTITY_AMBIGUOUS");
});
