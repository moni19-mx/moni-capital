// api/smart-import.js
// Smart Import Phase 1 -- accion "extract" UNICAMENTE.
//
// IMAGE -> validate -> hash -> storage -> smart_import row -> vision
// extraction -> schema validation -> sensitive hard-stop -> raw_extraction
// -> normalization -> asset/account resolution -> arithmetic validation
// -> duplicate check -> transaction effects -> ProposedChange -> REVIEW_REQUIRED
//
// Nunca escribe en positions/transactions/holdings. Nunca confirma
// automaticamente. "confirm" es una accion futura, no implementada aqui.

import crypto from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { checkRateLimit, recordFailedAttempt } from "../lib/security.js";
import {
  callModel, validateImageInput, parseModelJsonOutput, buildSafeLogEntry,
  SMART_IMPORT_PROMPT_VERSION, SMART_IMPORT_SCHEMA_VERSION,
} from "../lib/aiGateway.js";
import { resolveAsset, resolveAssetById } from "../lib/assetResolver.js";
import { buildNormalizedExtraction, matchAccount } from "../lib/smartImportNormalize.js";
import { resolveDuplicateCheck } from "../lib/reconciliationQueries.js";
import {
  getTransactionEffects, isEligibleForCreate, buildProposedChange,
  evaluateDateUpdateEligibility, evaluateIdentityFieldConsistency,
} from "../lib/reconciliationEngine.js";
import {
  validateUserEditKeys, applyEditsToNormalized, buildRpcParams,
} from "../lib/smartImportConfirm.js";
import { normalizeFuturesAccountBalance, normalizeFuturesPositionFacts, resolveAccountContext } from "../lib/futuresImportNormalize.js";

