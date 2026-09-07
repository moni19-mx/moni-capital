// lib/futuresImportNormalize.js
// Normalizacion pura para Smart Import Futures. Convierte la extraccion
// RAW de un FUTURES_ACCOUNT_SNAPSHOT o FUTURES_POSITION_SNAPSHOT al shape
// que ya esperan getAccountEquity()/routeDerivativeImportBatch()/
// routeDerivativeSnapshot() -- ninguna logica de negocio nueva vive aqui,
// solo el puente entre "lo que el modelo de vision devuelve" y "lo que
// el Reconciliation Engine ya sabe procesar".

import { getAccountEquity } from "./reconciliationEngine.js";

// ================== Normalizacion de account context (Fase Account Context Fix) ==================

const PROVIDER_NORMALIZATION = { binance: "BINANCE" };

export function normalizeProvider(rawValue) {
  if (!rawValue) return null;
  const key = rawValue.trim().toLowerCase();
  return PROVIDER_NORMALIZATION[key] ?? null; // proveedor no reconocido -> null, nunca se inventa
}

// Mapping exacto/verificado -- sin fuzzy matching. El caracter especial
// "Ⓢ"/"Ⓜ" es literalmente el que Binance usa en su UI (confirmado contra
// la extraccion real de la captura de USD-M).
const PRODUCT_TYPE_NORMALIZATION = {
  "usdⓢ-m": "USD_M",
  "usd-m": "USD_M",
  "usdt-m": "USD_M",
  "coin-m": "COIN_M",
  "coinⓜ-m": "COIN_M",
};

export function normalizeProductType(rawValue) {
  if (!rawValue) return { value: null, status: "UNKNOWN_PRODUCT_TYPE" };
  const key = rawValue.trim().toLowerCase();
  if (key in PRODUCT_TYPE_NORMALIZATION) return { value: PRODUCT_TYPE_NORMALIZATION[key], status: "NORMALIZED" };
  return { value: null, status: "UNKNOWN_PRODUCT_TYPE" };
}

const ACCOUNT_TYPE_NORMALIZATION = { futures: "FUTURES", spot: "SPOT", wallet: "WALLET", broker: "BROKER" };

export function normalizeAccountType(rawValue) {
  if (!rawValue) return null;
  return ACCOUNT_TYPE_NORMALIZATION[rawValue.trim().toLowerCase()] ?? null;
}

// ==================================================
// resolveAccountContext -- PURA. `accounts` ya viene cargado desde
// Supabase por el endpoint (I/O separado). Nunca usa accounts.name para
// matching -- solo provider/account_type/product_type.
// ==================================================
export function resolveAccountContext({ selectedAccountId, rawProvider, rawProductType, accounts }) {
  const baseRaw = { rawProvider: rawProvider ?? null, rawProductType: rawProductType ?? null };

  // A. Seleccion explicita del usuario -- gana siempre, fuente autoritativa.
  if (selectedAccountId != null) {
    const account = (accounts || []).find((a) => a.id === selectedAccountId);
    if (!account) {
      return { status: "UNKNOWN_ACCOUNT", accountId: null, provider: null, accountType: null, productType: null, contextSource: null, ...baseRaw, warnings: ["SELECTED_ACCOUNT_NOT_FOUND"] };
    }
    const warnings = [];
    // Deteccion de conflicto: compara el texto crudo visual contra el
    // provider de la cuenta seleccionada -- NUNCA requiere que
    // normalizeProvider() reconozca el valor visual (un proveedor no
    // reconocido, ej. "OKX", igual debe poder generar el conflicto).
    const accountProviderLower = account.provider ? account.provider.trim().toLowerCase() : null;
    const rawProviderLower = rawProvider ? rawProvider.trim().toLowerCase() : null;
    if (rawProviderLower != null && accountProviderLower != null && rawProviderLower !== accountProviderLower) {
      warnings.push("ACCOUNT_CONTEXT_VISUAL_CONFLICT");
    }
    return {
      status: "MATCHED_ACCOUNT",
      accountId: account.id,
      provider: account.provider ? account.provider.toUpperCase() : null,
      accountType: normalizeAccountType(account.account_type),
      productType: account.product_type ?? null,
      contextSource: "USER_SELECTED_ACCOUNT",
      ...baseRaw,
      warnings,
    };
  }

  // B. Sin seleccion -- resolver por evidencia visual normalizada.
  const providerNorm = normalizeProvider(rawProvider);
  const productTypeResult = normalizeProductType(rawProductType);

  if (providerNorm == null || productTypeResult.value == null) {
    const warnings = productTypeResult.status === "UNKNOWN_PRODUCT_TYPE" && rawProductType != null ? ["UNKNOWN_PRODUCT_TYPE"] : [];
    return { status: "UNKNOWN_ACCOUNT", accountId: null, provider: null, accountType: null, productType: null, contextSource: null, ...baseRaw, warnings };
  }

  const matches = (accounts || []).filter(
    (a) => a.provider != null && a.provider.toUpperCase() === providerNorm && a.product_type === productTypeResult.value
  );

  if (matches.length === 1) {
    return {
      status: "MATCHED_ACCOUNT", accountId: matches[0].id, provider: providerNorm,
      accountType: normalizeAccountType(matches[0].account_type), productType: productTypeResult.value,
      contextSource: "VISUAL_ACCOUNT_MATCH", ...baseRaw, warnings: [],
    };
  }
  if (matches.length === 0) {
    return { status: "UNKNOWN_ACCOUNT", accountId: null, provider: providerNorm, accountType: null, productType: productTypeResult.value, contextSource: null, ...baseRaw, warnings: [] };
  }
  return { status: "ACCOUNT_AMBIGUOUS", accountId: null, provider: providerNorm, accountType: null, productType: productTypeResult.value, contextSource: null, ...baseRaw, warnings: [] };
}

