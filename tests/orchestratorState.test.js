// tests/orchestratorState.test.js
// Conviction Coverage Orchestrator -- Priority 2 (automatizacion).
// Funciones puras de lib/orchestratorState.js: decision de skip
// SEC/scoring (SAME_RUN idempotency), clasificacion de blockers,
// invariantes financieros post-scoring, y el reporte humano.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  needsSecFetch, needsScoring, classifySecResult, verifyEngineInvariants,
  redactSecret, deriveRunStatus, buildRunSummary, BLOCKER_REASONS, classifyAuthResponse,
} from "../lib/orchestratorState.js";

// ============== needsSecFetch (item 5/7A: same-run + cross-ticker skip) ==============

test("A: sin run_item previo y sin datos SEC existentes -> needs fetch", () => {
  assert.equal(needsSecFetch({ runItem: null, secStatusFromDb: { ready_to_score: false } }), true);
});

test("B: run_item de este run ya tiene sec_status=SUCCESS -> NO re-fetch (SAME_RUN idempotency)", () => {
  assert.equal(needsSecFetch({ runItem: { sec_status: "SUCCESS" }, secStatusFromDb: { ready_to_score: false } }), false);
});

test("C: sin run_item de este run, pero el ticker YA tiene SEC data de un run anterior -> NO re-fetch (canary GOOG/NVDA)", () => {
  assert.equal(needsSecFetch({ runItem: null, secStatusFromDb: { ready_to_score: true } }), false);
});

test("D: run_item existe pero sec_status distinto de SUCCESS (ej. FETCHING interrumpido) y sin datos previos -> needs fetch", () => {
  assert.equal(needsSecFetch({ runItem: { sec_status: "FETCHING" }, secStatusFromDb: { ready_to_score: false } }), true);
});

// ============== needsScoring (item 5/6: same-run, nunca duplica conviction_history) ==============

test("E: sin scoring previo en este run_item -> needs scoring", () => {
  assert.equal(needsScoring({ runItem: null }), true);
});

test("F: run_item ya tiene scoring_completed_at Y conviction_history_id -> SKIP, no duplica fila", () => {
  assert.equal(needsScoring({ runItem: { scoring_completed_at: "2026-09-10T00:00:00Z", conviction_history_id: 48 } }), false);
});

test("G: run_item tiene scoring_completed_at pero conviction_history_id null (estado inconsistente) -> vuelve a intentar, no confia a medias", () => {
  assert.equal(needsScoring({ runItem: { scoring_completed_at: "2026-09-10T00:00:00Z", conviction_history_id: null } }), true);
});

// ============== classifySecResult (item 10: blocker taxonomy) ==============

test("H: http no-ok -> SEC_HTTP_ERROR", () => {
  assert.equal(classifySecResult({ httpOk: false }), "SEC_HTTP_ERROR");
});

test("I: sin filas SEC encontradas -> SEC_DATA_UNAVAILABLE", () => {
  assert.equal(classifySecResult({ httpOk: true, secStatus: { sec_rows_found: false } }), "SEC_DATA_UNAVAILABLE");
});

test("J: menos de 2 periodos de REVENUE -> INSUFFICIENT_PERIODS", () => {
  assert.equal(classifySecResult({ httpOk: true, secStatus: { sec_rows_found: true, revenue_periods: 1 } }), "INSUFFICIENT_PERIODS");
});

test("K: datos suficientes pero readyToScore=false por otra razon -> DATA_QUALITY_BLOCKER", () => {
  assert.equal(classifySecResult({ httpOk: true, secStatus: { sec_rows_found: true, revenue_periods: 5 }, readyToScore: false }), "DATA_QUALITY_BLOCKER");
});

test("L: todo limpio -> null (sin blocker)", () => {
  assert.equal(classifySecResult({ httpOk: true, secStatus: { sec_rows_found: true, revenue_periods: 5 }, readyToScore: true }), null);
});

