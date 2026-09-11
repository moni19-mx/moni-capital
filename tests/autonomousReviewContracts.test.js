// tests/autonomousReviewContracts.test.js
//
// Moni Autonomous Dev Loop V1, Fase A -- pruebas puras, sin red, sin
// llamadas a OpenAI/Claude. Cubre validacion de los tres contratos
// JSON Schema, el guard de auto-modificacion, la consistencia
// veredicto<->packet, y el corte de iteraciones.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  validateTaskSpec, validateReviewPacket, validateReviewResponse,
  isProtectedPath, classifyFileChanges, packetSupportsPass,
  reviewerVerdictIsInternallyConsistent, shouldStopIteration,
  deriveTaskBranchName, reviewerModelFromEnv, isForcePushArgs,
  DEFAULT_PROTECTED_PATTERNS, DEFAULT_MAX_ITERATIONS,
} from "../lib/autonomousReviewContracts.js";

const VALID_TASK_SPEC = {
  task_id: "autonomous-loop-documentation-canary",
  title: "Documentation canary",
  objective: "Prove the autonomous loop end to end on a harmless task.",
  scope: { allowed_files: ["autonomous/README.md"], forbidden_files: [] },
  acceptance_criteria: [{ id: "readme_updated", description: "README documents the loop's iteration contract", auto_checkable: false }],
  required_tests: ["npm test"],
  required_live_evidence: [],
  risk_level: "LOW",
  human_approval_required_for: [],
};

const VALID_PACKET = {
  task_id: "autonomous-loop-documentation-canary",
  iteration: 1,
  base_commit: "abc123",
  head_commit: "def456",
  files_changed: ["autonomous/README.md"],
  diff_summary: [{ file: "autonomous/README.md", additions: 10, deletions: 2 }],
  tests: { commands: ["npm test"], passed: 673, failed: 0, evidence: ["# pass 673", "# fail 0"] },
  build: { command: "npm run build", status: "PASS", evidence: ["built in 6.5s"] },
  live_evidence: [],
  schema_changes: [],
  data_writes: [],
  security_changes: [],
  financial_logic_changes: [],
  known_limitations: [],
  open_questions: [],
  acceptance_criteria: [{ criterion: "readme_updated", status: "PASS", evidence: ["diff shows README.md updated"] }],
};

const VALID_RESPONSE_PASS = {
  verdict: "PASS",
  summary: "All acceptance criteria verified with evidence.",
  blocking_findings: [],
  required_changes: [],
  tests_to_add_or_rerun: [],
  human_action: null,
  next_iteration_scope: [],
};

test("A - validateTaskSpec: TASK_SPEC.example-shaped objeto valido pasa", () => {
  const result = validateTaskSpec(VALID_TASK_SPEC);
  assert.equal(result.valid, true, JSON.stringify(result.errors));
});

test("B - validateTaskSpec: falta un campo requerido -> invalido, error explicito", () => {
  const { risk_level, ...missingRiskLevel } = VALID_TASK_SPEC;
  const result = validateTaskSpec(missingRiskLevel);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("risk_level")));
});

test("C - validateTaskSpec: risk_level fuera de enum -> invalido", () => {
  const result = validateTaskSpec({ ...VALID_TASK_SPEC, risk_level: "CATASTROPHIC" });
  assert.equal(result.valid, false);
});

test("D - validateReviewPacket: packet completo valido pasa", () => {
  const result = validateReviewPacket(VALID_PACKET);
  assert.equal(result.valid, true, JSON.stringify(result.errors));
});

test("E - validateReviewPacket: acceptance_criteria con status fuera de enum -> invalido", () => {
  const bad = { ...VALID_PACKET, acceptance_criteria: [{ criterion: "x", status: "MAYBE", evidence: [] }] };
  const result = validateReviewPacket(bad);
  assert.equal(result.valid, false);
});

test("F - validateReviewPacket: campo extra no declarado -> invalido (additionalProperties:false)", () => {
  const bad = { ...VALID_PACKET, unexpected_field: "sneaky" };
  const result = validateReviewPacket(bad);
  assert.equal(result.valid, false);
});

test("G - validateReviewResponse: PASS valido pasa", () => {
  const result = validateReviewResponse(VALID_RESPONSE_PASS);
  assert.equal(result.valid, true, JSON.stringify(result.errors));
});

test("H - validateReviewResponse: HOLD con blocking_findings valido pasa", () => {
  const hold = {
    verdict: "HOLD",
    summary: "Two issues found.",
    blocking_findings: [{ severity: "HIGH", finding: "missing test", evidence: "diff shows no new test file", required_action: "add a regression test" }],
    required_changes: ["add a test for the new function"],
    tests_to_add_or_rerun: ["tests/foo.test.js"],
    human_action: null,
    next_iteration_scope: ["tests/foo.test.js"],
  };
  const result = validateReviewResponse(hold);
  assert.equal(result.valid, true, JSON.stringify(result.errors));
});

