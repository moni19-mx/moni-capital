import test from "node:test";
import assert from "node:assert/strict";
import {
  getTransactionEffects, isInternalTransfer, classifyTransfer,
  getAccountEquity, computeNetWorth, computeAssetOwnership,
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