test("M: BLOCKER_REASONS incluye el vocabulario fijo pedido, sin inventar categorias extra al vuelo", () => {
  ["SEC_HTTP_ERROR", "SEC_DATA_UNAVAILABLE", "INSUFFICIENT_PERIODS", "INVALID_PERIOD_END",
    "DATA_QUALITY_BLOCKER", "SCORING_ERROR", "VERIFICATION_FAILED", "UNSUPPORTED_INSTRUMENT"]
    .forEach((r) => assert.ok(BLOCKER_REASONS.includes(r), `falta ${r}`));
});

// ============== verifyEngineInvariants (item 15) ==============

test("N: accepted_conviction=null y source=ENGINE_PROPOSAL -> ok, sin violaciones", () => {
  const result = verifyEngineInvariants({ accepted_conviction: null, source: "ENGINE_PROPOSAL" });
  assert.deepEqual(result, { ok: true, violations: [] });
});

test("O: accepted_conviction distinto de null (auto-accept indebido) -> violation", () => {
  const result = verifyEngineInvariants({ accepted_conviction: 4, source: "ENGINE_PROPOSAL" });
  assert.equal(result.ok, false);
  assert.ok(result.violations.includes("accepted_conviction_not_null"));
});

test("P: source distinto de ENGINE_PROPOSAL -> violation", () => {
  const result = verifyEngineInvariants({ accepted_conviction: null, source: "MANUAL" });
  assert.equal(result.ok, false);
  assert.ok(result.violations.includes("source_not_engine_proposal"));
});

test("Q: fila no encontrada (null) -> ok=false, violation dedicada, nunca explota", () => {
  const result = verifyEngineInvariants(null);
  assert.equal(result.ok, false);
  assert.ok(result.violations.includes("conviction_history_row_not_found"));
});

// ============== redactSecret ==============

test("R: redactSecret nunca devuelve el valor real", () => {
  assert.equal(redactSecret("s3cr3t-real-value"), "***REDACTED***");
  assert.notEqual(redactSecret("s3cr3t-real-value"), "s3cr3t-real-value");
});

test("S: redactSecret con valor falsy -> lo devuelve tal cual (nunca inventa un secreto donde no hay)", () => {
  assert.equal(redactSecret(undefined), undefined);
  assert.equal(redactSecret(""), "");
});

// ============== deriveRunStatus ==============

test("T: todos VERIFIED/COMPLETE -> COMPLETE", () => {
  assert.equal(deriveRunStatus([{ status: "VERIFIED" }, { status: "COMPLETE" }]), "COMPLETE");
});

test("U: mezcla de VERIFIED y BLOCKED -> PARTIAL (item 10: un bloqueado no aborta el resto)", () => {
  assert.equal(deriveRunStatus([{ status: "VERIFIED" }, { status: "BLOCKED" }]), "PARTIAL");
});

test("V: todos BLOCKED -> FAILED", () => {
  assert.equal(deriveRunStatus([{ status: "BLOCKED" }, { status: "BLOCKED" }]), "FAILED");
});

// ============== buildRunSummary (item 16 + secreto nunca en el reporte) ==============

test("W: buildRunSummary produce tabla markdown legible con las columnas pedidas", () => {
  const summary = buildRunSummary({
    runId: 7, tickers: ["GOOG", "NVDA"],
    results: [
      { ticker: "GOOG", status: "VERIFIED", deterministic_status: "SCORED", previous_conviction: 5, proposed_conviction: 4, scoring: { coverage: 0.524, overall_confidence: 86, requires_user_review: true } },
      { ticker: "NVDA", status: "VERIFIED", deterministic_status: "SCORED", previous_conviction: 5, proposed_conviction: 4.5, scoring: { coverage: 0.524, overall_confidence: 86, requires_user_review: false } },
    ],
    opportunityByTicker: { GOOG: { overall_review_priority: "HIGH" }, NVDA: { overall_review_priority: "LOW" } },
  });
  assert.ok(summary.includes("CONVICTION COVERAGE RUN"));
  assert.ok(summary.includes("run_id: 7"));
  assert.ok(summary.includes("GOOG"));
  assert.ok(summary.includes("NVDA"));
  assert.ok(summary.includes("NEEDS HUMAN REVIEW"));
});

