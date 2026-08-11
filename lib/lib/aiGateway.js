// lib/aiGateway.js
// El contrato neutral aprobado en Moni AI Architecture v1.1. Ningun otro
// archivo de Moni Capital (ni las tools, ni api/ai.js, ni el futuro AI
// Center) sabe si detras hay Anthropic, OpenAI, o cualquier otro
// proveedor -- todos hablan con esta funcion unicamente.
//
// Cero logica financiera aqui. Cero decisiones de negocio. Solo
// enrutamiento + normalizacion de autorizacion + medicion de tiempo.

import { callAnthropic } from "./providers/anthropic.js";
import { callOpenAI } from "./providers/openai.js";

const PROVIDERS = {
  anthropic: callAnthropic,
  openai: callOpenAI,
};

export async function callModel({ system, messages, tools, authContext, stream = false, providerOverride }) {
  // Autorizacion desacoplada (Architecture v1.1, seccion 12). Hoy
  // `authContext` lo arma api/ai.js a partir de un PIN correcto. Manana,
  // si esto se vuelve producto, authContext viene de sesion + user_id --
  // el Gateway no cambia, solo cambia quien construye este objeto.
  if (!authContext?.authenticated) {
    throw new Error("unauthorized");
  }

  const providerName = providerOverride || process.env.MONI_AI_PROVIDER || "anthropic";
  const provider = PROVIDERS[providerName];
  if (!provider) {
    throw new Error(`unknown_provider: ${providerName}`);
  }

  const startedAt = Date.now();
  const result = await provider({ system, messages, tools, stream });
  const durationMs = Date.now() - startedAt;

  return {
    ...result,
    usage: {
      ...result.usage,
      provider: providerName,
      durationMs,
    },
  };
}

export const AVAILABLE_PROVIDERS = Object.keys(PROVIDERS);
