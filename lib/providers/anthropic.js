// lib/providers/anthropic.js
// Adaptador de Anthropic detras del AI Gateway. Es el UNICO archivo que
// sabe que existe "api.anthropic.com" -- nada mas en Moni Capital lo sabe.
//
// Contrato de salida (igual para todos los adaptadores):
// {
//   content: string | null,          -- texto final, si el modelo termino
//   contentBlocks: [...],            -- forma interna neutral, para re-enviar en el tool loop
//   toolCalls: [{id, name, input}],  -- normalizado, igual para cualquier proveedor
//   stopReason: "tool_use" | "end_turn",
//   usage: { model, inputTokens, outputTokens, totalTokens }
// }
//
// El formato interno de `messages` que este adaptador ACEPTA ya es el
// formato nativo de Anthropic (bloques {type:"text"|"tool_use"|"tool_result"})
// -- por eso este adaptador casi no traduce nada. El adaptador de OpenAI
// si tiene que traducir en ambas direcciones (ver openai.js).

export async function callAnthropic({ system, messages, tools }) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("missing_api_key: ANTHROPIC_API_KEY");

  let resp;
  try {
    resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: process.env.ANTHROPIC_MODEL || "claude-sonnet-5",
        max_tokens: 900,
        system,
        tools,
        messages,
      }),
    });
  } catch (networkErr) {
    // Fallo de red (DNS, conexion rechazada, etc.) -- transporte, no el
    // modelo. Elegible para failover automatico.
    const err = new Error(`anthropic_network_error: ${networkErr.message}`);
    err.retryable = true;
    throw err;
  }

  const data = await resp.json();
  if (!resp.ok) {
    const err = new Error(`anthropic_error: ${data?.error?.message || resp.status}`);
    err.status = resp.status;
    // Solo 429 (rate limit) y 5xx (proveedor indisponible) son fallas de
    // transporte elegibles para failover. Un 400 (payload invalido) o
    // 401 (llave mala) no se arregla cambiando de proveedor.
    err.retryable = resp.status === 429 || resp.status >= 500;
    throw err;
  }

  const contentBlocks = data.content || [];
  const toolCalls = contentBlocks.filter((b) => b.type === "tool_use").map((b) => ({ id: b.id, name: b.name, input: b.input }));
  const textBlock = contentBlocks.find((b) => b.type === "text");

  return {
    content: textBlock ? textBlock.text : null,
    contentBlocks,
    toolCalls,
    stopReason: data.stop_reason === "tool_use" ? "tool_use" : "end_turn",
    usage: {
      model: data.model || process.env.ANTHROPIC_MODEL || "claude-sonnet-5",
      inputTokens: data.usage?.input_tokens ?? null,
      outputTokens: data.usage?.output_tokens ?? null,
      totalTokens: (data.usage?.input_tokens || 0) + (data.usage?.output_tokens || 0),
    },
  };
}
