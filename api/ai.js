// api/ai.js -- solo la funcion runQuestion y el bloque generate_insight cambian

async function runQuestion(question, history, provider, executorFn, systemPrompt = SYSTEM_PROMPT) {
  const messages = [...history, { role: "user", content: question }];
  let finalText = null;
  let loopGuard = 0;
  let truncated = false;
  const toolsUsed = [];
  const toolCallLog = [];
  const usageTotals = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  let lastMeta = null;
  let fallbackUsed = false;
  let originalProvider = null;
  const startedAt = Date.now();
  let errored = null;

  try {
    while (finalText === null && loopGuard < 5) {
      loopGuard++;
      const result = await callModel({
        system: systemPrompt,
        messages,
        tools: TOOL_DEFINITIONS,
        authContext: { authenticated: true },
        providerOverride: provider,
      });
      lastMeta = result.usage;
      if (result.usage?.fallbackUsed) { fallbackUsed = true; originalProvider = result.usage.originalProvider; }
      usageTotals.inputTokens += result.usage.inputTokens || 0;
      usageTotals.outputTokens += result.usage.outputTokens || 0;
      usageTotals.totalTokens += result.usage.totalTokens || 0;

      if (result.stopReason === "tool_use") {
        messages.push({ role: "assistant", content: result.contentBlocks });
        const toolResults = [];
        for (const call of result.toolCalls) {
          toolsUsed.push(call.name);
          const toolResult = await executorFn(call.name, call.input || {});
          toolCallLog.push({ name: call.name, input: call.input || {}, result: toolResult });
          toolResults.push({ type: "tool_result", tool_use_id: call.id, content: JSON.stringify(toolResult) });
        }
        messages.push({ role: "user", content: toolResults });
      } else if (result.stopReason === "max_tokens") {
        // Se corto por limite de tokens, no es un turno final normal.
        // Si trajo texto parcial, se usa igual (mejor algo real que nada),
        // pero se marca truncated para que quien consuma esto sepa que
        // no fue una respuesta completa de buena fe del modelo.
        truncated = true;
        if (result.content) {
          finalText = result.content;
        } else {
          // Sin texto util y cortado por tokens -- esto NUNCA debe
          // disfrazarse del placeholder generico "no tengo respuesta",
          // porque eso se confunde con incertidumbre legitima sobre datos.
          // Es un fallo tecnico real.
          errored = `response_truncated_no_content(max_tokens)`;
          break;
        }
      } else {
        finalText = result.content || null;
        if (finalText === null) {
          // end_turn sin contenido -- tambien es un fallo tecnico, no
          // "el modelo no tenia nada que decir". Un end_turn real siempre
          // trae texto.
          errored = `empty_response(end_turn)`;
          break;
        }
      }
    }
  } catch (e) {
    errored = String(e.message || e);
  }

  if (finalText === null && !errored) {
    errored = "tool_loop_iteration_limit_reached";
  }

  return {
    answer: finalText, // puede ser null si errored -- el llamador decide que mostrar
    error: errored,
    truncated,
    toolsUsed,
    toolCallLog,
    toolLoopIterations: loopGuard,
    latencyMs: Date.now() - startedAt,
    fallbackUsed,
    originalProvider,
    // Bug corregido: antes esto usaba `provider` (el override, null en
    // produccion) salvo que hubiera fallback. lastMeta.provider ya trae
    // el proveedor real que efectivamente respondio, siempre.
    usage: { ...usageTotals, model: lastMeta?.model, provider: lastMeta?.provider || provider },
  };
}
