// lib/smartImportNormalize.js
// Nucleo 100% puro de normalizacion para Smart Import Phase 1. Ninguna
// funcion aqui hace fetch ni conoce Supabase -- reciben datos ya
// resueltos (asset, cuentas candidatas) y devuelven decisiones
// deterministicas. El endpoint real (api/smart-import.js) hace el I/O y
// llama a estas funciones, nunca al reves.

// ================== STATUS ==================
// Mapeo deterministico texto->enum. La confianza de haber leido bien el
// texto NUNCA se sube a HIGH solo porque el mapeo en si sea una tabla
// fija -- se hereda del campo RAW correspondiente.
const STATUS_MAPPING_TABLE = {
  pendiente: "PENDING", pending: "PENDING", procesando: "PENDING", processing: "PENDING",
  filled: "EXECUTED", ejecutada: "EXECUTED", executed: "EXECUTED", completada: "EXECUTED", completed: "EXECUTED",
  cancelada: "CANCELLED", cancelled: "CANCELLED", canceled: "CANCELLED",
  rechazada: "REJECTED", rejected: "REJECTED",
};

export function normalizeStatus(transactionRaw) {
  const textRaw = transactionRaw?.status_text_raw;
  const guess = transactionRaw?.status_model_guess;
  const key = textRaw?.value ? String(textRaw.value).trim().toLowerCase() : null;

  if (key && STATUS_MAPPING_TABLE[key]) {
    return { value: STATUS_MAPPING_TABLE[key], source_type: "EXTRACTED_MAPPED", confidence: textRaw.confidence };
  }
  if (guess?.value) {
    return { value: guess.value, source_type: "MODEL_GUESS", confidence: guess.confidence };
  }
  return { value: "UNKNOWN", source_type: "UNKNOWN", confidence: "LOW" };
}

// ================== CURRENCY ==================
// Un "$" nunca implica USD. Solo un codigo reconocible explicito cuenta.
const RECOGNIZED_CURRENCIES = ["USD", "USDC", "USDT", "MXN", "EUR", "GBP"];

export function normalizeCurrency(transactionRaw) {
  const v = transactionRaw?.currency?.value;
  const upper = v ? String(v).trim().toUpperCase() : null;
  if (upper && RECOGNIZED_CURRENCIES.includes(upper)) {
    return { value: upper, warning: null };
  }
  return { value: null, warning: "CURRENCY_AMBIGUOUS" };
}

// ================== ARITHMETIC ==================
const ARITHMETIC_TOLERANCE_PCT = 2;

export function computeTotal({ quantityValue, priceValue, totalRaw }) {
  if (totalRaw?.value != null) {
    const warnings = [];
    if (quantityValue != null && priceValue != null) {
      const expected = quantityValue * priceValue;
      const diffPct = totalRaw.value !== 0
        ? (Math.abs(expected - totalRaw.value) / Math.abs(totalRaw.value)) * 100
        : (expected === 0 ? 0 : 100);
      if (diffPct > ARITHMETIC_TOLERANCE_PCT) warnings.push("PRICE_QUANTITY_TOTAL_MISMATCH");
    }
    return { value: totalRaw.value, source_type: "EXTRACTED", warnings };
  }
  if (quantityValue != null && priceValue != null) {
    return { value: quantityValue * priceValue, source_type: "DERIVED", warnings: [] };
  }
  return { value: null, source_type: "UNAVAILABLE", warnings: [] };
}

// ================== DOCUMENT TYPE / TRANSACTION TYPE ==================
export function checkDocumentTypeConflict(documentType, transactionType) {
  if (documentType === "PURCHASE_CONFIRMATION" && transactionType === "SELL") return true;
  if (documentType === "SALE_CONFIRMATION" && transactionType === "BUY") return true;
  return false;
}

// ================== OVERALL CONFIDENCE (precedencia congelada) ==================
export function computeOverallConfidence({
  assetMatchStatus, statusValue, typeValue, sensitiveDetected,
  documentTypeConflict, criticalFieldsConfidence, hasMismatchWarning,
}) {
  if (sensitiveDetected) return "AMBIGUOUS";
  if (assetMatchStatus !== "MATCHED_ASSET") return "AMBIGUOUS";
  if (statusValue === "UNKNOWN") return "AMBIGUOUS";
  if (typeValue == null) return "AMBIGUOUS";
  if (documentTypeConflict) return "AMBIGUOUS";
  if ((criticalFieldsConfidence || []).includes("LOW")) return "LOW";
  if (hasMismatchWarning) return "MEDIUM";
  if ((criticalFieldsConfidence || []).includes("MEDIUM")) return "MEDIUM";
  return "HIGH";
}

