// api/ai.js
// Unico endpoint de Moni AI (disciplina de funciones aprendida el dia que
// Vercel Hobby rechazo el deployment por pasarse de 12 funciones -- ver
// api/manage.js para el mismo patron aplicado a las escrituras).
//
// 4 acciones:
// - chat: una pregunta, corre el tool-calling loop contra el proveedor
//   activo (MONI_AI_PROVIDER), guarda el turno en ai_conversations.
// - benchmark_question: UNA pregunta contra UN proveedor especifico, con
//   herramientas REALES en vivo (Live Test). Se llama muchas veces desde
//   el navegador, nunca todas dentro de una sola funcion de Vercel.
// - controlled_question: la MISMA pregunta contra UN proveedor, pero
//   usando un toolCallLog ya capturado en vez de ejecutar las
//   herramientas de verdad -- asi los 3 modelos reciben exactamente los
//   mismos datos y la comparacion mide solo razonamiento, no suerte con
//   Finnhub/CoinGecko en el momento.
//
// Regla que nunca cambia: el modelo NUNCA calcula un numero financiero.
// Solo interpreta lo que devuelven las tools de lib/aiTools.js.

import { createClient } from "@supabase/supabase-js";
import { checkRateLimit, recordFailedAttempt } from "../lib/security.js";
import { callModel } from "../lib/aiGateway.js";
import { TOOL_DEFINITIONS, executeTool } from "../lib/aiTools.js";
import { EVALUATION_SET_V1 } from "../lib/evaluationSet.js";

const supabase = createClient(
  process.env.VITE_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const PROMPT_VERSION = "1.1";

const SYSTEM_PROMPT = `Eres Moni AI, el Chief Investment Officer del Family Office digital de tu unico cliente, llamado Moni Capital. (prompt v${PROMPT_VERSION})

Reglas obligatorias:
- Nunca inventas ni estimas un numero financiero. Todo dato sale de tus herramientas.
- Cada herramienta devuelve status: "ok" | "not_found" | "error".
  - Si status es "not_found": el dato genuinamente no existe. Di: "No tengo ese dato registrado todavía."
  - Si status es "error": fallo tecnico consultando el dato. Di: "No pude consultar ese dato en este momento." NUNCA lo disfraces de "no existe".
- Nunca calculas tu mismo un numero que una herramienta ya calculo -- solo lo interpretas y lo priorizas.
- Voz: CIO. Breve. Directo. Nunca digas "creo que", "podria ser", "tal vez", "te recomiendo que compres". Da observaciones directas ancladas en datos reales.
- Maximo 3-4 frases por respuesta, salvo que te pidan explicitamente mas detalle.
- Nunca te presentas como un modelo de lenguaje generico. Eres Moni AI.
- Si te preguntan algo fuera del portafolio de tu cliente, redirige brevemente a tu proposito: analizar SU patrimonio.`;

// executorFn: (name, input) => Promise<toolResultObject>
// En Live Test es executeTool real (Capa 1 de verdad). En Controlled Test
// es un reemplazo que busca en un toolCallLog ya capturado, para que los
// 3 modelos vean exactamente los mismos datos.
async function runQuestion(question, history, provider, executorFn) {
  const messages = [...history, { role: "user", content: question }];
  let finalText = null;
  let loopGuard = 0;
  const toolsUsed = [];
  const toolCallLog = [];
  const usageTotals = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  let lastMeta = null;
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

  return {
    answer: finalText,
    error: errored,
    toolsUsed,
    toolCallLog,
    toolLoopIterations: loopGuard,
    latencyMs: Date.now() - startedAt,
    usage: { ...usageTotals, model: lastMeta?.model, provider },
  };
}

// Reemplazo de executeTool para Controlled Test: busca en el log
// capturado por nombre de herramienta, en orden (si se llama 2 veces la
// misma tool, usa la siguiente entrada capturada). Si el modelo pide una
// herramienta que no esta en el log capturado, se marca error explicito
// -- nunca se inventa un resultado para esa herramienta.
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
      const question = EVALUATION_SET_V1[questionIndex];
      if (!question) return res.status(400).json({ error: "invalid_question_index" });

      const r = await runQuestion(question, [], provider, liveExecutor(FINNHUB_KEY));
      return res.status(200).json({ mode: "live", provider, question, questionIndex, ...r });
    }

    if (resource === "controlled_question") {
      // CONTROLLED TEST / ADVERSARIAL TEST: la pregunta viene como texto
      // directo (no como indice) para poder usar tanto el Evaluation Set
      // v1 como preguntas adversariales nuevas que no estan en ese set.
      // NUNCA toca Finnhub/CoinGecko/Supabase -- todo sale de capturedLog.
      const { provider, question: qText, capturedLog } = req.body || {};
      if (!provider || !qText || !Array.isArray(capturedLog)) {
        return res.status(400).json({ error: "missing_fields" });
      }

      const r = await runQuestion(qText, [], provider, makeControlledExecutor(capturedLog));
      return res.status(200).json({ mode: "controlled", provider, question: qText, ...r });
    }

    return res.status(400).json({ error: "unknown_resource" });
  } catch (err) {
    return res.status(500).json({ error: "ai_failed", detail: String(err.message || err) });
  }
}
