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
import { resolveAsset } from "../lib/assetResolver.js";
import { buildNormalizedExtraction, matchAccount } from "../lib/smartImportNormalize.js";
import { resolveDuplicateCheck } from "../lib/reconciliationQueries.js";
import { getTransactionEffects, isEligibleForCreate, buildProposedChange } from "../lib/reconciliationEngine.js";

const supabase = createClient(
  process.env.VITE_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ================== Schema congelado (SmartImportRawExtraction) ==================
const SmartImportRawExtractionSchema = {
  definitions: {
    FieldValueString: { type: "object", additionalProperties: false, required: ["value", "confidence", "evidence_text"],
      properties: { value: { type: ["string", "null"] }, confidence: { enum: ["HIGH", "MEDIUM", "LOW"] }, evidence_text: { type: ["string", "null"] } } },
    FieldValueNumber: { type: "object", additionalProperties: false, required: ["value", "confidence", "evidence_text"],
      properties: { value: { type: ["number", "null"] }, confidence: { enum: ["HIGH", "MEDIUM", "LOW"] }, evidence_text: { type: ["string", "null"] } } },
    FieldValueTradeType: { type: "object", additionalProperties: false, required: ["value", "confidence", "evidence_text"],
      properties: { value: { enum: ["BUY", "SELL", null] }, confidence: { enum: ["HIGH", "MEDIUM", "LOW"] }, evidence_text: { type: ["string", "null"] } } },
    FieldValueStatusGuess: { type: "object", additionalProperties: false, required: ["value", "confidence", "evidence_text"],
      properties: { value: { enum: ["PROPOSED", "PENDING", "EXECUTED", "CANCELLED", "REJECTED", null] }, confidence: { enum: ["HIGH", "MEDIUM", "LOW"] }, evidence_text: { type: ["string", "null"] } } },
  },
  type: "object",
  additionalProperties: false,
  required: ["document_type", "sensitive_content_detected", "source", "transaction", "warnings"],
  properties: {
    document_type: { enum: ["PURCHASE_CONFIRMATION", "SALE_CONFIRMATION", "UNKNOWN"] },
    sensitive_content_detected: { type: "boolean" },
    source: {
      type: "object", additionalProperties: false, required: ["provider", "account_name"],
      properties: {
        provider: { $ref: "#/definitions/FieldValueString" },
        account_name: { $ref: "#/definitions/FieldValueString" },
      },
    },
    transaction: {
      type: "object", additionalProperties: false,
      required: ["ticker", "asset_name", "type", "status_text_raw", "status_model_guess", "quantity", "price", "total", "currency", "fee", "transaction_date", "transaction_time", "provider_transaction_id", "order_id"],
      properties: {
        ticker: { $ref: "#/definitions/FieldValueString" },
        asset_name: { $ref: "#/definitions/FieldValueString" },
        type: { $ref: "#/definitions/FieldValueTradeType" },
        status_text_raw: { $ref: "#/definitions/FieldValueString" },
        status_model_guess: { $ref: "#/definitions/FieldValueStatusGuess" },
        quantity: { $ref: "#/definitions/FieldValueNumber" },
        price: { $ref: "#/definitions/FieldValueNumber" },
        total: { $ref: "#/definitions/FieldValueNumber" },
        currency: { $ref: "#/definitions/FieldValueString" },
        fee: { $ref: "#/definitions/FieldValueNumber" },
        transaction_date: { $ref: "#/definitions/FieldValueString" },
        transaction_time: { $ref: "#/definitions/FieldValueString" },
        provider_transaction_id: { $ref: "#/definitions/FieldValueString" },
        order_id: { $ref: "#/definitions/FieldValueString" },
      },
    },
    warnings: { type: "array", items: { type: "string" } },
  },
};

const VISION_SYSTEM_PROMPT = `Eres el motor de extraccion de Smart Import de Moni Capital. Tu unica
tarea es leer una imagen (screenshot de una confirmacion de compra o
venta) y devolver UNICAMENTE un objeto JSON que siga exactamente el
schema proporcionado. Nunca texto libre, nunca explicaciones fuera del
JSON, nunca markdown.

Reglas obligatorias, sin excepcion:

1. Solo reportas lo que es VISIBLEMENTE evidente en la imagen. Nunca
   adivinas, nunca infieres, nunca completas un dato faltante.
2. Si un dato no aparece en la imagen: value = null. Nunca inventes un
   valor "razonable".
3. status_model_guess NUNCA puede ser "EXECUTED" solo porque veas
   quantity y price -- esos campos NO son evidencia de ejecucion. Solo
   marca EXECUTED si ves texto/icono que lo confirme explicitamente.
4. Un simbolo "$" NUNCA significa automaticamente USD. Si no ves un
   codigo de moneda explicito (USD, USDC, USDT, MXN, etc.), currency
   debe quedar null.
5. NUNCA calcules un campo financiero faltante (total, price, quantity).
6. Cada campo relevante lleva su evidence_text: la cita textual exacta
   de lo que viste. Si no hay evidencia, evidence_text es null.
7. Si detectas contenido que parezca una seed phrase, private key, o
   password: sensitive_content_detected = true, y NO reproduzcas ese
   texto en ningun campo del JSON, ni en evidence_text.
8. Tu respuesta debe validar exactamente contra el JSON Schema
   proporcionado. Nada de campos extra, nada de campos faltantes.

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

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "method_not_allowed" });
  }
  const { pin, action } = req.body || {};
  if (action !== "extract") {
    return res.status(400).json({ error: "unknown_action" });
  }

  // ================== 1-2. PIN + validacion de request/imagen ==================
  if (!(await requirePin(res, pin))) return;

  const { image_base64, mime_type, filename } = req.body || {};
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
          { type: "text", text: "Extrae los datos de esta imagen segun el schema y las reglas del sistema." },
        ],
      }],
      tools: [],
      authContext: { authenticated: true },
      providerOverride: "anthropic",
      allowFallback: false,
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
  const parsed = parseModelJsonOutput(visionResult.content, SmartImportRawExtractionSchema);
  if (!parsed.valid) {
    await markFailed(importId, "SCHEMA_VALIDATION_FAILED");
    return res.status(502).json({ ok: false, import_id: importId, status: "FAILED", error_code: "SCHEMA_VALIDATION_FAILED" });
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

  // ================== 9. Normalization: asset + account resolution ==================
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
  const duplicateCandidate = {
    account_id: normalized.account.account_id,
    asset_id: normalized.asset.asset_id,
    type: normalized.type,
    quantity: normalized.quantity,
    price: normalized.price,
    total: normalized.total.value,
    transaction_date: normalized.transaction_date,
    transaction_at: null, // Phase 1 no separa hora exacta de forma confiable desde la imagen
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