const supabase = createClient(
  process.env.VITE_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ================== Schema congelado (SmartImportRawExtraction) ==================
import { SmartImportRawExtractionSchema } from "../lib/smartImportSchema.js";

const VISION_SYSTEM_PROMPT = `Eres el motor de extraccion de Smart Import de Moni Capital. Tu unica
tarea es leer una imagen y devolver UNICAMENTE un objeto JSON que siga
exactamente el schema proporcionado. Nunca texto libre, nunca
explicaciones fuera del JSON, nunca markdown.

PRIMERO clasifica que tipo de documento es la imagen, usando document_type:

- PURCHASE_CONFIRMATION / SALE_CONFIRMATION: confirmacion de una compra
  o venta individual de un activo (accion, cripto).
- SPOT_ACCOUNT_SNAPSHOT: vista de balances de una cuenta spot/wallet
  (tenencias propias, sin apalancamiento, sin posiciones).
- FUTURES_ACCOUNT_SNAPSHOT: vista del balance de una cuenta de futuros
  (wallet balance, margin balance, available, unrealized PnL a nivel
  de cuenta) -- NO una posicion individual.
- FUTURES_POSITION_SNAPSHOT: vista de UNA posicion abierta de futuros
  (instrumento, side, leverage, entry/mark/liquidation price).
- UNKNOWN: la imagen no corresponde claramente a ninguno de los
  anteriores.

Cada tipo de documento tiene su propio conjunto de campos -- el JSON que
devuelvas debe tener EXACTAMENTE los campos de su tipo, ningun campo de
otro tipo mezclado.

Reglas obligatorias, sin excepcion, para TODOS los tipos:

1. Solo reportas lo que es VISIBLEMENTE evidente en la imagen. Nunca
   adivinas, nunca infieres, nunca completas un dato faltante.
2. Si un dato no aparece en la imagen: value = null. Nunca inventes un
   valor "razonable".
3. Cada campo relevante lleva su evidence_text: la cita textual exacta
   de lo que viste. Si no hay evidencia, evidence_text es null.
4. Si detectas contenido que parezca una seed phrase, private key, o
   password: sensitive_content_detected = true, y NO reproduzcas ese
   texto en ningun campo del JSON, ni en evidence_text.
5. Tu respuesta debe validar exactamente contra el JSON Schema
   proporcionado. Nada de campos extra, nada de campos faltantes.

Reglas adicionales para PURCHASE_CONFIRMATION / SALE_CONFIRMATION:

- status_model_guess NUNCA puede ser "EXECUTED" solo porque veas
  quantity y price -- esos campos NO son evidencia de ejecucion. Solo
  marca EXECUTED si ves texto/icono que lo confirme explicitamente.
- Un simbolo "$" NUNCA significa automaticamente USD. Si no ves un
  codigo de moneda explicito (USD, USDC, USDT, MXN, etc.), currency
  debe quedar null.
- NUNCA calcules un campo financiero faltante (total, price, quantity).

Reglas adicionales para FUTURES_ACCOUNT_SNAPSHOT:

- NUNCA calcules ni derives "equity" -- solo reporta los campos que
  la pantalla muestra literalmente (wallet_balance, margin_balance,
  available_balance, unrealized_pnl, initial_margin, maintenance_margin).
  El calculo de equity lo hace el sistema despues, nunca tu.
- Si un componente no es visible en la pantalla, su value es null --
  nunca asumas que "no visible" significa cero.

Reglas adicionales para FUTURES_POSITION_SNAPSHOT:

- notional es el valor nocional/valor de la posicion tal como lo
  muestra la pantalla (si lo muestra) -- nunca lo calcules tu
  multiplicando price x quantity.
- side debe ser exactamente "LONG" o "SHORT" segun lo que la pantalla
  indique explicitamente (color, texto, icono) -- null si no es claro.
- account_ref es el nombre de la cuenta/pestaña tal como aparece en
  pantalla (ej. "Binance USD-M", "Binance COIN-M") -- texto literal,
  no interpretado.

Responde UNICAMENTE con el JSON. Sin backticks de markdown, sin texto
antes o despues.`;

async function requirePin(res, pin) {
  const { blocked } = await checkRateLimit(supabase);
  if (blocked) {
    res.status(429).json({ error: "rate_limited", detail: "Demasiados intentos fallidos. Espera unos minutos e intenta de nuevo." });
    return false;
  }
  if (!pin || pin !== process.env.MONI_PIN) {
    await recordFailedAttempt(supabase);
    res.status(401).json({ error: "invalid_pin" });
    return false;
  }
  return true;
}

async function markFailed(importId, errorCode) {
  if (importId == null) return;
  try {
    await supabase.from("smart_imports").update({ status: "FAILED", error_code: errorCode }).eq("id", importId);
  } catch (e) { /* el marcado de fallo nunca debe tumbar la respuesta de error ya en curso */ }
}

// ================== ACCION: confirm ==================
async function handleConfirm(req, res, body) {
  const { pin, import_id, approved_change_indices, user_edits } = body;
  if (!(await requirePin(res, pin))) return;

  if (import_id == null) {
    return res.status(400).json({ ok: false, error_code: "IMPORT_NOT_FOUND" });
  }

  // ================== 2-3. Cargar smart_import, validar estado ==================
  const { data: importRow, error: importErr } = await supabase.from("smart_imports").select("*").eq("id", import_id).maybeSingle();
  if (importErr) return res.status(500).json({ ok: false, error_code: "DB_ERROR" });
  if (!importRow) return res.status(404).json({ ok: false, error_code: "IMPORT_NOT_FOUND" });

  if (importRow.status === "CONFIRMED") {
    return res.status(200).json({ ok: true, import_id, status: "CONFIRMED", already_confirmed: true, applied: importRow.approved_changes });
  }
  if (importRow.status !== "REVIEW_REQUIRED") {
    return res.status(409).json({ ok: false, import_id, status: importRow.status, error_code: "INVALID_IMPORT_STATE" });
  }

  // ================== 4. Validar approved_change_indices ==================
  const proposedChanges = importRow.normalized_extraction ? (importRow.proposed_changes || []) : [];
  if (!Array.isArray(approved_change_indices) || approved_change_indices.length !== 1) {
    return res.status(400).json({ ok: false, import_id, error_code: "INVALID_APPROVED_INDICES" });
  }
  const idx = approved_change_indices[0];
  const uniqueIndices = new Set(approved_change_indices);
  if (uniqueIndices.size !== approved_change_indices.length || !Number.isInteger(idx) || idx < 0 || idx >= proposedChanges.length) {
    return res.status(400).json({ ok: false, import_id, error_code: "INVALID_APPROVED_INDICES" });
  }

  // ================== 5. Validar whitelist de user_edits ==================
  const editsForIndex = (user_edits && user_edits[String(idx)]) || {};
  const keyCheck = validateUserEditKeys(editsForIndex);
  if (!keyCheck.valid) {
    return res.status(400).json({ ok: false, import_id, error_code: "INVALID_USER_EDIT", field: keyCheck.field });
  }

  // ================== 6. Aplicar edits ==================
  const baseNormalized = importRow.normalized_extraction;
  const { normalized: editedNormalized, auditTrail, identityChanged, assetEdited, accountEdited } =
    applyEditsToNormalized(baseNormalized, editsForIndex);

  // ================== 6b. Re-resolver asset/account si fueron editados (siempre, no solo si "identityChanged") ==================
  if (assetEdited) {
    const real = await resolveAssetById(supabase, editedNormalized.asset.asset_id);
    if (real.status !== "MATCHED_ASSET") {
      return res.status(400).json({ ok: false, import_id, error_code: "INVALID_USER_EDIT", field: "asset_id", detail: "UNKNOWN_ASSET" });
    }
    editedNormalized.asset = { ticker_raw: baseNormalized.asset?.ticker_raw ?? null, ticker_normalized: real.ticker_normalized, match_status: "MATCHED_ASSET", asset_id: real.asset_id };
  }
  if (accountEdited) {
    if (editedNormalized.account.account_id != null) {
      const { data: acc } = await supabase.from("accounts").select("id").eq("id", editedNormalized.account.account_id).maybeSingle();
      if (!acc) {
        return res.status(400).json({ ok: false, import_id, error_code: "INVALID_USER_EDIT", field: "account_id", detail: "UNKNOWN_ACCOUNT" });
      }
      editedNormalized.account = { provider_raw: baseNormalized.account?.provider_raw ?? null, match_status: "MATCHED_ACCOUNT", account_id: acc.id };
    } else {
      editedNormalized.account = { provider_raw: baseNormalized.account?.provider_raw ?? null, match_status: "UNKNOWN_ACCOUNT", account_id: null };
    }
  }

  // ================== 7. Duplicate check SIEMPRE, con los valores (editados o no) actuales ==================
  const duplicateCandidate = {
    account_id: editedNormalized.account.account_id,
    asset_id: editedNormalized.asset.asset_id,
    type: editedNormalized.type,
    quantity: editedNormalized.quantity,
    price: editedNormalized.price,
    total: editedNormalized.total?.value ?? null,
    transaction_date: editedNormalized.transaction_date,
    transaction_at: null,
    provider_transaction_id: editedNormalized.provider_transaction_id,
  };
  const duplicateResult = await resolveDuplicateCheck(supabase, duplicateCandidate);

  // ================== 8. SELL -- hard block, RPC nunca se llama ==================
  if (editedNormalized.type === "SELL") {
    return res.status(409).json({ ok: false, import_id, status: "REVIEW_REQUIRED", error_code: "CONFIRMATION_NOT_ALLOWED", reason: "SELL_NOT_SUPPORTED_V1" });
  }

  const effects = getTransactionEffects({
    status: editedNormalized.status.value === "PENDING" || editedNormalized.status.value === "EXECUTED" ? editedNormalized.status.value : "PENDING",
    type: editedNormalized.type === "BUY" ? "BUY" : "BUY",
    fee: editedNormalized.fee?.value ?? null,
  });
  const eligibility = isEligibleForCreate(editedNormalized);
  const decision = buildProposedChange({ normalized: editedNormalized, duplicateResult, matchedTransaction: duplicateResult.matchedTransaction, effects, eligibility });

  // ================== REVIEW: nunca se confirma como CREATE/UPDATE ==================
  if (decision.operation === "REVIEW") {
    const reasonCode = decision.reason === "EXACT_DUPLICATE" ? "DUPLICATE_DETECTED_AT_CONFIRM"
      : decision.reason === "POSSIBLE_DUPLICATE" ? "STALE_PROPOSAL"
      : "CONFIRMATION_NOT_ALLOWED";
    return res.status(409).json({ ok: false, import_id, status: "REVIEW_REQUIRED", error_code: reasonCode, reason: decision.reason, warnings: editedNormalized.warnings });
  }

  let rpcOperation, targetTransactionId = null, shouldUpdateTransactionDate = false, dateChangeReason = null;

  if (decision.operation === "UPDATE") {
    // ================== 9. Bloqueo de posicion nueva solo aplica a CREATE; UPDATE ya tiene target existente ==================
    targetTransactionId = decision.target_id;

    // Cargar la fila completa del target para material-difference y date-confidence checks
    const { data: targetTx } = await supabase.from("transactions").select("*").eq("id", targetTransactionId).maybeSingle();
    if (!targetTx) {
      return res.status(409).json({ ok: false, import_id, error_code: "TARGET_TRANSACTION_NOT_FOUND" });
    }

    const consistency = evaluateIdentityFieldConsistency({
      originalQuantity: targetTx.quantity, newQuantity: editedNormalized.quantity,
      originalAmount: targetTx.amount, newAmount: editedNormalized.total?.value != null ? -Math.abs(editedNormalized.total.value) : null,
    });
    if (consistency.action === "REQUIRES_REVIEW") {
      return res.status(409).json({ ok: false, import_id, status: "REVIEW_REQUIRED", error_code: "CONFIRMATION_NOT_ALLOWED", reason: consistency.reason, detail: consistency });
    }

    // Confidence original de la fecha: transactions.import_id -> smart_imports.normalized_extraction.transaction_date_confidence
    let originalDateConfidence = null;
    if (targetTx.import_id != null) {
      const { data: origImport } = await supabase.from("smart_imports").select("normalized_extraction").eq("id", targetTx.import_id).maybeSingle();
      originalDateConfidence = origImport?.normalized_extraction?.transaction_date_confidence ?? null;
    }
    const dateEligibility = evaluateDateUpdateEligibility({
      originalDate: targetTx.transaction_date, originalConfidence: originalDateConfidence,
      newDate: editedNormalized.transaction_date, newConfidence: editedNormalized.transaction_date_confidence ?? null,
    });
    if (dateEligibility.action === "REQUIRES_REVIEW") {
      shouldUpdateTransactionDate = false;
    } else if (dateEligibility.action === "UPDATE_ALLOWED") {
      shouldUpdateTransactionDate = true;
      dateChangeReason = dateEligibility.reason;
    }

    rpcOperation = "UPDATE_PENDING_TO_EXECUTED";
  } else {
    // CREATE
    if (editedNormalized.status.value === "EXECUTED") {
      const { data: existingPos } = await supabase.from("positions").select("id").eq("asset_id", editedNormalized.asset.asset_id).maybeSingle();
      if (!existingPos) {
        return res.status(409).json({ ok: false, import_id, status: "REVIEW_REQUIRED", error_code: "NEW_POSITION_METADATA_REQUIRED" });
      }
      rpcOperation = "CREATE_EXECUTED_EXISTING_POSITION";
    } else {
      rpcOperation = "CREATE_PENDING";
    }
  }

  // ================== 15. Una sola llamada al RPC ==================
  const approvedChangesSnapshot = { ...decision, audit_trail: auditTrail };
  const rpcParams = buildRpcParams({
    importId: import_id, operation: rpcOperation, targetTransactionId,
    normalized: editedNormalized, shouldUpdateTransactionDate, dateChangeReason,
    approvedChanges: approvedChangesSnapshot, userEdits: user_edits || {},
  });

  const { data: rpcResult, error: rpcError } = await supabase.rpc("confirm_smart_import_transaction", rpcParams);
  if (rpcError) {
    // Error inesperado del RPC -- nunca se oculta, nunca se marca CONFIRMED falsamente.
    console.error(JSON.stringify(buildSafeLogEntry({ import_id, status: "ERROR", error_code: "RPC_UNEXPECTED_ERROR" })));
    return res.status(500).json({ ok: false, import_id, error_code: "RPC_UNEXPECTED_ERROR" });
  }

  // ================== 16. Interpretar resultado ==================
  if (rpcResult.result === "CONFIRMED") {
    return res.status(200).json({
      ok: true, import_id, status: "CONFIRMED",
      applied: [{ entity: "transaction", id: rpcResult.transaction_id, operation: rpcResult.transaction_operation }],
      position_operation: rpcResult.position_operation,
    });
  }
  if (rpcResult.result === "ALREADY_CONFIRMED" || rpcResult.result === "ALREADY_APPLIED") {
    return res.status(200).json({ ok: true, import_id, status: rpcResult.result, transaction_id: rpcResult.transaction_id ?? null });
  }

  // Cualquier otro resultado controlado del RPC (IMPORT_NOT_FOUND, INVALID_IMPORT_STATE,
  // POSITION_NOT_FOUND_AT_CONFIRM, TARGET_TRANSACTION_NOT_FOUND, TARGET_TRANSACTION_CHANGED,
  // DUPLICATE_IDENTITY_AT_CONFIRM, MULTIPLE_POSITIONS_FOUND, INVALID_OPERATION)
  return res.status(409).json({ ok: false, import_id, status: "REVIEW_REQUIRED", error_code: rpcResult.result, detail: rpcResult });
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "method_not_allowed" });
  }
  const { pin, action } = req.body || {};

  if (action === "confirm") {
    return handleConfirm(req, res, req.body || {});
  }

  if (action !== "extract") {
    return res.status(400).json({ error: "unknown_action" });
  }

  // ================== 1-2. PIN + validacion de request/imagen ==================
  if (!(await requirePin(res, pin))) return;

  const { image_base64, mime_type, filename, selected_account_id } = req.body || {};
  if (!image_base64 || !mime_type) {
    return res.status(400).json({ ok: false, error_code: "INVALID_REQUEST" });
  }

  let imageBuffer;
  try {
    imageBuffer = Buffer.from(image_base64, "base64");
  } catch (e) {
    return res.status(400).json({ ok: false, error_code: "INVALID_IMAGE_DATA" });
  }
  if (!imageBuffer || imageBuffer.length === 0) {
    return res.status(400).json({ ok: false, error_code: "INVALID_IMAGE_DATA" });
  }

  const imageCheck = validateImageInput({ mimeType: mime_type, sizeBytes: imageBuffer.length });
  if (!imageCheck.valid) {
    return res.status(400).json({ ok: false, error_code: imageCheck.error });
  }

  // SHA256 sobre los bytes originales, ANTES de cualquier transformacion
  // (Phase 1 no transforma la imagen, pero la definicion queda fija).
  const sha256 = crypto.createHash("sha256").update(imageBuffer).digest("hex");

  // ================== 3. EXACT_IMAGE_MATCH (warning, nunca bloqueo) ==================
  let previousImportIds = [];
  try {
    const { data: priorImages } = await supabase.from("smart_import_images").select("import_id").eq("sha256", sha256);
    previousImportIds = [...new Set((priorImages || []).map((r) => r.import_id))];
  } catch (e) { /* si falla la busqueda de duplicado de imagen, no bloquea el extract */ }

  const globalWarnings = [];
  if (previousImportIds.length > 0) globalWarnings.push("EXACT_IMAGE_MATCH");

  // ================== 4. Crear smart_imports + Storage ==================
  let importId = null;
  try {
    const { data: importRow, error: importErr } = await supabase.from("smart_imports").insert([{
      status: "UPLOADED",
      raw_extraction: null,
      model_provider: "anthropic",
      model_name: process.env.ANTHROPIC_MODEL || "claude-sonnet-5",
      prompt_version: SMART_IMPORT_PROMPT_VERSION,
      schema_version: SMART_IMPORT_SCHEMA_VERSION,
    }]).select();
    if (importErr) throw importErr;
    importId = importRow[0].id;
  } catch (e) {
    return res.status(500).json({ ok: false, error_code: "STORAGE_UPLOAD_FAILED", detail: "no se pudo crear el registro de import" });
  }

  const storagePath = `${crypto.randomUUID()}/${crypto.randomUUID()}.${mime_type.split("/")[1] || "jpg"}`;
  try {
    const { error: uploadErr } = await supabase.storage.from("smart-imports-private").upload(storagePath, imageBuffer, { contentType: mime_type });
    if (uploadErr) throw uploadErr;

    await supabase.from("smart_import_images").insert([{
      import_id: importId,
      storage_path: storagePath,
      original_filename: filename || null,
      mime_type,
      size_bytes: imageBuffer.length,
      sha256,
    }]);
  } catch (e) {
    await markFailed(importId, "STORAGE_UPLOAD_FAILED");
    return res.status(500).json({ ok: false, import_id: importId, status: "FAILED", error_code: "STORAGE_UPLOAD_FAILED" });
  }

  // ================== 5. Vision call -- SIN fallback ==================
  let visionResult;
  const startedAt = Date.now();
  try {
    visionResult = await callModel({
      system: VISION_SYSTEM_PROMPT,
      messages: [{
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: mime_type, data: image_base64 } },
          {
            type: "text",
            text: "Extrae los datos de esta imagen. Tu respuesta DEBE tener exactamente esta estructura JSON (los mismos nombres de campo, exactamente estos, sin inventar ni renombrar ninguno):\n\n"
              + JSON.stringify(SmartImportRawExtractionSchema, null, 2)
              + "\n\nResponde UNICAMENTE con un objeto JSON que cumpla ese schema. Nada de texto antes o despues, nada de markdown.",
          },
        ],
      }],
      tools: [],
      authContext: { authenticated: true },
      providerOverride: "anthropic",
      allowFallback: false,
      maxTokens: 4096,
    });
  } catch (e) {
    await markFailed(importId, "VISION_PROVIDER_UNAVAILABLE");
    console.error(JSON.stringify(buildSafeLogEntry({
      import_id: importId, model_provider: "anthropic", latency_ms: Date.now() - startedAt,
      status: "FAILED", error_code: "VISION_PROVIDER_UNAVAILABLE",
      schema_version: SMART_IMPORT_SCHEMA_VERSION, prompt_version: SMART_IMPORT_PROMPT_VERSION,
    })));
    return res.status(502).json({ ok: false, import_id: importId, status: "FAILED", error_code: "VISION_PROVIDER_UNAVAILABLE" });
  }

  // ================== 6. Schema validation ==================
  if (visionResult.stopReason === "max_tokens") {
    // Distincion explicita: esto NO es un JSON malformado por parte del
    // modelo -- es la respuesta cortada a la mitad por el limite de
    // tokens. Error especifico en vez del generico "invalid_json"
    // confuso que se veia antes.
    console.error(JSON.stringify(buildSafeLogEntry({
      import_id: importId, model_provider: "anthropic", status: "FAILED", error_code: "RESPONSE_TRUNCATED_MAX_TOKENS",
      schema_version: SMART_IMPORT_SCHEMA_VERSION, prompt_version: SMART_IMPORT_PROMPT_VERSION,
    })));
    await markFailed(importId, "RESPONSE_TRUNCATED_MAX_TOKENS");
    return res.status(502).json({ ok: false, import_id: importId, status: "FAILED", error_code: "RESPONSE_TRUNCATED_MAX_TOKENS" });
  }

  const parsed = parseModelJsonOutput(visionResult.content, SmartImportRawExtractionSchema);
  if (!parsed.valid) {
    console.error(JSON.stringify(buildSafeLogEntry({
      import_id: importId, model_provider: "anthropic", status: "FAILED", error_code: "SCHEMA_VALIDATION_FAILED",
      schema_version: SMART_IMPORT_SCHEMA_VERSION, prompt_version: SMART_IMPORT_PROMPT_VERSION,
    })));
    console.error("SCHEMA_VALIDATION_FAILED detail:", parsed.detail);
    await markFailed(importId, "SCHEMA_VALIDATION_FAILED");
    return res.status(502).json({ ok: false, import_id: importId, status: "FAILED", error_code: "SCHEMA_VALIDATION_FAILED", detail: parsed.detail });
  }
  const raw = parsed.data;

  // ================== 7. Sensitive hard-stop ==================
  if (raw.sensitive_content_detected === true) {
    const sanitized = { sensitive_content_detected: true, warnings: ["SENSITIVE_SECRET_DETECTED", "IMPORT_REJECTED_SENSITIVE_CONTENT"] };
    await supabase.from("smart_imports").update({
      raw_extraction: sanitized, status: "REJECTED", error_code: "SENSITIVE_SECRET_DETECTED",
    }).eq("id", importId);
    return res.status(200).json({ ok: false, import_id: importId, status: "REJECTED", error_code: "IMPORT_REJECTED_SENSITIVE_CONTENT" });
  }

  // ================== 8. raw_extraction (UNA sola vez -- trigger protege desde aqui) ==================
  try {
    const { error: rawErr } = await supabase.from("smart_imports").update({ raw_extraction: raw, status: "PARSED" }).eq("id", importId);
    if (rawErr) throw rawErr;
  } catch (e) {
    await markFailed(importId, "SCHEMA_VALIDATION_FAILED");
    return res.status(500).json({ ok: false, import_id: importId, status: "FAILED", error_code: "DB_WRITE_FAILED" });
  }

  // ================== 9. Normalization: bifurca segun document_type ==================
  // PURCHASE_CONFIRMATION/SALE_CONFIRMATION: pipeline existente, sin cambios.
  // Los 3 tipos de snapshot: normalizacion + resolucion de asset/cuenta,
  // pero SIN duplicate-check ni ProposedChange todavia -- la persistencia
  // real de snapshots (routeDerivativeImportBatch) no esta autorizada
  // todavia en esta fase. Llega a REVIEW_REQUIRED con los datos
  // normalizados visibles, para que puedas confirmar que la extraccion
  // en si funciona antes de construir la escritura real.
  if (raw.document_type === "SPOT_ACCOUNT_SNAPSHOT" || raw.document_type === "FUTURES_ACCOUNT_SNAPSHOT" || raw.document_type === "FUTURES_POSITION_SNAPSHOT") {
    let normalizedSnapshot;

    if (raw.document_type === "FUTURES_POSITION_SNAPSHOT") {
      normalizedSnapshot = normalizeFuturesPositionFacts(raw);
    } else {
      const { data: allAccounts } = await supabase.from("accounts").select("*");
      const accountResolution = resolveAccountContext({
        selectedAccountId: selected_account_id ?? null,
        rawProvider: raw.account?.provider?.value ?? null,
        rawProductType: raw.account?.product_type?.value ?? null,
        accounts: allAccounts || [],
      });

      // accountContext para getAccountEquity: SOLO campos ya normalizados,
      // nunca strings crudos del modelo (regla dura de esta fase).
      const equityAccountContext = {
        accountType: raw.document_type === "SPOT_ACCOUNT_SNAPSHOT" ? "SPOT" : (accountResolution.accountType || "FUTURES"),
        provider: accountResolution.provider,
        productType: accountResolution.productType,
      };

      normalizedSnapshot = {
        account: {
          account_id: accountResolution.accountId,
          provider: accountResolution.provider,
          account_type: accountResolution.accountType,
          product_type: accountResolution.productType,
          context_source: accountResolution.contextSource,
          raw_provider: accountResolution.rawProvider,
          raw_product_type: accountResolution.rawProductType,
        },
        account_resolution_status: accountResolution.status,
        // GAP DOCUMENTADO, a proposito: el "Balance de margen" total a
        // nivel cuenta (ej. "$4,357.93") que Binance muestra arriba de la
        // pantalla NO tiene todavia un campo estructurado propio en el
        // schema de extraccion -- el modelo solo lo describe en warnings
        // de texto libre. No se implementa el warning de reconciliacion
        // account-level vs suma de asset-level en este paso (no estaba en
        // el alcance autorizado) -- se deja para un paso futuro que
        // agregue ese campo al schema formalmente.
        observed_at: raw.observed_at?.value ?? null,
        balances: (raw.balances || []).map((b) =>
          raw.document_type === "SPOT_ACCOUNT_SNAPSHOT"
            ? { asset_symbol: b.asset_symbol?.value ?? null, quantity: b.quantity?.value ?? null }
            : normalizeFuturesAccountBalance(b, equityAccountContext)
        ),
        warnings: accountResolution.warnings || [],
      };
    }

    await supabase.from("smart_imports").update({
      normalized_extraction: normalizedSnapshot,
      proposed_changes: [],
      status: "REVIEW_REQUIRED",
    }).eq("id", importId);

    return res.status(200).json({
      ok: true,
      import_id: importId,
      status: "REVIEW_REQUIRED",
      document_type: raw.document_type,
      normalized_extraction: normalizedSnapshot,
      proposed_changes: [],
      warnings: [...globalWarnings, "FUTURES_PERSISTENCE_NOT_YET_IMPLEMENTED"],
      previous_import_ids: previousImportIds,
    });
  }

  if (raw.document_type === "UNKNOWN") {
    await supabase.from("smart_imports").update({ normalized_extraction: null, proposed_changes: [], status: "REVIEW_REQUIRED" }).eq("id", importId);
    return res.status(200).json({
      ok: true, import_id: importId, status: "REVIEW_REQUIRED", document_type: "UNKNOWN",
      warnings: [...globalWarnings, "DOCUMENT_TYPE_UNKNOWN"], previous_import_ids: previousImportIds,
    });
  }

  // ---- A partir de aqui: PURCHASE_CONFIRMATION / SALE_CONFIRMATION, pipeline existente sin cambios ----
  const tickerRaw = raw.transaction.ticker?.value ?? null;
  const assetResolution = await resolveAsset(supabase, tickerRaw);

  const { data: accounts } = await supabase.from("accounts").select("*");
  const accountMatch = matchAccount(
    { accountNameRaw: raw.source?.account_name?.value ?? null, providerRaw: raw.source?.provider?.value ?? null },
    accounts || []
  );

  const normalized = buildNormalizedExtraction({ raw, assetResolution, accountMatch });
  normalized.warnings = [...new Set([...normalized.warnings, ...globalWarnings])];

  // ================== 10-11. Arithmetic + overall confidence ==================
  // Ya aplicados dentro de buildNormalizedExtraction (paso 9).

  // ================== 12. Duplicate check ==================
  // NOTA HONESTA: transaction_at queda NULL deliberadamente. El modelo
  // extrae fecha/hora en lenguaje natural en español (ej. "1 sept 2026",
  // "9:16 a.m."), pero transactions.transaction_at es timestamptz real --
  // convertir texto libre en un timestamp exacto y comparable de forma
  // confiable (nombres de mes en español, am/pm, zonas horarias) es una
  // funcionalidad real que merece su propio diseño, no un parche rapido
  // aqui. Mientras tanto, el Nivel 2 de identidad (timestamp exacto)
  // simplemente no esta disponible -- el sistema cae correctamente a
  // Nivel 1 (provider_transaction_id) o Nivel 3 (solo fecha), nunca
  // inventa una comparacion de timestamp que no sea confiable.
  const duplicateCandidate = {
    account_id: normalized.account.account_id,
    asset_id: normalized.asset.asset_id,
    type: normalized.type,
    quantity: normalized.quantity,
    price: normalized.price,
    total: normalized.total.value,
    transaction_date: normalized.transaction_date,
    transaction_at: null,
    provider_transaction_id: normalized.provider_transaction_id,
  };
  const duplicateResult = await resolveDuplicateCheck(supabase, duplicateCandidate);

  // ================== 13. Effects ==================
  const effects = getTransactionEffects({
    status: normalized.status.value === "PENDING" || normalized.status.value === "EXECUTED" ? normalized.status.value : "PENDING",
    type: normalized.type === "BUY" || normalized.type === "SELL" ? normalized.type : "BUY",
    fee: normalized.fee.value,
  });

  // ================== 14. ProposedChange ==================
  const eligibility = isEligibleForCreate(normalized);
  const proposedChange = buildProposedChange({
    normalized, duplicateResult, matchedTransaction: duplicateResult.matchedTransaction, effects, eligibility,
  });

  // ================== 15. Estado final ==================
  await supabase.from("smart_imports").update({
    normalized_extraction: normalized,
    proposed_changes: [proposedChange],
    status: "REVIEW_REQUIRED",
    overall_import_confidence: normalized.overall_import_confidence,
  }).eq("id", importId);

  console.log(JSON.stringify(buildSafeLogEntry({
    import_id: importId, model_provider: visionResult.usage?.provider, model_name: visionResult.usage?.model,
    latency_ms: Date.now() - startedAt, status: "REVIEW_REQUIRED",
    schema_version: SMART_IMPORT_SCHEMA_VERSION, prompt_version: SMART_IMPORT_PROMPT_VERSION,
  })));

  // ================== 16. Response ==================
  return res.status(200).json({
    ok: true,
    import_id: importId,
    status: "REVIEW_REQUIRED",
    normalized_extraction: normalized,
    proposed_changes: [proposedChange],
    warnings: normalized.warnings,
    previous_import_ids: previousImportIds,
  });
}
