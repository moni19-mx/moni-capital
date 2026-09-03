// lib/aiGateway.js
// El contrato neutral aprobado en Moni AI Architecture v1.1 / v1.1.1.
// Ningun otro archivo de Moni Capital (ni las tools, ni api/ai.js, ni el
// futuro AI Center) sabe si detras hay Anthropic, OpenAI, o cualquier
// otro proveedor -- todos hablan con esta funcion unicamente.
//
// v1.1.1 agrega failover automatico (revision critica pre-Sprint-1,
// punto 3): SOLO se activa por fallas de transporte del proveedor de IA
// (timeout, red caida, HTTP 429, HTTP 5xx) -- nunca porque una tool
// financiera fallo, falte un dato, o el modelo haya respondido "no puedo
// determinar algo". Esas son respuestas EXITOSAS del modelo, no fallas
// del proveedor, y jamas deben disparar un reintento con otro modelo.
//
// El failover tampoco se activa si el llamador pidio explicitamente un
// proveedor especifico (providerOverride) -- eso rompe cualquier
// benchmark/comparacion de modelos si el sistema decide "ayudar"
// cambiando de proveedor a medio de una prueba.
//
// Smart Import / Vision (revision critica): se agrega `allowFallback`
// (default true, preserva el comportamiento existente para TODOS los
// callers actuales -- chat, Daily Brief, tools, benchmarks). Cuando un
// caller pasa `allowFallback: false` (asi lo hara Smart Import para
// llamadas de vision), el failover NUNCA se activa, sin importar si el
// error es retryable -- una imagen nunca debe degradarse en silencio a
// un proveedor que no sabemos si soporta el mismo contrato multimodal.
//
// CONTRATO MULTIMODAL: los bloques de imagen viajan dentro de `messages`
// en el formato nativo de Anthropic:
//   { type: "image", source: { type: "base64", media_type: "image/jpeg"|"image/png"|"image/webp", data: "<base64>" } }
// El Gateway y anthropic.js NO transforman este bloque -- se pasa tal
// cual al proveedor, igual que un bloque de texto. openai.js no traduce
// imagenes todavia porque, con allowFallback:false, nunca las recibe en
// Fase 1.

import { callAnthropic } from "./providers/anthropic.js";
import { callOpenAI } from "./providers/openai.js";
import { validateJsonSchema } from "./jsonSchemaLite.js";

// Cada "proveedor" es una funcion que recibe {system, messages, tools, stream}.
// gpt-5.6-sol y gpt-5.6-terra reusan EXACTAMENTE el mismo adaptador de
// OpenAI -- solo cambia el modelo que se le pide a la API. gpt-4o se
// elimino del Gateway (limpieza post-benchmark): fue un peldano de
// prueba antes de tener acceso a GPT-5.6, ya no forma parte de la
// configuracion final (PRIMARY: Anthropic, FALLBACK: Terra).
export const PROVIDERS = {
  anthropic: (args) => callAnthropic(args),
  "gpt-5.6-sol": (args) => callOpenAI({ ...args, model: "gpt-5.6-sol" }),
  // Terra es el FALLBACK configurado -- su modelo se lee de OPENAI_MODEL
  // para poder subir de version sin un deploy de codigo, igual que
  // Anthropic ya lee ANTHROPIC_MODEL en su propio adaptador.
  "gpt-5.6-terra": (args) => callOpenAI({ ...args, model: process.env.OPENAI_MODEL || "gpt-5.6-terra" }),
};
const PRIMARY_PROVIDER = process.env.MONI_AI_PROVIDER || "anthropic";
const FALLBACK_PROVIDER = process.env.MONI_AI_FALLBACK_PROVIDER || "gpt-5.6-terra";

async function invokeProvider(providerName, args) {
  const provider = PROVIDERS[providerName];
  if (!provider) throw new Error(`unknown_provider: ${providerName}`);
  const startedAt = Date.now();
  const result = await provider(args);
  return { ...result, usage: { ...result.usage, provider: providerName, durationMs: Date.now() - startedAt } };
}

// Extraida como funcion PURA para poder probar la politica de failover
// sin red real -- exactamente la decision que protege la regla de
// Smart Import ("nunca fallback text-only para una imagen").
export function shouldFailover({ allowFallback, isExplicitOverride, errorRetryable, providerName, fallbackProvider }) {
  return !!allowFallback && !isExplicitOverride && !!errorRetryable && providerName !== fallbackProvider;
}

