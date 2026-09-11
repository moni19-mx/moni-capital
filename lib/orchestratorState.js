// lib/orchestratorState.js
//
// Funciones PURAS del Conviction Coverage Orchestrator -- cero red, cero
// Supabase. scripts/orchestrate-conviction.js es el unico llamador real;
// este archivo existe separado para que la logica de decision (que hacer
// dado un estado) sea testeable sin mockear HTTP/DB.

export const BLOCKER_REASONS = Object.freeze([
  "SEC_HTTP_ERROR",
  "SEC_DATA_UNAVAILABLE",
  "INSUFFICIENT_PERIODS",
  "INVALID_PERIOD_END",
  "DATA_QUALITY_BLOCKER",
  "SCORING_ERROR",
  "VERIFICATION_FAILED",
  "UNSUPPORTED_INSTRUMENT",
]);

// Distingue PLATFORM_AUTH_FAILED de APP_AUTH_FAILED (item 5, sprint de
// Vercel Deployment Protection) SIN revelar ningun secreto -- pura
// inspeccion de forma de la respuesta, nunca de su contenido sensible.
// Vercel Deployment Protection intercepta la request en el edge, ANTES
// de que llegue a nuestro codigo -- api/*.js nunca se ejecuta, asi que
// nunca puede reportar ese caso el mismo. Lo unico que puede distinguirlo
// es el CALLER inspeccionando la forma de la respuesta:
//   - nuestro propio 401 (checkAdminAuth fallando DENTRO de nuestro
//     codigo) siempre es JSON con {error:"unauthorized"} exacto --
//     confirma que la plataforma SI dejo pasar la request.
//   - cualquier otra forma en un 401/403 (HTML, redirect, JSON sin ese
//     shape exacto) nunca la genera nuestro codigo -- es la plataforma
//     bloqueando antes de llegar a nosotros.
export function classifyAuthResponse({ status, contentType, parsedBody }) {
  if (status !== 401 && status !== 403) return "OK";
  const isJson = (contentType || "").includes("application/json");
  const isOurAppShape = isJson && parsedBody && typeof parsedBody === "object" && parsedBody.error === "unauthorized";
  if (isOurAppShape) return "APP_AUTH_FAILED";
  return "PLATFORM_AUTH_FAILED";
}

// Decide si hace falta un fetch SEC nuevo para este ticker en este run.
// SAME_RUN idempotency (item 5): si el run_item ya tiene sec_status=SUCCESS
// (resume de un run que murio a mitad de camino), nunca re-fetch. Si el
// ticker ya tiene datos SEC de un run anterior (secStatusFromDb.ready_to_score),
// tampoco -- eso es lo que le permite al canary GOOG/NVDA arrancar
// directo en SEC_READY sin re-ingestar nada.
export function needsSecFetch({ runItem, secStatusFromDb }) {
  if (runItem?.sec_status === "SUCCESS") return false;
  if (secStatusFromDb?.ready_to_score) return false;
  return true;
}

// Decide si hace falta scoring nuevo. SAME_RUN idempotency: si este
// run_item YA tiene scoring_completed_at Y conviction_history_id validos,
// nunca genera otra fila -- evita que un resume produzca una segunda
// propuesta identica en conviction_history (que es append-only e
// incondicional a nivel de API, ver auditoria de idempotencia).
export function needsScoring({ runItem }) {
  if (runItem?.scoring_completed_at && runItem?.conviction_history_id) return false;
  return true;
}

// Clasifica un resultado crudo del endpoint SEC en un blocker_reason del
// vocabulario fijo, o null si no hay bloqueo.
export function classifySecResult({ httpOk, secStatus, readyToScore }) {
  if (!httpOk) return "SEC_HTTP_ERROR";
  if (secStatus && secStatus.sec_rows_found === false) return "SEC_DATA_UNAVAILABLE";
  if (secStatus && secStatus.revenue_periods < 2) return "INSUFFICIENT_PERIODS";
  if (!readyToScore) return "DATA_QUALITY_BLOCKER";
  return null;
}

// Invariantes financieros que el orchestrator verifica despues de cada
// scoring (item 15) -- nunca confia en el JSON de respuesta del endpoint
// de scoring solo, siempre relee conviction_history via verify_history.
export function verifyEngineInvariants(historyRow) {
  const violations = [];
  if (historyRow == null) {
    violations.push("conviction_history_row_not_found");
    return { ok: false, violations };
  }
  if (historyRow.accepted_conviction !== null) violations.push("accepted_conviction_not_null");
  if (historyRow.source !== "ENGINE_PROPOSAL") violations.push("source_not_engine_proposal");
  return { ok: violations.length === 0, violations };
}

// Nunca deja que el secreto real aparezca en un log/summary -- usado
// antes de cualquier console.log/JSON.stringify de headers o config.
export function redactSecret(value) {
  if (!value) return value;
  return "***REDACTED***";
}

export function deriveRunStatus(items) {
  const statuses = items.map((i) => i.status);
  if (statuses.every((s) => s === "COMPLETE" || s === "VERIFIED")) return "COMPLETE";
  if (statuses.some((s) => s === "COMPLETE" || s === "VERIFIED")) return "PARTIAL";
  return "FAILED";
}

// Reporte humano (item 16) -- funcion pura, nunca recibe SECRET ni
// ningun credential como argumento por diseño de firma (solo resultados
// ya resueltos + metadata de run), asi que es estructuralmente imposible
// que el secreto termine en el summary/log -- ver test dedicado.
export function buildRunSummary({ runId, tickers, results, opportunityByTicker }) {
  const lines = [];
  lines.push(`# CONVICTION COVERAGE RUN`);
  lines.push(``);
  lines.push(`run_id: ${runId}`);
  lines.push(`requested: ${tickers.length} | complete/verified: ${results.filter((r) => r.status === "VERIFIED" || r.status === "COMPLETE").length} | blocked: ${results.filter((r) => r.status === "BLOCKED").length}`);
  lines.push(``);
  lines.push(`| Ticker | SEC | Score | Manual | Engine | Delta | Coverage | Confidence | Opportunity Priority | Human Review | Blocker |`);
  lines.push(`|---|---|---|---|---|---|---|---|---|---|---|`);
  for (const r of results) {
    const opp = opportunityByTicker[r.ticker];
    lines.push(`| ${r.ticker} | ${r.status !== "BLOCKED" ? "OK" : "-"} | ${r.deterministic_status || "-"} | ${r.previous_conviction ?? "-"} | ${r.proposed_conviction ?? "-"} | ${r.proposed_conviction != null && r.previous_conviction != null ? (r.proposed_conviction - r.previous_conviction).toFixed(1) : "-"} | ${r.scoring?.coverage ?? "-"} | ${r.scoring?.overall_confidence ?? "-"} | ${opp?.overall_review_priority ?? "-"} | ${r.scoring?.requires_user_review ?? "-"} | ${r.blocker_reason || ""} |`);
  }
  const needsReview = results.filter((r) => r.scoring?.requires_user_review || r.status === "BLOCKED");
  if (needsReview.length > 0) {
    lines.push(``);
    lines.push(`## NEEDS HUMAN REVIEW`);
    needsReview.forEach((r) => lines.push(`- ${r.ticker}: ${r.status === "BLOCKED" ? `BLOCKED (${r.blocker_reason})` : "review_required=true"}`));
  }
  return lines.join("\n");
}
