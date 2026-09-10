#!/usr/bin/env node
// scripts/orchestrate-conviction.js
//
// Conviction Coverage Orchestrator MVP. Corre en un runner de GitHub
// Actions (egress real -- este sandbox de Claude Code no tiene acceso a
// *.vercel.app/*.sec.gov, confirmado con curl real, ver informe del
// sprint). Responsabilidad UNICA: orquestar llamadas a los endpoints ya
// existentes (api/sec-benchmark-temp.js, api/conviction-benchmark-temp.js)
// y persistir el estado del run -- CERO reimplementacion del motor de
// SEC/scoring/Opportunities, eso vive exclusivamente en esos endpoints y
// en lib/*.js.
//
// Uso: node scripts/orchestrate-conviction.js --tickers=GOOG,NVDA --mode=FULL_PIPELINE
// Env requerido: MONI_ADMIN_SECRET (auth de la app -- nunca se imprime).
// Env opcional: VERCEL_BASE_URL (default: el preview de este sprint),
//   VERCEL_PROTECTION_BYPASS_SECRET (bypass de Vercel Deployment
//   Protection a nivel de plataforma -- capa SEPARADA de
//   MONI_ADMIN_SECRET, defense in depth; si Deployment Protection no
//   esta activo en el proyecto simplemente se omite el header).

import { needsSecFetch, needsScoring, classifySecResult, verifyEngineInvariants, deriveRunStatus, buildRunSummary, classifyAuthResponse } from "../lib/orchestratorState.js";

const DEFAULT_BASE_URL = "https://moni-capital-git-claude-supabase-mon-bcfab4-moni19-mxs-projects.vercel.app";
const BASE_URL = process.env.VERCEL_BASE_URL || DEFAULT_BASE_URL;
const SECRET = process.env.MONI_ADMIN_SECRET;
// Bypass de Vercel Deployment Protection (item 1-2 del sprint de
// automatizacion) -- capa DISTINTA del auth de la app (x-admin-secret).
// Defense in depth deliberado (item 6): el bypass solo atraviesa la
// proteccion de plataforma de Vercel, nunca reemplaza la autorizacion
// administrativa propia de Moni. Opcional: si no esta configurado,
// simplemente no se manda ese header (para no romper un entorno sin
// Deployment Protection activo).
const VERCEL_BYPASS = process.env.VERCEL_PROTECTION_BYPASS_SECRET;

function parseArgs() {
  const args = { tickers: [], mode: "FULL_PIPELINE", resumeRunId: null };
  for (const arg of process.argv.slice(2)) {
    const [key, value] = arg.replace(/^--/, "").split("=");
    if (key === "tickers") args.tickers = value.split(",").map((t) => t.trim().toUpperCase()).filter(Boolean);
    if (key === "mode") args.mode = value;
    if (key === "resume-run-id") args.resumeRunId = value;
  }
  return args;
}

async function callVercel(path, { method = "GET", body } = {}) {
  // Helper central UNICA (item 4) -- todas las llamadas administrativas
  // pasan por aca, nunca se duplican headers por endpoint. Dos capas de
  // auth SEPARADAS (item 2/6, defense in depth): el bypass de Vercel
  // solo atraviesa Deployment Protection a nivel de plataforma; el
  // admin-secret sigue siendo la autorizacion propia de Moni, nunca se
  // reemplazan entre si.
  const url = `${BASE_URL}${path}`;
  const headers = { "x-admin-secret": SECRET };
  if (VERCEL_BYPASS) headers["x-vercel-protection-bypass"] = VERCEL_BYPASS;
  if (body) headers["Content-Type"] = "application/json";
  const resp = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const contentType = resp.headers.get("content-type") || "";
  const rawText = await resp.text();
  let json = null;
  try { json = JSON.parse(rawText); } catch { /* respuesta no-JSON, json queda null */ }
  const authFailure = classifyAuthResponse({ status: resp.status, contentType, parsedBody: json });
  return { ok: resp.ok, status: resp.status, json, contentType, authFailure };
}