// ================== ACCOUNT MATCH (pura -- recibe candidatos ya cargados) ==================
// Prioriza account_name exacto (mas especifico) sobre provider, porque
// varias cuentas pueden compartir el mismo provider (Binance Spot/USD-M/
// COIN-M todas tienen provider="Binance") -- un match ambiguo por
// provider solo NUNCA debe adivinar cual de las tres es.
export function matchAccount({ accountNameRaw, providerRaw }, accounts) {
  const nameKey = accountNameRaw ? String(accountNameRaw).trim().toLowerCase() : null;
  if (nameKey) {
    const byName = accounts.filter((a) => a.name && a.name.trim().toLowerCase() === nameKey);
    if (byName.length === 1) return { status: "MATCHED_ACCOUNT", account_id: byName[0].id, account: byName[0] };
  }
  const providerKey = providerRaw ? String(providerRaw).trim().toLowerCase() : null;
  if (providerKey) {
    const byProvider = accounts.filter((a) => a.provider && a.provider.trim().toLowerCase() === providerKey);
    if (byProvider.length === 1) return { status: "MATCHED_ACCOUNT", account_id: byProvider[0].id, account: byProvider[0] };
  }
  return { status: "UNKNOWN_ACCOUNT", account_id: null, account: null };
}

// ================== ENSAMBLE FINAL ==================
// Combina todo lo anterior. assetResolution y accountMatch ya vienen
// resueltos desde afuera (I/O separado) -- esta funcion sigue siendo pura.
export function buildNormalizedExtraction({ raw, assetResolution, accountMatch }) {
  const warnings = [...(raw.warnings || [])];

  const status = normalizeStatus(raw.transaction);
  const currency = normalizeCurrency(raw.transaction);
  if (currency.warning) warnings.push(currency.warning);

  const quantityValue = raw.transaction.quantity?.value ?? null;
  const priceValue = raw.transaction.price?.value ?? null;
  const totalComputed = computeTotal({ quantityValue, priceValue, totalRaw: raw.transaction.total });
  warnings.push(...totalComputed.warnings);

  const typeValue = raw.transaction.type?.value ?? null;
  const docConflict = checkDocumentTypeConflict(raw.document_type, typeValue);
  if (docConflict) warnings.push("DOCUMENT_TYPE_TRANSACTION_TYPE_CONFLICT");

  if (assetResolution.status === "UNKNOWN_ASSET") warnings.push("UNKNOWN_ASSET");
  if (assetResolution.status === "ASSET_AMBIGUOUS") warnings.push("ASSET_AMBIGUOUS");
  if (accountMatch.status === "UNKNOWN_ACCOUNT") warnings.push("UNKNOWN_ACCOUNT");

  const criticalFieldsConfidence = [
    raw.transaction.ticker?.confidence || "LOW",
    status.confidence,
  ];
  if (quantityValue != null) criticalFieldsConfidence.push(raw.transaction.quantity?.confidence || "LOW");
  else criticalFieldsConfidence.push("LOW");
  if (totalComputed.source_type !== "UNAVAILABLE") {
    criticalFieldsConfidence.push(raw.transaction.price?.confidence || raw.transaction.total?.confidence || "LOW");
  } else {
    criticalFieldsConfidence.push("LOW");
  }

  const overall_import_confidence = computeOverallConfidence({
    assetMatchStatus: assetResolution.status,
    statusValue: status.value,
    typeValue,
    sensitiveDetected: raw.sensitive_content_detected,
    documentTypeConflict: docConflict,
    criticalFieldsConfidence,
    hasMismatchWarning: warnings.includes("PRICE_QUANTITY_TOTAL_MISMATCH"),
  });

  return {
    asset: {
      ticker_raw: raw.transaction.ticker?.value ?? null,
      ticker_normalized: assetResolution.ticker_normalized ?? null,
      match_status: assetResolution.status,
      asset_id: assetResolution.asset_id ?? null,
    },
    account: {
      provider_raw: raw.source?.provider?.value ?? null,
      match_status: accountMatch.status,
      account_id: accountMatch.account_id,
    },
    type: typeValue,
    status,
    quantity: quantityValue,
    price: priceValue,
    total: { value: totalComputed.value, source_type: totalComputed.source_type },
    currency: currency.value,
    fee: {
      value: raw.transaction.fee?.value ?? null,
      source_type: raw.transaction.fee?.value != null ? "EXTRACTED" : "UNAVAILABLE",
    },
    transaction_date: raw.transaction.transaction_date?.value ?? null,
    transaction_time: raw.transaction.transaction_time?.value ?? null,
    provider_transaction_id: raw.transaction.provider_transaction_id?.value ?? null,
    warnings,
    overall_import_confidence,
  };
}