// ==================================================
// Clasificacion de balances para persistence -- Fase Confirm
// ==================================================
// A. Economicamente irrelevante (TODOS los campos economicos en 0/null):
//    se ignora en V1, nunca bloquea, nunca genera warning de "parcial".
// B. Relevante + equity resuelto (status OK): se persiste.
// C. Relevante + equity NO resuelto (DATA_UNAVAILABLE/REQUIRES_REVIEW):
//    bloquea TODO el confirm -- nunca se persiste una cuenta a medias
//    sin que el usuario lo sepa.
export function isEconomicallyIrrelevant(balance) {
  const fields = [balance.wallet_balance_value, balance.margin_balance_value, balance.available_balance_value, balance.unrealized_pnl_value];
  return fields.every((v) => v == null || v === 0);
}

export function classifyBalanceForPersistence(balance) {
  if (isEconomicallyIrrelevant(balance)) return "IGNORE";
  if (balance.equity_status === "OK") return "PERSIST";
  return "REVIEW";
}

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

// ================== Normalizacion de identidad de posicion ==================
// La extraccion de vision usa mayusculas (LONG/SHORT, ISOLATED/CROSS) por
// legibilidad del schema, pero los CHECK reales de derivative_positions
// exigen minusculas ('long'/'short', 'isolated'/'cross'). Sin esta
// normalizacion, cualquier INSERT fallaria por CHECK violation, o peor,
// dos identidades equivalentes con distinto casing podrian evadir el
// UNIQUE INDEX de identidad (ej. "BTCUSDT"+"LONG" vs "BTCUSDT"+"long"
// contarian como filas distintas).
const POSITION_SIDE_NORMALIZATION = { long: "long", short: "short" };
const MARGIN_MODE_NORMALIZATION = { isolated: "isolated", cross: "cross" };

export function normalizePositionSide(rawValue) {
  if (!rawValue) return null;
  return POSITION_SIDE_NORMALIZATION[rawValue.trim().toLowerCase()] ?? null;
}

export function normalizeMarginModeValue(rawValue) {
  if (!rawValue) return null;
  return MARGIN_MODE_NORMALIZATION[rawValue.trim().toLowerCase()] ?? null;
}

// ================== FUTURES_POSITION_SNAPSHOT ==================
// raw: { document_type, account_ref, instrument, side, leverage, margin_mode,
//        position_quantity:{value,unit,confidence,evidence_text}, margin_used:{...},
//        entry_price:{...}, mark_price:{...}, liquidation_price:{...},
//        unrealized_pnl:{...}, roi_pct:{...}, notional:{...} }
//
// contract_type NUNCA viene de raw -- la extraccion de vision no lo
// produce (no es visible como texto discreto de forma confiable). Lo
// resuelve el endpoint segun contexto (ej. "Perp." visible -> "perpetual"),
// se recibe aqui ya resuelto vía el segundo parametro.
//
// unit_semantics_status: SIEMPRE UNIT_SEMANTICS_UNVERIFIED en Fase 1 --
// el registry de deriveNotional() sigue vacio a proposito (misma regla
// ya aprobada para COIN-M, aplicada aqui de forma pareja a todo producto
// hasta que se verifique explicitamente).
export function normalizeFuturesPositionFacts(raw, contractType = null) {
  const warnings = [];
  if (raw.side?.value == null) warnings.push("POSITION_SIDE_UNVERIFIED");

  const normalizedSide = normalizePositionSide(raw.side?.value);
  if (raw.side?.value != null && normalizedSide == null) warnings.push("POSITION_SIDE_UNRECOGNIZED");

  return {
    instrument: raw.instrument?.value ? raw.instrument.value.trim().toUpperCase() : null,
    contract_type: contractType,
    side: normalizedSide,
    leverage: raw.leverage?.value ?? null,
    margin_mode: normalizeMarginModeValue(raw.margin_mode?.value),
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