test("I - validateReviewResponse: BLOCKED_HUMAN con human_action valido pasa", () => {
  const blocked = {
    verdict: "BLOCKED_HUMAN",
    summary: "Needs a secret.",
    blocking_findings: [],
    required_changes: [],
    tests_to_add_or_rerun: [],
    human_action: { reason: "SECRET_REQUIRED", description: "OPENAI_API_KEY missing in GitHub Actions" },
    next_iteration_scope: [],
  };
  const result = validateReviewResponse(blocked);
  assert.equal(result.valid, true, JSON.stringify(result.errors));
});

test("J - validateReviewResponse: verdict fuera de enum -> invalido, nunca se acepta un veredicto inventado", () => {
  const result = validateReviewResponse({ ...VALID_RESPONSE_PASS, verdict: "PROBABLY_FINE" });
  assert.equal(result.valid, false);
});

test("K - validateReviewResponse: human_action con reason fuera de enum -> invalido", () => {
  const bad = { ...VALID_RESPONSE_PASS, verdict: "BLOCKED_HUMAN", human_action: { reason: "I_FELT_LIKE_IT", description: "x" } };
  const result = validateReviewResponse(bad);
  assert.equal(result.valid, false);
});

test("L - isProtectedPath: coincide exactamente con el workflow del propio loop", () => {
  assert.equal(isProtectedPath(".github/workflows/moni-autonomous-review.yml"), true);
});

test("M - isProtectedPath: coincide con patron wildcard *autonomous*", () => {
  assert.equal(isProtectedPath(".github/workflows/some-other-autonomous-thing.yml"), true);
});

test("N - isProtectedPath: coincide con scripts/autonomous/* para cualquier archivo dentro", () => {
  assert.equal(isProtectedPath("scripts/autonomous/createReviewPacket.mjs"), true);
  assert.equal(isProtectedPath("scripts/autonomous/nested/whatever.mjs"), true);
});

test("O - isProtectedPath: un archivo normal del repo NUNCA se marca protegido", () => {
  assert.equal(isProtectedPath("lib/priceCache.js"), false);
  assert.equal(isProtectedPath("autonomous/README.md"), false);
});

test("P - isProtectedPath: autonomous/*.schema.json protegido, autonomous/TASK_SPEC.example.json NO (no termina en .schema.json)", () => {
  assert.equal(isProtectedPath("autonomous/REVIEW_PACKET.schema.json"), true);
  assert.equal(isProtectedPath("autonomous/TASK_SPEC.example.json"), false);
});

test("Q - classifyFileChanges: archivo protegido -> AUTONOMOUS_INFRA_CHANGE, requiere aprobacion humana", () => {
  const result = classifyFileChanges(["lib/autonomousReviewContracts.js"], VALID_TASK_SPEC);
  assert.equal(result[0].classification, "AUTONOMOUS_INFRA_CHANGE");
  assert.equal(result[0].requires_human_approval, true);
});

test("R - classifyFileChanges: archivo en forbidden_files del task -> FORBIDDEN_BY_TASK_SCOPE", () => {
  const spec = { ...VALID_TASK_SPEC, scope: { allowed_files: [], forbidden_files: ["src/App.jsx"] } };
  const result = classifyFileChanges(["src/App.jsx"], spec);
  assert.equal(result[0].classification, "FORBIDDEN_BY_TASK_SCOPE");
});

test("S - classifyFileChanges: allowed_files no vacio y archivo fuera de la lista -> OUTSIDE_ALLOWED_SCOPE", () => {
  const result = classifyFileChanges(["src/App.jsx"], VALID_TASK_SPEC); // allowed_files solo tiene README.md
  assert.equal(result[0].classification, "OUTSIDE_ALLOWED_SCOPE");
});

test("T - classifyFileChanges: archivo dentro de allowed_files -> IN_SCOPE, no requiere aprobacion", () => {
  const result = classifyFileChanges(["autonomous/README.md"], VALID_TASK_SPEC);
  assert.equal(result[0].classification, "IN_SCOPE");
  assert.equal(result[0].requires_human_approval, false);
});

test("U - packetSupportsPass: todos los criterios PASS -> true", () => {
  assert.equal(packetSupportsPass(VALID_PACKET), true);
});

test("V - packetSupportsPass: un criterio UNVERIFIED -> false, NUNCA soporta PASS", () => {
  const bad = { ...VALID_PACKET, acceptance_criteria: [{ criterion: "x", status: "UNVERIFIED", evidence: [] }] };
  assert.equal(packetSupportsPass(bad), false);
});

test("W - packetSupportsPass: sin criterios de aceptacion -> false (nunca PASS vacio)", () => {
  assert.equal(packetSupportsPass({ ...VALID_PACKET, acceptance_criteria: [] }), false);
});

