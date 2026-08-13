// api/ai.js
// Unico endpoint de Moni AI (disciplina de funciones aprendida el dia que
// Vercel Hobby rechazo el deployment por pasarse de 12 funciones -- ver
// api/manage.js para el mismo patron aplicado a las escrituras).
//
// 5 acciones:
// - chat: una pregunta, corre el tool-calling loop contra el proveedor
//   activo (con failover automatico si el proveedor primario falla por
//   transporte), guarda el turno en ai_conversations y el uso en ai_usage.
// - benchmark_question: UNA pregunta contra UN proveedor especifico, con
//   herramientas REALES en vivo (Live Test).
// - controlled_question: la MISMA pregunta contra UN proveedor, usando un
//   toolCallLog ya capturado -- cero llamadas reales a Finnhub/CoinGecko/
//   Supabase, solo al modelo.
// - prune_conversations: borra turnos de ai_conversations mas viejos que
//   N dias (default 30). Preparacion para cuando el chat este activo de
//   verdad -- sin esto, la tabla crece sin limite.
//
// Regla que nunca cambia: el modelo NUNCA calcula un numero financiero.
// Solo interpreta lo que devuelven las tools de lib/aiTools.js.

import { createClient } from "@supabase/supabase-js";
import { checkRateLimit, recordFailedAttempt } from "../lib/security.js";
import { callModel } from "../lib/aiGateway.js";
import { TOOL_DEFINITIONS, executeTool } from "../lib/aiTools.js";
import { EVALUATION_SET_V1 } from "../lib/evaluationSet.js";
import { estimateCostUSD } from "../lib/aiPricing.js";

const supabase = createClient(
  process.env.VITE_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const PROMPT_VERSION = "1.1.1";

const SYSTEM_PROMPT = `Eres Moni AI, el Chief Investment Officer del Family Office digital de tu unico cliente, llamado Moni Capital. (prompt v${PROMPT_VERSION})

Reglas obligatorias:
- Nunca inventas ni estimas un numero financiero. Todo dato sale de tus herramientas.
- Cada herramienta devuelve status: "ok" | "partial" | "not_found" | "error".
  - Si status es "ok": el dato esta completo, interpretalo con normalidad.
  - Si status es "partial": el dato es real pero incompleto -- algunas posiciones no se pudieron consultar (revisa completeness.missingTickers y completeness.coveragePct). SIEMPRE menciona explícitamente que la información está incompleta antes de dar conclusiones basadas en ese numero. Nunca trates un total parcial como si fuera el total real.
  - Si status es "not_found": el dato genuinamente no existe. Di: "No tengo ese dato registrado todavía."
  - Si status es "error": fallo tecnico consultando el dato. Di: "No pude consultar ese dato en este momento." NUNCA lo disfraces de "no existe".
- Nunca calculas tu mismo un numero que una herramienta ya calculo -- solo lo interpretas y lo priorizas.
- Si dos herramientas se contradicen, señala la contradicción explícitamente y prioriza la fuente más específica y reciente sobre un agregado genérico.
- Voz: CIO. Breve. Directo. Nunca digas "creo que", "podria ser", "tal vez", "te recomiendo que compres". Da observaciones directas ancladas en datos reales.
- Maximo 3-4 frases por respuesta, salvo que te pidan explicitamente mas detalle.
- Nunca te presentas como un modelo de lenguaje generico. Eres Moni AI.
- Si te preguntan algo fuera del portafolio de tu cliente, redirige brevemente a tu proposito: analizar SU patrimonio.`;

async function runQuestion(question, history, provider, executorFn) {
  const messages = [...history, { role: "user", content: question }];
  let finalText = null;
  let loopGuard = 0;
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
        system: SYSTEM_PROMPT,
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
      } else {
        finalText = result.content || "No tengo una respuesta para eso todavía.";
      }
    }
  } catch (e) {
    errored = String(e.message || e);
  }

  if (finalText === null && !errored) {
    finalText = "No pude terminar de procesar tu pregunta. Intenta de nuevo.";
  }

  const finalProvider = fallbackUsed ? lastMeta?.provider : provider;
  return {
    answer: finalText,
    error: errored,
    toolsUsed,
    toolCallLog,
    toolLoopIterations: loopGuard,
    latencyMs: Date.now() - startedAt,
    fallbackUsed,
    originalProvider,
    usage: { ...usageTotals, model: lastMeta?.model, provider: finalProvider || provider },
  };
}