function logStep(ticker, msg) {
  // Nunca imprime SECRET -- solo mensajes de progreso.
  console.log(`[${ticker || "run"}] ${msg}`);
}

// Item 5: reporta PLATFORM_AUTH_FAILED vs APP_AUTH_FAILED (o un error
// http generico si no es 401/403) sin revelar ningun secreto -- solo
// status, content-type, y la clasificacion pura de
// lib/orchestratorState.js::classifyAuthResponse.
function reportAuthOrHttpFailure(step, resp) {
  if (resp.authFailure === "PLATFORM_AUTH_FAILED") {
    console.error(`[${step}] PLATFORM_AUTH_FAILED -- Vercel Deployment Protection bloqueo la request antes de llegar a nuestro codigo (http ${resp.status}, content-type="${resp.contentType}"). Revisar VERCEL_PROTECTION_BYPASS_SECRET.`);
  } else if (resp.authFailure === "APP_AUTH_FAILED") {
    console.error(`[${step}] APP_AUTH_FAILED -- Vercel dejo pasar la request, pero x-admin-secret no coincide con MONI_ADMIN_SECRET en el deployment actual (http ${resp.status}).`);
  } else {
    console.error(`[${step}] http ${resp.status} (no relacionado a auth)`);
  }
}

async function updateItem(runId, ticker, fields) {
  await callVercel(`/api/conviction-benchmark-temp?run_action=update_item`, {
    method: "POST", body: { run_id: runId, ticker, fields },
  });
}