test("X - reviewerVerdictIsInternallyConsistent: PASS del reviewer + packet que si soporta PASS -> consistente", () => {
  const result = reviewerVerdictIsInternallyConsistent(VALID_RESPONSE_PASS, VALID_PACKET);
  assert.equal(result.consistent, true);
});

test("Y - reviewerVerdictIsInternallyConsistent: PASS del reviewer pero packet con un criterio FAIL -> INCONSISTENTE, nunca se confia ciegamente en el reviewer", () => {
  const badPacket = { ...VALID_PACKET, acceptance_criteria: [{ criterion: "x", status: "FAIL", evidence: ["real failure"] }] };
  const result = reviewerVerdictIsInternallyConsistent(VALID_RESPONSE_PASS, badPacket);
  assert.equal(result.consistent, false);
  assert.ok(result.reason.includes("PASS"));
});

test("Z - shouldStopIteration: PASS siempre detiene", () => {
  assert.deepEqual(shouldStopIteration({ iteration: 1, verdict: "PASS" }), { stop: true, reason: "PASS" });
});

test("AA - shouldStopIteration: BLOCKED_HUMAN siempre detiene, sin importar el numero de iteracion", () => {
  assert.deepEqual(shouldStopIteration({ iteration: 1, verdict: "BLOCKED_HUMAN" }), { stop: true, reason: "BLOCKED_HUMAN" });
});

test("BB - shouldStopIteration: HOLD antes del limite -> continua", () => {
  assert.deepEqual(shouldStopIteration({ iteration: 3, maxIterations: 5, verdict: "HOLD" }), { stop: false, reason: null });
});

test("CC - shouldStopIteration: HOLD exactamente en MAX_ITERATIONS -> MAX_AUTONOMOUS_ITERATIONS_REACHED", () => {
  assert.deepEqual(shouldStopIteration({ iteration: 5, maxIterations: 5, verdict: "HOLD" }), { stop: true, reason: "MAX_AUTONOMOUS_ITERATIONS_REACHED" });
});

test("DD - shouldStopIteration: usa DEFAULT_MAX_ITERATIONS=5 si no se pasa maxIterations", () => {
  assert.equal(DEFAULT_MAX_ITERATIONS, 5);
  assert.deepEqual(shouldStopIteration({ iteration: 5, verdict: "HOLD" }), { stop: true, reason: "MAX_AUTONOMOUS_ITERATIONS_REACHED" });
});

test("EE - deriveTaskBranchName: task_id normal -> autonomous/<id>", () => {
  assert.equal(deriveTaskBranchName("autonomous-loop-documentation-canary"), "autonomous/autonomous-loop-documentation-canary");
});

test("FF - deriveTaskBranchName: sanea mayusculas/espacios/caracteres invalidos para un nombre de rama", () => {
  assert.equal(deriveTaskBranchName("Fix Price Zones!! v2"), "autonomous/fix-price-zones-v2");
});

test("GG - deriveTaskBranchName: task_id vacio -> throw, nunca produce una rama invalida en silencio", () => {
  assert.throws(() => deriveTaskBranchName(""), /invalid_task_id/);
  assert.throws(() => deriveTaskBranchName("!!!"), /invalid_task_id/);
});

test("HH - reviewerModelFromEnv: MONI_REVIEWER_MODEL tiene prioridad sobre OPENAI_MODEL", () => {
  assert.equal(reviewerModelFromEnv({ MONI_REVIEWER_MODEL: "gpt-review-1", OPENAI_MODEL: "gpt-other" }), "gpt-review-1");
});

test("II - reviewerModelFromEnv: sin MONI_REVIEWER_MODEL, cae a OPENAI_MODEL", () => {
  assert.equal(reviewerModelFromEnv({ OPENAI_MODEL: "gpt-other" }), "gpt-other");
});

test("JJ - reviewerModelFromEnv: ninguno configurado -> null, NUNCA un modelo hardcodeado por default", () => {
  assert.equal(reviewerModelFromEnv({}), null);
});

test("KK - isForcePushArgs: detecta --force, -f, --force-with-lease y refspec +", () => {
  assert.equal(isForcePushArgs(["push", "origin", "--force"]), true);
  assert.equal(isForcePushArgs(["push", "origin", "-f"]), true);
  assert.equal(isForcePushArgs(["push", "origin", "--force-with-lease"]), true);
  assert.equal(isForcePushArgs(["push", "origin", "+main:main"]), true);
});

test("LL - isForcePushArgs: un push normal nunca se marca como force", () => {
  assert.equal(isForcePushArgs(["push", "-u", "origin", "autonomous/task-1"]), false);
});

test("MM - DEFAULT_PROTECTED_PATTERNS incluye exactamente los 6 patrones especificados", () => {
  assert.equal(DEFAULT_PROTECTED_PATTERNS.length, 6);
  assert.ok(DEFAULT_PROTECTED_PATTERNS.includes("lib/autonomousReviewContracts.js"));
});
