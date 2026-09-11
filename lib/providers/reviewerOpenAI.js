// lib/providers/reviewerOpenAI.js
//
// Moni Autonomous Dev Loop, Fase B. Caller de OpenAI AISLADO,
// exclusivo del reviewer autonomo -- NO importa ni modifica
// lib/providers/openai.js (el unico caller real de ese archivo hoy es
// lib/aiGateway.js, que trae semantica de auth/failover-a-Anthropic
// completamente ajena/opuesta a lo que un reviewer independiente
// necesita). Aislamiento total intencional: un cambio futuro en el
// proveedor de produccion (timeouts, reintentos, headers) NUNCA debe
// alterar en silencio el comportamiento del reviewer, y viceversa.
//
// Nunca loguea la API key. Nunca devuelve el header Authorization ni
// ningun metadato HTTP de auth al llamador.

const OPENAI_CHAT_COMPLETIONS_URL = "https://api.openai.com/v1/chat/completions";
const TIMEOUT_MS = 30000;

export async function callReviewerOpenAI({ system, userMessage, model }) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("missing_api_key: OPENAI_API_KEY");
  if (!model) throw new Error("missing_model: el modelo del reviewer nunca se hardcodea, debe venir explicito del llamador");

  const body = {
    model,
    max_completion_tokens: 2000,
    messages: [
      { role: "system", content: system },
      { role: "user", content: userMessage },
    ],
    // JSON mode (universalmente soportado, garantiza sintaxis JSON
    // valida) en vez de json_schema estricto -- el REVIEW_RESPONSE.schema.json
    // real usa oneOf (human_action: null | object), que el modo
    // json_schema estricto de algunos modelos no soporta de forma
    // confiable. La validacion real y autoritativa SIEMPRE ocurre
    // localmente contra ese schema despues (ver runReviewer.mjs) --
    // el soporte del lado del proveedor nunca es la unica garantia.
    response_format: { type: "json_object" },
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  let resp;
  try {
    resp = await fetch(OPENAI_CHAT_COMPLETIONS_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (networkErr) {
    if (networkErr.name === "AbortError") {
      throw new Error(`reviewer_openai_timeout_after_${TIMEOUT_MS}ms(${model})`);
    }
    throw new Error(`reviewer_openai_network_error(${model}): ${networkErr.message}`);
  } finally {
    clearTimeout(timer);
  }

  const httpStatus = resp.status;
  let data;
  try {
    data = await resp.json();
  } catch (e) {
    return { httpStatus, ok: false, error: `invalid_json_response: ${e.message}`, contentText: null };
  }

  if (!resp.ok) {
    return { httpStatus, ok: false, error: `openai_error(${model}): ${data?.error?.message || httpStatus}`, contentText: null };
  }

  const contentText = data.choices?.[0]?.message?.content ?? null;
  return {
    httpStatus,
    ok: true,
    error: null,
    contentText,
    usage: {
      model: data.model || model,
      inputTokens: data.usage?.prompt_tokens ?? null,
      outputTokens: data.usage?.completion_tokens ?? null,
    },
  };
}
