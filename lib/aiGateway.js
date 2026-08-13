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

import { callAnthropic } from "./providers/anthropic.js";
import { callOpenAI } from "./providers/openai.js";

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

export async function callModel({ system, messages, tools, authContext, stream = false, providerOverride }) {
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
    const canFailover = !isExplicitOverride && err?.retryable && providerName !== FALLBACK_PROVIDER;
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