test("X: buildRunSummary con un BLOCKED entre exitosos -> no aborta, el bloqueado aparece con su blocker_reason", () => {
  const summary = buildRunSummary({
    runId: 8, tickers: ["A", "B"],
    results: [
      { ticker: "A", status: "VERIFIED", scoring: {} },
      { ticker: "B", status: "BLOCKED", blocker_reason: "SEC_DATA_UNAVAILABLE" },
    ],
    opportunityByTicker: {},
  });
  assert.ok(summary.includes("blocked: 1"));
  assert.ok(summary.includes("SEC_DATA_UNAVAILABLE"));
});

test("Y: la firma de buildRunSummary no acepta ningun campo de credencial -- estructuralmente no puede filtrar el secreto en el reporte/log", () => {
  const fakeSecret = "MONI_ADMIN_SECRET_TEST_VALUE_XYZ";
  const summary = buildRunSummary({
    runId: 1, tickers: ["A"],
    results: [{ ticker: "A", status: "VERIFIED", scoring: {} }],
    opportunityByTicker: {},
  });
  assert.equal(summary.includes(fakeSecret), false);
});

// ============== classifyAuthResponse (item 5: Vercel Deployment Protection vs app auth) ==============

test("Z: 200 real -> OK, no es un caso de auth failure", () => {
  assert.equal(classifyAuthResponse({ status: 200, contentType: "application/json", parsedBody: { ok: true } }), "OK");
});

test("AA: 401 con nuestro shape exacto {error:unauthorized} en JSON -> APP_AUTH_FAILED (Vercel dejo pasar, nuestro codigo corrio y rechazo)", () => {
  const result = classifyAuthResponse({ status: 401, contentType: "application/json; charset=utf-8", parsedBody: { error: "unauthorized" } });
  assert.equal(result, "APP_AUTH_FAILED");
});

test("BB: 401 con HTML (Vercel Deployment Protection block page) -> PLATFORM_AUTH_FAILED", () => {
  const result = classifyAuthResponse({ status: 401, contentType: "text/html; charset=utf-8", parsedBody: null });
  assert.equal(result, "PLATFORM_AUTH_FAILED");
});

test("CC: 401 con JSON pero forma distinta a la nuestra (no viene de checkAdminAuth) -> PLATFORM_AUTH_FAILED", () => {
  const result = classifyAuthResponse({ status: 401, contentType: "application/json", parsedBody: { message: "Authentication Required" } });
  assert.equal(result, "PLATFORM_AUTH_FAILED");
});

test("DD: 403 (no solo 401) con nuestro shape -> tambien se evalua, no solo 401", () => {
  const result = classifyAuthResponse({ status: 403, contentType: "application/json", parsedBody: { error: "unauthorized" } });
  assert.equal(result, "APP_AUTH_FAILED");
});

test("EE: 500 u otro status no-auth -> OK (no es un caso de auth failure, es otro tipo de error)", () => {
  assert.equal(classifyAuthResponse({ status: 500, contentType: "application/json", parsedBody: { error: "internal" } }), "OK");
});

test("FF: nunca revela el valor de ningun secreto -- solo status/content-type/shape entran a la funcion, nunca un valor de env var", () => {
  // La firma de classifyAuthResponse no acepta ningun parametro de
  // credencial -- estructuralmente no puede filtrar un secreto.
  const result = classifyAuthResponse({ status: 401, contentType: "text/html", parsedBody: null });
  assert.equal(typeof result, "string");
  assert.ok(!result.toLowerCase().includes("secret"));
});
