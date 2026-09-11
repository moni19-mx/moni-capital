#!/usr/bin/env node
// scripts/autonomous/createReviewPacket.mjs
//
// Moni Autonomous Dev Loop V1, Fase A. Unico archivo IMPURO de esta
// fase -- ejecuta git/npm reales y le pasa el resultado a las funciones
// PURAS de lib/autonomousReviewContracts.js y
// lib/autonomousTestOutputParser.js para construir un REVIEW_PACKET.json
// schema-valido. NUNCA llama a OpenAI ni a Claude -- eso vive en fases
// posteriores. Si algo falla o el packet no valida contra el schema,
// termina con exit 1 -- nunca escribe un packet invalido en disco.
//
// Uso:
//   node scripts/autonomous/createReviewPacket.mjs \
//     --task-spec autonomous/TASK_SPEC.first-test-task.json \
//     --iteration 1 \
//     [--base <sha>] [--head <sha>] \
//     [--out review-packet.json]
//
// Si --base/--head se omiten, ambos usan el HEAD actual -- modo
// autoprueba: diff vacio, sirve para demostrar que el script produce un
// packet schema-valido contra el estado real del repo sin necesitar un
// task en curso.

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { validateTaskSpec, validateReviewPacket } from "../../lib/autonomousReviewContracts.js";
import { parseNodeTestOutput } from "../../lib/autonomousTestOutputParser.js";

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) {
      const key = argv[i].slice(2);
      const value = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : true;
      args[key] = value;
    }
  }
  return args;
}

function sh(cmd, args, options = {}) {
  try {
    const stdout = execFileSync(cmd, args, { encoding: "utf-8", ...options });
    return { exitCode: 0, stdout, stderr: "" };
  } catch (e) {
    return { exitCode: e.status ?? 1, stdout: e.stdout || "", stderr: e.stderr || String(e.message || e) };
  }
}

function currentHeadSha() {
  return sh("git", ["rev-parse", "HEAD"]).stdout.trim();
}

function getDiffFilesAndSummary(base, head) {
  if (base === head) {
    return { files_changed: [], diff_summary: [] };
  }
  const numstat = sh("git", ["diff", "--numstat", `${base}..${head}`]).stdout;
  const files_changed = [];
  const diff_summary = [];
  for (const line of numstat.split("\n").filter(Boolean)) {
    const [add, del, file] = line.split("\t");
    files_changed.push(file);
    diff_summary.push({
      file,
      additions: add === "-" ? 0 : Number(add),
      deletions: del === "-" ? 0 : Number(del),
    });
  }
  return { files_changed, diff_summary };
}

function runTests(commands) {
  const cmds = commands && commands.length > 0 ? commands : ["npm test"];
  const evidence = [];
  let lastResult = { pass: null, fail: null };
  for (const cmd of cmds) {
    const [bin, ...rest] = cmd.split(" ");
    const result = sh(bin, rest);
    const parsed = parseNodeTestOutput(result.stdout);
    evidence.push(`$ ${cmd}\nexit_code=${result.exitCode}\n${extractSummaryLines(result.stdout)}`);
    if (parsed.parsed_successfully) lastResult = parsed;
  }
  return {
    commands: cmds,
    passed: lastResult.pass,
    failed: lastResult.fail,
    evidence,
  };
}

const SUMMARY_LINE_PATTERN = /^# (tests|pass|fail|cancelled|skipped|todo|duration_ms) /;

// Solo las lineas de resumen finales de `node --test` (# tests N, # pass
// N, etc.) -- NUNCA cada linea de subtest individual (# Subtest: ...),
// que puede llegar a cientos de lineas e infla el packet sin agregar
// evidencia real que el reviewer necesite.
function extractSummaryLines(output) {
  return String(output || "")
    .split("\n")
    .filter((l) => SUMMARY_LINE_PATTERN.test(l))
    .join("\n");
}

function runBuild() {
  const result = sh("npm", ["run", "build"]);
  return {
    command: "npm run build",
    status: result.exitCode === 0 ? "PASS" : "FAIL",
    evidence: [`exit_code=${result.exitCode}`, ...(result.stdout || "").split("\n").filter(Boolean).slice(-10)],
  };
}

function buildAcceptanceCriteria(taskSpec, testsResult, buildResult) {
  return (taskSpec.acceptance_criteria || []).map((c) => {
    if (c.id === "tests_pass") {
      if (testsResult.passed === null) return { criterion: c.id, status: "MISSING_EVIDENCE", evidence: ["test output could not be parsed"] };
      return {
        criterion: c.id,
        status: testsResult.failed === 0 ? "PASS" : "FAIL",
        evidence: [`passed=${testsResult.passed} failed=${testsResult.failed}`],
      };
    }
    if (c.id === "build_succeeds") {
      return { criterion: c.id, status: buildResult.status, evidence: buildResult.evidence.slice(0, 1) };
    }
    // Nunca se adivina un criterio no auto-checkable -- honesto:
    // UNVERIFIED con evidencia vacia hasta que algo (el reviewer, o una
    // fase posterior) lo evalue con evidencia real.
    return { criterion: c.id, status: "UNVERIFIED", evidence: [] };
  });
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args["task-spec"]) {
    console.error("[createReviewPacket] missing --task-spec <path>");
    process.exit(1);
  }

  const taskSpec = JSON.parse(readFileSync(args["task-spec"], "utf-8"));
  const specValidation = validateTaskSpec(taskSpec);
  if (!specValidation.valid) {
    console.error("[createReviewPacket] TASK_SPEC invalido, abortando (fail closed):");
    specValidation.errors.forEach((e) => console.error(`  - ${e}`));
    process.exit(1);
  }

  const head = args.head || currentHeadSha();
  const base = args.base || head;
  const iteration = Number(args.iteration || 1);

  const { files_changed, diff_summary } = getDiffFilesAndSummary(base, head);
  const testsResult = runTests(taskSpec.required_tests);
  const buildResult = runBuild();
  const acceptance_criteria = buildAcceptanceCriteria(taskSpec, testsResult, buildResult);

  const packet = {
    task_id: taskSpec.task_id,
    iteration,
    base_commit: base,
    head_commit: head,
    files_changed,
    diff_summary,
    tests: testsResult,
    build: buildResult,
    live_evidence: [],
    schema_changes: files_changed.filter((f) => f.endsWith(".sql")),
    data_writes: [],
    security_changes: files_changed.filter((f) => f.includes("docs/security/")),
    financial_logic_changes: [],
    known_limitations: [],
    open_questions: [],
    acceptance_criteria,
  };

  const packetValidation = validateReviewPacket(packet);
  if (!packetValidation.valid) {
    console.error("[createReviewPacket] REVIEW_PACKET generado NO es schema-valido, abortando (fail closed):");
    packetValidation.errors.forEach((e) => console.error(`  - ${e}`));
    process.exit(1);
  }

  const outPath = args.out || "review-packet.json";
  writeFileSync(outPath, JSON.stringify(packet, null, 2));
  console.log(`[createReviewPacket] wrote ${outPath}`);
  console.log(`[createReviewPacket] task_id=${packet.task_id} iteration=${iteration} files_changed=${files_changed.length} tests_passed=${testsResult.passed} tests_failed=${testsResult.failed} build=${buildResult.status}`);
}

main();