export async function callModel({ system, messages, tools, authContext, stream = false, providerOverride, allowFallback = true }) {
  // Autorizacion desacoplada (Architecture v1.1, seccion 12). Hoy
  // `authContext` lo arma api/ai.js a partir de un PIN correcto -- esto
  // NO constituye autenticacion multiusuario real, es solo el contrato
  // preparado para el futuro. Cuando Moni Capital se comercialice, hay
  // que construir autenticacion real, sesiones, user_id, autorizacion
  // por recurso y RLS -- nada de eso existe todavia.
  if (!authContext?.authenticated) {
    throw new Error("unauthorized");
  }
  const providerName = providerOverride || PRIMARY_PROVIDER;
  const isExplicitOverride = !!providerOverride;
  const args = { system, messages, tools, stream };
  try {
    return await invokeProvider(providerName, args);
  } catch (err) {
    const canFailover = shouldFailover({
      allowFallback,
      isExplicitOverride,
      errorRetryable: err?.retryable,
      providerName,
      fallbackProvider: FALLBACK_PROVIDER,
    });
    if (!canFailover) throw err;
    console.error(`[Moni AI] Fallo de transporte en proveedor primario (${providerName}): ${err.message}. Failover automatico a ${FALLBACK_PROVIDER}.`);
    const fallbackResult = await invokeProvider(FALLBACK_PROVIDER, args);
    return {
      ...fallbackResult,
      usage: { ...fallbackResult.usage, fallbackUsed: true, originalProvider: providerName, originalError: err.message },
    };
  }
}

export const AVAILABLE_PROVIDERS = Object.keys(PROVIDERS);

// ==================================================
// Vision / Smart Import -- capacidades agregadas al Gateway
// ==================================================
const ALLOWED_IMAGE_MIME_TYPES = ["image/jpeg", "image/png", "image/webp"];
const MAX_IMAGE_SIZE_BYTES = 10 * 1024 * 1024; // 10MB -- igual al limite configurado en el bucket de Storage

// Rechaza ANTES de gastar una llamada al proveedor -- Tests D/E.
export function validateImageInput({ mimeType, sizeBytes }) {
  if (!ALLOWED_IMAGE_MIME_TYPES.includes(mimeType)) {
    return { valid: false, error: "INVALID_IMAGE_MIME_TYPE" };
  }
  if (typeof sizeBytes !== "number" || sizeBytes <= 0 || sizeBytes > MAX_IMAGE_SIZE_BYTES) {
    return { valid: false, error: "IMAGE_TOO_LARGE" };
  }
  return { valid: true };
}

// Parsea la respuesta de texto del modelo como JSON y la valida contra
// un JSON Schema arbitrario -- generico, no especifico de Smart Import,
// para que cualquier futuro contrato de structured output lo reuse.
export function parseModelJsonOutput(rawText, schema) {
  let parsed;
  try {
    const cleaned = (rawText || "").replace(/```json|```/g, "").trim();
    parsed = JSON.parse(cleaned);
  } catch (e) {
    return { valid: false, error: "SCHEMA_VALIDATION_FAILED", detail: `invalid_json: ${e.message}` };
  }
  const { valid, errors } = validateJsonSchema(parsed, schema);
  if (!valid) {
    return { valid: false, error: "SCHEMA_VALIDATION_FAILED", detail: errors.slice(0, 5).join("; ") };
  }
  return { valid: true, data: parsed };
}

// Allow-list explicita para logging -- nunca un blacklist. Cualquier
// campo no listado aqui (base64 de imagen, raw_extraction financiero,
// signed URLs, secrets) queda excluido por construccion, no por
// disciplina de quien llama a esta funcion.
const SAFE_LOG_FIELDS = ["import_id", "model_provider", "model_name", "latency_ms", "status", "error_code", "schema_version", "prompt_version"];

export function buildSafeLogEntry(entry) {
  const safe = {};
  for (const field of SAFE_LOG_FIELDS) {
    if (entry && entry[field] !== undefined) safe[field] = entry[field];
  }
  return safe;
}

// Versionado -- se guarda desde el primer import real (api/smart-import.js,
// todavia no construido). Definidos aqui para que exista una sola fuente,
// no un string repetido en cada archivo que los use despues.
export const SMART_IMPORT_PROMPT_VERSION = "smart-import-v1";
export const SMART_IMPORT_SCHEMA_VERSION = "smart-import-raw-v1";
