export async function callOpenAI({ system, messages, tools, model }) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("missing_api_key: OPENAI_API_KEY");
  const useModel = model || process.env.OPENAI_MODEL || "gpt-5.6-terra";

  const body = {
    model: useModel,
    max_completion_tokens: 2000,
    messages: messagesToOpenAIFormat(system, messages),
    tools: toolsToOpenAIFormat(tools),
  };
  if (useModel.startsWith("gpt-5.6")) {
    body.reasoning_effort = "none";
  }

  const TIMEOUT_MS = 30000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  let resp;
  try {
    resp = await fetch("https://api.openai.com/v1/chat/completions", {
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
      const err = new Error(`openai_timeout_after_${TIMEOUT_MS}ms(${useModel})`);
      err.retryable = true;
      throw err;
    }
    const err = new Error(`openai_network_error(${useModel}): ${networkErr.message}`);
    err.retryable = true;
    throw err;
  } finally {
    clearTimeout(timer);
  }

  const data = await resp.json();
  if (!resp.ok) {
    const err = new Error(`openai_error(${useModel}): ${data?.error?.message || resp.status}`);
    err.status = resp.status;
    err.retryable = resp.status === 429 || resp.status >= 500;
    throw err;
  }

  const choice = data.choices?.[0];
  const msg = choice?.message || {};
  const toolCalls = (msg.tool_calls || []).map((tc) => ({
    id: tc.id, name: tc.function.name, input: JSON.parse(tc.function.arguments || "{}"),
  }));

  const contentBlocks = [];
  if (msg.content) contentBlocks.push({ type: "text", text: msg.content });
  toolCalls.forEach((tc) => contentBlocks.push({ type: "tool_use", id: tc.id, name: tc.name, input: tc.input }));

  return {
    content: msg.content ?? null,
    contentBlocks,
    toolCalls,
    stopReason: toolCalls.length > 0 ? "tool_use" : (choice?.finish_reason === "length" ? "max_tokens" : "end_turn"),
    usage: {
      model: data.model || useModel,
      inputTokens: data.usage?.prompt_tokens ?? null,
      outputTokens: data.usage?.completion_tokens ?? null,
      totalTokens: data.usage?.total_tokens ?? null,
    },
  };
}
