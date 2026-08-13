// api/ai.js
// Unico endpoint de Moni AI (disciplina de funciones aprendida el dia que
// Vercel Hobby rechazo el deployment por pasarse de 12 funciones -- ver
// api/manage.js para el mismo patron aplicado a las escrituras).
//
// 6 acciones:
// - chat: una pregunta, corre el tool-calling loop contra el proveedor
//   activo (con failover automatico si el proveedor primario falla por
//   transporte), guarda el turno en ai_conversations y el uso en ai_usage.
// - generate_insight: genera un insight cacheado (hoy solo scope="today",
//   el Daily Brief). Pide JSON estructurado de 4 secciones, calcula
//   Confidence Score deterministico, guarda metadata completa, y poda el
//   historial a los ultimos 30 por scope.
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

// System prompt dedicado para Daily Brief -- pide JSON estructurado en vez
// de texto libre, porque el frontend necesita renderizar 4 secciones
// distintas, no un parrafo.
const DAILY_BRIEF_SYSTEM_PROMPT = `Eres Moni AI generando el Daily Brief de hoy para tu unico cliente en Moni Capital. (prompt v${PROMPT_VERSION})

Usa las herramientas necesarias (get_portfolio_summary, get_strategy_status, get_decision_queue, get_system_health, get_recent_changes) para construir el resumen del dia.

Responde UNICAMENTE con un objeto JSON, sin texto adicional, sin backticks de markdown, exactamente con esta forma:
{
  "estado_general": "1-2 frases sobre el estado general del patrimonio hoy",
  "prioridad_del_dia": "1-2 frases sobre lo mas urgente a atender, o null si no hay nada urgente",
  "que_cambio": "1-2 frases sobre que cambio desde la ultima visita, o null si no hay dato",
  "accion_sugerida": "1-2 frases con una accion concreta sugerida, o null si no aplica"
}

Reglas obligatorias (identicas a Moni AI en cualquier otro contexto):
- Nunca inventas ni estimas un numero financiero. Todo dato sale de tus herramientas.
- Cada herramienta devuelve status: "ok" | "partial" | "not_found" | "error". Si es "partial", menciona la incompletitud en el campo correspondiente. Si es "error", di que no pudiste consultar ese dato -- nunca lo disfraces de "no existe".
- Si dos herramientas se contradicen, señala la contradiccion y prioriza la fuente mas especifica.
- Voz: CIO. Directo. Nunca "creo que", "podria ser", "te recomiendo que compres".
- Si un campo no tiene informacion relevante, usa null -- nunca inventes contenido para llenarlo.`;

// Confidence Score del Brief: 100% determinista (Capa 1), nunca se le
// pregunta al modelo "que tan seguro estas". Se calcula a partir de los
// status reales que devolvieron las tools durante esta generacion.
function computeBriefConfidence(toolCallLog) {
  if (!toolCallLog || toolCallLog.length === 0) return 100;
  let score = 100;
  for (const call of toolCallLog) {
    const status = call.result?.status;
    if (status === "error") {
      score -= 20;
    } else if (status === "partial") {
      const coverage = call.result?.completeness?.coveragePct ?? 50;
      score -= Math.round(30 * (1 - coverage / 100));
    }
    // "ok" y "not_found" no penalizan: not_found es un hecho real, no incertidumbre.
  }
  return Math.max(0, Math.min(100, Math.round(score)));
}

async function runQuestion(question, history, provider, executorFn, systemPrompt = SYSTEM_PROMPT) {
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

    if (resource === "generate_insight") {
      const { scope, hash } = req.body || {};
      if (scope !== "today") return res.status(400).json({ error: "unsupported_scope" });
      if (!hash) return res.status(400).json({ error: "missing_hash" });

      const r = await runQuestion(
        "Genera el Daily Brief de hoy.",
        [],
        null,
        liveExecutor(FINNHUB_KEY),
        DAILY_BRIEF_SYSTEM_PROMPT
      );

      let content;
      try {
        const cleaned = (r.answer || "").replace(/```json|```/g, "").trim();
        content = JSON.parse(cleaned);
      } catch (e) {
        // Si el modelo no devolvio JSON valido, no inventamos secciones --
        // se guarda como estado_general con el texto crudo, el resto null.
        content = { estado_general: r.answer, prioridad_del_dia: null, que_cambio: null, accion_sugerida: null };
      }

      const confidence = computeBriefConfidence(r.toolCallLog);
      const cost = estimateCostUSD(r.usage?.model, r.usage?.inputTokens, r.usage?.outputTokens);

      const row = {
        scope: "today",
        content,
        confidence,
        based_on_hash: hash,
        generated_at: new Date().toISOString(),
        provider: r.usage?.provider || null,
        model: r.usage?.model || null,
        tools_used: r.toolsUsed || [],
        input_tokens: r.usage?.inputTokens ?? null,
        output_tokens: r.usage?.outputTokens ?? null,
        estimated_cost_usd: cost,
        duration_ms: r.latencyMs ?? null,
      };

      const { data: inserted, error: insertErr } = await supabase.from("ai_insights").insert([row]).select();
      if (insertErr) throw insertErr;

      // Historial de los ultimos 30 Daily Briefs -- se poda el resto.
      const { data: allForScope } = await supabase.from("ai_insights").select("id").eq("scope", "today").order("generated_at", { ascending: false });
      if (allForScope && allForScope.length > 30) {
        const idsToDelete = allForScope.slice(30).map((r) => r.id);
        await supabase.from("ai_insights").delete().in("id", idsToDelete);
      }

      await logUsage({ sessionId: session_id, mode: "daily_brief", result: r });

      return res.status(200).json({ ok: true, insight: inserted?.[0] || row, error: r.error });
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
