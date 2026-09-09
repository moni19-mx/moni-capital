// lib/smartImportConfirm.js
// Nucleo 100% puro para la accion "confirm" de Smart Import. Ninguna
// funcion aqui hace fetch -- reciben datos ya cargados (normalized
// extraction, resultado de duplicate check, resoluciones de asset/cuenta
// ya hechas) y devuelven decisiones deterministicas. El endpoint hace
// todo el I/O y llama a estas funciones en secuencia.

export const USER_EDIT_WHITELIST = [
  "asset_id", "account_id", "type", "status", "quantity", "price", "total", "fee", "transaction_date",
];

// Sprint P1.2 (Smart Import Futures Confirm): los 2 tipos de snapshot de
// Futures solo permiten corregir la cuenta -- nunca datos financieros
// del balance/posicion, que siempre vienen de lo que el servidor ya
// normalizo y persistio en extract.
export const FUTURES_USER_EDIT_WHITELIST = ["account_id"];

// ================== Validacion de whitelist ==================
// whitelist es un parametro (default USER_EDIT_WHITELIST) para poder
// reusar exactamente esta misma funcion probada con
// FUTURES_USER_EDIT_WHITELIST -- comportamiento identico para el flujo
// de compras/ventas existente, que nunca pasa un segundo argumento.
export function validateUserEditKeys(edits, whitelist = USER_EDIT_WHITELIST) {
  for (const key of Object.keys(edits || {})) {
    if (!whitelist.includes(key)) {
      return { valid: false, field: key };
    }
  }
  return { valid: true };
}

// ================== Aplicar edits sobre normalized_extraction ==================
// Devuelve una COPIA de normalized con los edits aplicados, mas un audit
// trail (extracted/normalized/user_value por campo) y si algun campo de
// identidad (asset_id/type) cambio -- eso dispara re-reconciliacion
// completa en el endpoint.
export function applyEditsToNormalized(normalized, edits) {
  const result = JSON.parse(JSON.stringify(normalized));
  const auditTrail = [];
  let identityChanged = false;
  let assetEdited = false;
  let accountEdited = false;

  for (const [field, userValue] of Object.entries(edits || {})) {
    switch (field) {
      case "asset_id":
        auditTrail.push({ field, extracted: normalized.asset?.asset_id ?? null, user_value: userValue });
        result.asset = { ...result.asset, asset_id: userValue, match_status: "PENDING_REVALIDATION" };
        identityChanged = true;
        assetEdited = true;
        break;
      case "account_id":
        auditTrail.push({ field, extracted: normalized.account?.account_id ?? null, user_value: userValue });
        result.account = { ...result.account, account_id: userValue, match_status: "PENDING_REVALIDATION" };
        accountEdited = true;
        break;
      case "type":
        auditTrail.push({ field, extracted: normalized.type, user_value: userValue });
        result.type = userValue;
        identityChanged = true;
        break;
      case "status":
        auditTrail.push({ field, extracted: normalized.status?.value ?? null, user_value: userValue });
        result.status = { value: userValue, confidence: "HIGH", source_type: "USER_EDIT" };
        break;
      case "quantity":
        auditTrail.push({ field, extracted: normalized.quantity, user_value: userValue });
        result.quantity = userValue;
        break;
      case "price":
        auditTrail.push({ field, extracted: normalized.price, user_value: userValue });
        result.price = userValue;
        break;
      case "total":
        auditTrail.push({ field, extracted: normalized.total?.value ?? null, user_value: userValue });
        result.total = { value: userValue, source_type: "USER_EDIT" };
        break;
      case "fee":
        auditTrail.push({ field, extracted: normalized.fee?.value ?? null, user_value: userValue });
        result.fee = { value: userValue, source_type: userValue != null ? "USER_EDIT" : "UNAVAILABLE" };
        break;
      case "transaction_date":
        auditTrail.push({ field, extracted: normalized.transaction_date, user_value: userValue });
        result.transaction_date = userValue;
        result.transaction_date_confidence = "HIGH"; // el usuario lo puso a mano -- evidencia directa
        break;
      default:
        break;
    }
  }

  return { normalized: result, auditTrail, identityChanged, assetEdited, accountEdited };
}

// ================== Canonico -> legacy ==================
export function typeToLegacy(type) {
  if (type === "BUY") return "compra";
  if (type === "SELL") return "venta";
  return null;
}

// Construye los parametros exactos para confirm_smart_import_transaction,
// dado que ya se decidio la operacion (CREATE_PENDING |
// CREATE_EXECUTED_EXISTING_POSITION | UPDATE_PENDING_TO_EXECUTED) y ya
// se corrio evaluateDateUpdateEligibility para decidir si la fecha se
// actualiza.
export function buildRpcParams({
  importId, operation, targetTransactionId, normalized,
  shouldUpdateTransactionDate, dateChangeReason, approvedChanges, userEdits,
  positionName, positionType,
}) {
  return {
    p_import_id: importId,
    p_operation: operation,
    p_target_transaction_id: targetTransactionId ?? null,
    p_asset_id: normalized.asset.asset_id,
    p_account_id: normalized.account.account_id ?? null,
    p_type: typeToLegacy(normalized.type),
    p_status: normalized.status.value,
    p_quantity: normalized.quantity,
    p_amount: normalized.total?.value != null ? -Math.abs(normalized.total.value) : null, // BUY: principal negativo
    p_fee: normalized.fee?.value ?? null,
    p_transaction_date: normalized.transaction_date,
    p_should_update_transaction_date: !!shouldUpdateTransactionDate,
    p_provider_transaction_id: normalized.provider_transaction_id ?? null,
    p_date_change_reason: dateChangeReason ?? null,
    p_approved_changes: approvedChanges,
    p_user_edits: userEdits,
    // Solo se usan quando operation = CREATE_EXECUTED_NEW_POSITION -- el
    // RPC los ignora en cualquier otro caso. Vienen del asset ya
    // resuelto en `assets` (nunca del texto crudo de la imagen).
    p_position_name: positionName ?? null,
    p_position_type: positionType ?? null,
  };
}