async function processTicker(runId, ticker, mode, runItem) {
  const blockedAs = async (reason, errMsg) => {
    await updateItem(runId, ticker, {
      status: "BLOCKED", blocker_reason: reason, last_error: errMsg || null, completed_at: new Date().toISOString(),
    });
    return { ticker, status: "BLOCKED", blocker_reason: reason };
  };

  await updateItem(runId, ticker, { status: "SEC_CHECK", current_step: "sec_status", started_at: new Date().toISOString() });

  const statusResp = await callVercel(`/api/conviction-benchmark-temp?run_action=sec_status`, {
    method: "POST", body: { tickers: [ticker] },
  });
  if (!statusResp.ok) return blockedAs("SEC_HTTP_ERROR", `sec_status http ${statusResp.status} (${statusResp.authFailure})`);
  const secStatus = statusResp.json.results[0];

  if (mode !== "SCORE_ONLY" && needsSecFetch({ runItem, secStatusFromDb: secStatus })) {
    await updateItem(runId, ticker, { status: "SEC_FETCHING", current_step: "sec_fetch", sec_status: "FETCHING" });
    logStep(ticker, "SEC data no encontrado / incompleto -- fetching...");
    const secResp = await callVercel(`/api/sec-benchmark-temp?tickers=${encodeURIComponent(ticker)}`);
    const secOk = secResp.ok && secResp.json?.summary?.[0]?.ok === true;
    if (!secOk) {
      return blockedAs("SEC_HTTP_ERROR", secResp.json?.summary?.[0]?.error || `sec fetch http ${secResp.status} (${secResp.authFailure})`);
    }
    // Re-chequear estado real post-fetch -- nunca asumir que el insert
    // implica READY_TO_SCORE (puede haber quedado con conceptos
    // faltantes / DATA_UNAVAILABLE reales).
    const postResp = await callVercel(`/api/conviction-benchmark-temp?run_action=sec_status`, {
      method: "POST", body: { tickers: [ticker] },
    });
    const postStatus = postResp.json?.results?.[0];
    const blocker = classifySecResult({ httpOk: postResp.ok, secStatus: postStatus, readyToScore: postStatus?.ready_to_score });
    if (blocker) return blockedAs(blocker, `post-fetch sec_status: ${JSON.stringify(postStatus)}`);
    await updateItem(runId, ticker, { status: "SEC_READY", sec_status: "SUCCESS", sec_completed_at: new Date().toISOString() });
  } else {
    logStep(ticker, "SEC ya listo (SEC_READY existente) -- 0 re-fetch, idempotencia respetada.");
    await updateItem(runId, ticker, { status: "SEC_READY", sec_status: "SUCCESS", sec_completed_at: new Date().toISOString() });
  }

  if (mode === "SEC_ONLY") {
    await updateItem(runId, ticker, { status: "COMPLETE", completed_at: new Date().toISOString() });
    return { ticker, status: "COMPLETE", note: "sec_only_mode" };
  }

  let convictionHistoryId = runItem?.conviction_history_id ?? null;
  let decisionId = runItem?.decision_id ?? null;
  let scoringResult = null;

  if (needsScoring({ runItem })) {
    await updateItem(runId, ticker, { status: "SCORING", current_step: "score_tickers" });
    logStep(ticker, "scoring...");
    const scoreResp = await callVercel(`/api/conviction-benchmark-temp?score_tickers=${encodeURIComponent(ticker)}`);
    const scoreRow = scoreResp.json?.scoring?.results?.find((r) => r.ticker === ticker);
    if (!scoreResp.ok || !scoreRow || scoreRow.skipped) {
      return blockedAs("SCORING_ERROR", scoreRow?.reason || `scoring http ${scoreResp.status} (${scoreResp.authFailure})`);
    }
    scoringResult = scoreRow;
    convictionHistoryId = scoreRow.conviction_history_id;
    decisionId = scoreRow.decision_id ?? null;
    await updateItem(runId, ticker, {
      status: "SCORED", score_status: "SCORED", scoring_completed_at: new Date().toISOString(),
      conviction_history_id: convictionHistoryId, decision_id: decisionId,
    });
  } else {
    logStep(ticker, `scoring ya hecho en este run (conviction_history_id=${convictionHistoryId}) -- 0 re-score, SAME_RUN idempotency.`);
  }

  await updateItem(runId, ticker, { status: "VERIFYING", current_step: "verify_history" });
  const verifyResp = await callVercel(`/api/conviction-benchmark-temp?run_action=verify_history&ids=${convictionHistoryId}`);
  const historyRow = verifyResp.json?.rows?.[0];
  const invariants = verifyEngineInvariants(historyRow);
  if (!verifyResp.ok || !invariants.ok) {
    return blockedAs("VERIFICATION_FAILED", invariants.violations.join(","));
  }

  await updateItem(runId, ticker, { status: "VERIFIED", completed_at: new Date().toISOString() });
  return {
    ticker, status: "VERIFIED", conviction_history_id: convictionHistoryId, decision_id: decisionId,
    previous_conviction: historyRow.previous_conviction, proposed_conviction: historyRow.proposed_conviction,
    accepted_conviction: historyRow.accepted_conviction, deterministic_status: historyRow.deterministic_status,
    scoring: scoringResult,
  };
}

