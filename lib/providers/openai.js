// lib/providers/openai.js
// Adaptador de OpenAI detras del AI Gateway. A diferencia de anthropic.js,
// este SI tiene que traducir en ambas direcciones, porque el formato
// interno neutral de Moni AI (bloques {type:"text"|"tool_use"|"tool_result"})
// no es el formato nativo de OpenAI (mensajes planos + tool_calls +
// mensajes role:"tool"). Esa traduccion vive aqui, en un solo lugar --
// ningun otro archivo de Moni Capital sabe que este formato existe.

function toolsToOpenAIFormat(tools) {
  return (tools || []).map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.input_schema },
  }));
}

// Convierte el historial interno (formato neutral, bloques tipo Anthropic)
// al formato plano que espera Chat Completions.
function messagesToOpenAIFormat(system, messages) {
  const out = [{ role: "system", content: system }];
  for (const m of messages) {
    if (typeof m.content === "string") {
      out.push({ role: m.role, content: m.content });
      continue;
    }
    if (!Array.isArray(m.content)) continue;

    const textParts = m.content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
    const toolUseBlocks = m.content.filter((b) => b.type === "tool_use");
    const toolResultBlocks = m.content.filter((b) => b.type === "tool_result");

    if (toolUseBlocks.length > 0) {
      out.push({
        role: "assistant",
        content: textParts || null,
        tool_calls: toolUseBlocks.map((b) => ({
          id: b.id, type: "function",
          function: { name: b.name, arguments: JSON.stringify(b.input || {}) },
        })),
      });
    } else if (textParts) {
      out.push({ role: m.role, content: textParts });
    }

    toolResultBlocks.forEach((b) => {
      out.push({ role: "tool", tool_call_id: b.tool_use_id, content: typeof b.content === "string" ? b.content : JSON.stringify(b.content) });
    });
  }
  return out;
}

export async function callOpenAI({ system, messages, tools, model }) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("missing_api_key: OPENAI_API_KEY");
  const useModel = model || process.env.OPENAI_MODEL || "gpt-4o";

  const resp = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: useModel,
      max_tokens: 900,
      messages: messagesToOpenAIFormat(system, messages),
      tools: toolsToOpenAIFormat(tools),
    }),
  });

  const data = await resp.json();
  if (!resp.ok) {
    throw new Error(`openai_error(${useModel}): ${data?.error?.message || resp.status}`);
  }

  const choice = data.choices?.[0];
  const msg = choice?.message || {};
  const toolCalls = (msg.tool_calls || []).map((tc) => ({
    id: tc.id, name: tc.function.name, input: JSON.parse(tc.function.arguments || "{}"),
  }));

  // Se reconstruye en el formato interno neutral (bloques), no en el
  // formato nativo de OpenAI -- asi el tool loop del Gateway nunca sabe
  // que proveedor esta detras.
  const contentBlocks = [];
  if (msg.content) contentBlocks.push({ type: "text", text: msg.content });
  toolCalls.forEach((tc) => contentBlocks.push({ type: "tool_use", id: tc.id, name: tc.name, input: tc.input }));

  return {
    content: msg.content ?? null,
    contentBlocks,
    toolCalls,
    stopReason: toolCalls.length > 0 ? "tool_use" : "end_turn",
    usage: {
      model: data.model || useModel,
      inputTokens: data.usage?.prompt_tokens ?? null,
      outputTokens: data.usage?.completion_tokens ?? null,
      totalTokens: data.usage?.total_tokens ?? null,
    },
  };
}
