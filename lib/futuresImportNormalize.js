// lib/futuresImportNormalize.js
// Normalizacion pura para Smart Import Futures. Convierte la extraccion
// RAW de un FUTURES_ACCOUNT_SNAPSHOT o FUTURES_POSITION_SNAPSHOT al shape
// que ya esperan getAccountEquity()/routeDerivativeImportBatch()/
// routeDerivativeSnapshot() -- ninguna logica de negocio nueva vive aqui,
// solo el puente entre "lo que el modelo de vision devuelve" y "lo que
// el Reconciliation Engine ya sabe procesar".

import { getAccountEquity } from "./reconciliationEngine.js";

// ================== FUTURES_ACCOUNT_SNAPSHOT ==================
// raw: { document_type, account:{provider,account_type,product_type},
//        observed_at, balances:[{asset_symbol, wallet_balance:{value,confidence,evidence_text}, ...}] }
// accountId/assetIdBysímbolo: resueltos por el endpoint (I/O), esta
// funcion nunca resuelve tickers/cuentas por su cuenta.
export function normalizeFuturesAccountBalance(rawBalance, accountContext) {
  const balanceRow = {
    wallet_balance_value: rawBalance.wallet_balance?.value ?? null,
    margin_balance_value: rawBalance.margin_balance?.value ?? null,
    available_balance_value: rawBalance.available_balance?.value ?? null,
    unrealized_pnl_value: rawBalance.unrealized_pnl?.value ?? null,
    initial_margin_value: rawBalance.initial_margin?.value ?? null,
    maintenance_margin_value: rawBalance.maintenance_margin?.value ?? null,
    equity_value: null, // Binance/exchanges no suelen mostrar "equity" con ese nombre exacto -- casi siempre se deriva
  };

  const equityResult = getAccountEquity(balanceRow, accountContext);

  const warnings = [];
  if (equityResult.status === "REQUIRES_REVIEW") warnings.push("ACCOUNT_EQUITY_RECONCILIATION_MISMATCH");
  if (equityResult.status === "DATA_UNAVAILABLE") warnings.push("ACCOUNT_EQUITY_DATA_UNAVAILABLE");

  return {
    asset_symbol: rawBalance.asset_symbol,
    wallet_balance_value: balanceRow.wallet_balance_value,
    margin_balance_value: balanceRow.margin_balance_value,
    available_balance_value: balanceRow.available_balance_value,
    unrealized_pnl_value: balanceRow.unrealized_pnl_value,
    initial_margin_value: balanceRow.initial_margin_value,
    maintenance_margin_value: balanceRow.maintenance_margin_value,
    equity_value: equityResult.value,
    equity_source_type: equityResult.provenance,
    equity_status: equityResult.status,
    equity_reported_candidate: equityResult.reported_candidate,
    equity_derived_candidate: equityResult.derived_candidate,
    // encumbered: siempre DATA_UNAVAILABLE en Fase 1 -- ENCUMBERED_WHITELIST
    // vacia a proposito (misma decision que unitSemanticsRegistry para COIN-M).
    encumbered_collateral: "DATA_UNAVAILABLE",
    warnings,
  };
}

// ================== FUTURES_POSITION_SNAPSHOT ==================
// raw: { document_type, account_ref, instrument, side, leverage, margin_mode,
//        position_quantity:{value,unit,confidence,evidence_text}, margin_used:{...},
//        entry_price:{...}, mark_price:{...}, liquidation_price:{...},
//        unrealized_pnl:{...}, roi_pct:{...}, notional:{...} }
//
// unit_semantics_status: SIEMPRE UNIT_SEMANTICS_UNVERIFIED en Fase 1 --
// el registry de deriveNotional() sigue vacio a proposito (misma regla
// ya aprobada para COIN-M, aplicada aqui de forma pareja a todo producto
// hasta que se verifique explicitamente).
export function normalizeFuturesPositionFacts(raw) {
  const warnings = [];
  if (raw.side?.value == null) warnings.push("POSITION_SIDE_UNVERIFIED");

  return {
    instrument: raw.instrument?.value ?? null,
    contract_type: raw.contract_type ?? null, // "USD_M" | "COIN_M", decidido por el endpoint segun el account context, no por el modelo
    side: raw.side?.value ?? null,
    leverage: raw.leverage?.value ?? null,
    margin_mode: raw.margin_mode?.value ?? null,
    provider_position_id: raw.provider_position_id?.value ?? null,
    position_quantity_value: raw.position_quantity?.value ?? null,
    position_quantity_unit: raw.position_quantity?.unit ?? null,
    margin_used_value: raw.margin_used?.value ?? null,
    entry_price: raw.entry_price?.value ?? null,
    mark_price: raw.mark_price?.value ?? null,
    liquidation_price: raw.liquidation_price?.value ?? null,
    price_currency: raw.price_currency?.value ?? null,
    unrealized_pnl_value: raw.unrealized_pnl?.value ?? null,
    roi_pct: raw.roi_pct?.value ?? null,
    // notional_value/underlying_equivalent_value: NUNCA se copian directo
    // del modelo -- se derivan (o no) exclusivamente via deriveNotional(),
    // que ya vive en reconciliationEngine.js. Este normalizador no calcula
    // notional; el endpoint llama deriveNotional() por separado.
    notional_value_raw_hint: raw.notional?.value ?? null, // solo para cross-check opcional, nunca fuente de verdad
    unit_semantics_status: "UNIT_SEMANTICS_UNVERIFIED",
    warnings,
  };
}

// ================== Deteccion de tipo de documento ==================
// Pura: dado el document_type ya extraido por el modelo, decide a que
// pipeline de normalizacion enrutar. No adivina el tipo por su cuenta --
// eso es responsabilidad del modelo de vision + su schema.
export const KNOWN_DOCUMENT_TYPES = [
  "PURCHASE_CONFIRMATION",
  "SALE_CONFIRMATION",
  "SPOT_ACCOUNT_SNAPSHOT",
  "FUTURES_ACCOUNT_SNAPSHOT",
  "FUTURES_POSITION_SNAPSHOT",
  "UNKNOWN",
];

export function classifyDocumentType(documentType) {
  if (KNOWN_DOCUMENT_TYPES.includes(documentType)) return documentType;
  return "UNKNOWN";
}