function makeControlledExecutor(capturedLog) {
  const remaining = {};
  (capturedLog || []).forEach((entry) => {
    if (!remaining[entry.name]) remaining[entry.name] = [];
    remaining[entry.name].push(entry.result);
  });
  return async (name) => {
    const queue = remaining[name];
    if (!queue || queue.length === 0) {
      return { status: "error", data: null, asOf: new Date().toISOString(), source: "controlled_test", errorCode: "no_captured_result_for_replay" };
    }
    return queue.shift();
  };
}

function liveExecutor(FINNHUB_KEY) {
  return (name, input) => executeTool(name, input, supabase, FINNHUB_KEY);
}

// Usage durable (revision critica pre-Sprint-1, punto 8): nunca depender
// solo de logs efimeros de Vercel para investigar costos meses despues.
async function logUsage({ sessionId, mode, result }) {
  try {
    const cost = estimateCostUSD(result.usage?.model, result.usage?.inputTokens, result.usage?.outputTokens);
    await supabase.from("ai_usage").insert([{
      session_id: sessionId || null,
      provider: result.usage?.provider || null,
      model: result.usage?.model || null,
      input_tokens: result.usage?.inputTokens ?? null,
      output_tokens: result.usage?.outputTokens ?? null,
      total_tokens: result.usage?.totalTokens ?? null,
      estimated_cost_usd: cost,
      duration_ms: result.latencyMs ?? null,
      tools_used: result.toolsUsed || [],
      tool_loop_iterations: result.toolLoopIterations ?? null,
      fallback_used: !!result.fallbackUsed,
      success: !result.error,
      error_code: result.error || null,
      mode,
    }]);
  } catch (e) {
    // el logging de uso nunca debe tumbar la respuesta ya generada
  }
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

  const { resource, pin, question, session_id } = req.body || {};

  const { blocked } = await checkRateLimit(supabase);
  if (blocked) {
    return res.status(429).json({ error: "rate_limited", detail: "Demasiados intentos fallidos. Espera unos minutos e intenta de nuevo." });
  }
  if (!pin || pin !== process.env.MONI_PIN) {
    await recordFailedAttempt(supabase);
    return res.status(401).json({ error: "invalid_pin" });
  }

  const FINNHUB_KEY = process.env.FINNHUB_API_KEY;

  try {
    if (resource === "chat") {
      if (!question || !question.trim()) return res.status(400).json({ error: "missing_question" });

      let history = [];
      if (session_id) {
        const { data } = await supabase.from("ai_conversations").select("*").eq("session_id", session_id).order("created_at", { ascending: true }).limit(12);
        history = (data || []).map((m) => ({ role: m.role, content: m.content }));
      }

      const result = await runQuestion(question, history, null, liveExecutor(FINNHUB_KEY));
      await logUsage({ sessionId: session_id, mode: "chat", result });

      if (session_id && !result.error) {
        try {
          await supabase.from("ai_conversations").insert([
            { session_id, role: "user", content: question },
            { session_id, role: "assistant", content: result.answer },
          ]);
        } catch (e) { /* no debe tumbar la respuesta ya generada */ }
      }

      return res.status(200).json(result);
    }

    if (resource === "benchmark_question") {
      const { provider, questionIndex } = req.body || {};
      if (!provider || questionIndex == null) return res.status(400).json({ error: "missing_fields" });
      const questionText = EVALUATION_SET_V1[questionIndex];
      if (!questionText) return res.status(400).json({ error: "invalid_question_index" });

      const r = await runQuestion(questionText, [], provider, liveExecutor(FINNHUB_KEY));
      await logUsage({ sessionId: session_id, mode: "benchmark_live", result: r });
      return res.status(200).json({ mode: "live", provider, question: questionText, questionIndex, ...r });
    }

    if (resource === "controlled_question") {
      const { provider, question: qText, capturedLog } = req.body || {};
      if (!provider || !qText || !Array.isArray(capturedLog)) {
        return res.status(400).json({ error: "missing_fields" });
      }

      const r = await runQuestion(qText, [], provider, makeControlledExecutor(capturedLog));
      await logUsage({ sessionId: session_id, mode: "benchmark_controlled", result: r });
      return res.status(200).json({ mode: "controlled", provider, question: qText, ...r });
    }

    if (resource === "prune_conversations") {
      const days = Number(req.body?.days) || 30;
      const cutoff = new Date(Date.now() - days * 86400000).toISOString();
      const { data, error } = await supabase.from("ai_conversations").delete().lt("created_at", cutoff).select("id");
      if (error) throw error;
      return res.status(200).json({ ok: true, deleted: data?.length || 0, cutoff });
    }

    return res.status(400).json({ error: "unknown_resource" });
  } catch (err) {
    return res.status(500).json({ error: "ai_failed", detail: String(err.message || err) });
  }
}
