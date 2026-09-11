// tests/autonomousGitContract.test.js
//
// Moni Autonomous Dev Loop V1, Fase A -- pruebas puras del contrato de
// seguridad de git/worktree. checkGitState NUNCA ejecuta git realmente
// aqui -- todo el estado (esperado y real) se inyecta, exactamente como
// lo haria scripts/autonomous/gitContract.mjs despues de leerlo.

import { test } from "node:test";
import assert from "node:assert/strict";
import { checkGitState, appendIterationRecord, buildInitialTrace } from "../lib/autonomousGitContract.js";

const BASE = {
  expectedBranch: "autonomous/canary-task",
  expectedBaseSha: "base111",
  expectedPreviousSha: null,
  currentBranch: "autonomous/canary-task",
  currentSha: "base111",
  isCleanWorkingTree: true,
  unrelatedUncommittedFiles: [],
};

test("A - checkGitState: iteracion 1, estado exactamente esperado -> ok", () => {
  const result = checkGitState(BASE);
  assert.equal(result.ok, true);
});

test("B - checkGitState: working tree sucio sin archivos identificados -> DIRTY_WORKING_TREE", () => {
  const result = checkGitState({ ...BASE, isCleanWorkingTree: false, unrelatedUncommittedFiles: [] });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "DIRTY_WORKING_TREE");
});

test("C - checkGitState: cambios sin commitear no relacionados -> UNRELATED_UNCOMMITTED_CHANGES, nunca se sobreescriben", () => {
  const result = checkGitState({ ...BASE, isCleanWorkingTree: false, unrelatedUncommittedFiles: ["src/SomethingElse.jsx"] });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "UNRELATED_UNCOMMITTED_CHANGES");
  assert.ok(result.detail.includes("SomethingElse"));
});

test("D - checkGitState: rama actual distinta de la esperada -> GIT_STATE_CHANGED", () => {
  const result = checkGitState({ ...BASE, currentBranch: "main" });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "GIT_STATE_CHANGED");
});

test("E - checkGitState: SHA actual distinto del base en iteracion 1 -> GIT_STATE_CHANGED (posible push humano)", () => {
  const result = checkGitState({ ...BASE, currentSha: "unexpectedSha999" });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "GIT_STATE_CHANGED");
});

test("F - checkGitState: iteracion > 1 usa expectedPreviousSha, no expectedBaseSha", () => {
  const result = checkGitState({ ...BASE, expectedPreviousSha: "iter1sha", currentSha: "iter1sha" });
  assert.equal(result.ok, true);
});

test("G - checkGitState: iteracion > 1, SHA real no coincide con el de la iteracion previa -> GIT_STATE_CHANGED", () => {
  const result = checkGitState({ ...BASE, expectedPreviousSha: "iter1sha", currentSha: "base111" });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "GIT_STATE_CHANGED");
});

test("H - buildInitialTrace: arma la traza inicial con iterations vacio y final_head_sha null", () => {
  const trace = buildInitialTrace({ taskId: "canary-task", branch: "autonomous/canary-task", baseSha: "base111" });
  assert.deepEqual(trace, { task_id: "canary-task", branch: "autonomous/canary-task", base_sha: "base111", iterations: [], final_head_sha: null });
});

test("I - appendIterationRecord: acumula iteraciones sin mutar la traza original (funcion pura)", () => {
  const trace0 = buildInitialTrace({ taskId: "canary-task", branch: "autonomous/canary-task", baseSha: "base111" });
  const trace1 = appendIterationRecord(trace0, { iteration: 1, headSha: "iter1sha", verdict: "HOLD" });
  assert.equal(trace0.iterations.length, 0, "la traza original nunca se muta");
  assert.equal(trace1.iterations.length, 1);
  assert.equal(trace1.final_head_sha, "iter1sha");

  const trace2 = appendIterationRecord(trace1, { iteration: 2, headSha: "iter2sha", verdict: "PASS" });
  assert.equal(trace2.iterations.length, 2);
  assert.equal(trace2.final_head_sha, "iter2sha");
  assert.equal(trace2.iterations[0].verdict, "HOLD");
  assert.equal(trace2.iterations[1].verdict, "PASS");
});