async function main() {
  if (!SECRET) {
    console.error("MONI_ADMIN_SECRET no esta configurado -- abortando sin hacer ninguna llamada.");
    process.exit(1);
  }
  const { tickers: cliTickers, mode, resumeRunId } = parseArgs();

  let runId;
  let tickers;
  let itemsByTicker = {};

  if (resumeRunId) {
    // Resume real (item 3/5): lee run_items ya persistidos y salta
    // SEC/scoring en cada ticker que ya los tenga hechos -- no depende
    // de un array en memoria de una corrida anterior que pudo haber
    // muerto a mitad de camino.
    const getResp = await callVercel(`/api/conviction-benchmark-temp?run_action=get_run&run_id=${resumeRunId}`);
    if (!getResp.ok) {
      reportAuthOrHttpFailure("get_run", getResp);
      process.exit(1);
    }
    runId = resumeRunId;
    tickers = getResp.json.items.map((i) => i.ticker);
    getResp.json.items.forEach((i) => { itemsByTicker[i.ticker] = i; });
    logStep(null, `Resumiendo run_id=${runId} (${tickers.length} tickers, ${getResp.json.items.filter((i) => i.status === "VERIFIED" || i.status === "COMPLETE").length} ya completos)`);
  } else {
    if (cliTickers.length === 0) {
      console.error("Sin tickers -- usa --tickers=GOOG,NVDA o --resume-run-id=N");
      process.exit(1);
    }
    tickers = cliTickers;
    logStep(null, `Conviction Coverage Orchestrator -- mode=${mode} tickers=${tickers.join(",")}`);
    const createResp = await callVercel(`/api/conviction-benchmark-temp?run_action=create_run`, {
      method: "POST", body: { mode, tickers },
    });
    if (!createResp.ok) {
      reportAuthOrHttpFailure("create_run", createResp);
      process.exit(1);
    }
    runId = createResp.json.run_id;
    logStep(null, `run_id=${runId}`);
  }

  const results = [];
  // Secuencial, uno por uno -- cada fetch SEC es su propia llamada
  // pequeña a Vercel (1 ticker por request), nunca N tickers en una sola
  // llamada -- elimina por completo el problema de "safe batch size":
  // no hay batch, y cada request individual toma ~3s reales (ver
  // instrumentacion), muy lejos del limite de 60s de Vercel.
  for (const ticker of tickers) {
    try {
      const runItem = itemsByTicker[ticker] || null;
      if (runItem && (runItem.status === "VERIFIED" || runItem.status === "COMPLETE")) {
        logStep(ticker, "ya VERIFIED/COMPLETE en este run -- skip total, 0 llamadas.");
        results.push({
          ticker, status: runItem.status, conviction_history_id: runItem.conviction_history_id,
          decision_id: runItem.decision_id,
        });
        continue;
      }
      const result = await processTicker(runId, ticker, mode, runItem);
      results.push(result);
    } catch (err) {
      // Aislamiento de fallos (item 10): un ticker roto nunca aborta el
      // loop -- se registra bloqueado y se sigue con el siguiente.
      logStep(ticker, `EXCEPTION: ${err.message}`);
      await updateItem(runId, ticker, { status: "BLOCKED", blocker_reason: "SCORING_ERROR", last_error: String(err.message || err) });
      results.push({ ticker, status: "BLOCKED", blocker_reason: "SCORING_ERROR", last_error: String(err.message || err) });
    }
  }

  let opportunityByTicker = {};
  if (mode !== "SEC_ONLY") {
    const oppResp = await callVercel(`/api/conviction-benchmark-temp?opportunities=true`);
    if (oppResp.ok) {
      (oppResp.json?.opportunities || []).forEach((o) => { opportunityByTicker[o.ticker] = o; });
    }
  }

  const runStatus = deriveRunStatus(results.map((r) => ({ status: r.status })));
  await callVercel(`/api/conviction-benchmark-temp?run_action=complete_run`, {
    method: "POST", body: { run_id: runId, status: runStatus },
  });

  // Reporte humano (item 16) -- funcion pura (lib/orchestratorState.js),
  // va a stdout y, si GITHUB_STEP_SUMMARY existe (siempre en un job real
  // de GitHub Actions), tambien ahi como job summary legible sin JSON
  // crudo. La firma de buildRunSummary no acepta SECRET/credenciales --
  // estructuralmente no puede filtrarlo, ver test dedicado.
  const summaryText = buildRunSummary({ runId, tickers, results, opportunityByTicker });
  console.log(summaryText);
  if (process.env.GITHUB_STEP_SUMMARY) {
    const fs = await import("node:fs");
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summaryText + "\n");
  }

  console.log(`\nRUN_STATUS=${runStatus}`);
  process.exit(runStatus === "FAILED" ? 1 : 0);
}

main().catch((err) => {
  console.error("Orchestrator fatal error:", err.message);
  process.exit(1);
});
