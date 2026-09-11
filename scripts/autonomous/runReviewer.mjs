#!/usr/bin/env node
// scripts/autonomous/runReviewer.mjs
//
// Moni Autonomous Dev Loop, Fase B. Modo --smoke: prueba de
// conectividad + contrato, NO el loop autonomo real (eso es Fase D).
// Llama a lib/providers/reviewerOpenAI.js (aislado, ver ese archivo),
// SIEMPRE valida localmente contra autonomous/REVIEW_RESPONSE.schema.json
// sin importar si el proveedor aplico su propio structured output, y
// SIEMPRE corre ambos checks de consistencia de Fase A/B antes de
// aceptar cualquier veredicto. Fail closed en cada paso -- nunca
// convierte un fallo en PASS.
//
// Uso (smoke):
//   OPENAI_API_KEY=... node scripts/autonomous/runReviewer.mjs --smoke --model <modelo> [--out-dir <dir>]

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { callReviewerOpenAI } from "../../lib/providers/reviewerOpenAI.js";
import {
  validateReviewResponse, reviewerVerdictIsInternallyConsistent, reviewerResponseIsSelfConsistent,
} from "../../lib/autonomousReviewContracts.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, "..", "..");

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

// El packet de humo es FIJO y deliberadamente minimo -- nunca el repo,
// nunca datos financieros reales. Un solo criterio de aceptacion, ya
// satisfecho por construccion, para que la respuesta esperada del
// reviewer sea determinista y cualquier falla sea diagnosticable.
const SMOKE_PACKET = {
  smoke_test: true,
  instruction: "This is a deterministic connectivity + contract smoke test of the Moni Autonomous Dev Loop's OpenAI reviewer. It is not a real code review -- no repository content or financial data is included.",
  acceptance_criteria: [
    {
      criterion: "smoke_criterion_one",
      status: "PASS",
      evidence: ["This is the only acceptance criterion in this smoke packet, and it is satisfied by construction."],
    },
  ],
};

function buildSmokeUserMessage() {
  return [
    "Evaluate the following smoke-test review packet against exactly one rule:",
    "there is exactly one acceptance criterion, and its status is already PASS with real evidence.",
    "",
    JSON.stringify(SMOKE_PACKET, null, 2),
    "",
    "Since the single acceptance criterion is satisfied, return verdict PASS with empty",
    "blocking_findings, empty required_changes, empty tests_to_add_or_rerun, human_action null,",
    "and empty next_iteration_scope. Return ONLY a single JSON object with exactly these keys:",
    "verdict, summary, blocking_findings, required_changes, tests_to_add_or_rerun, human_action, next_iteration_scope.",
  ].join("\n");
}

// Nunca confia en que el key simplemente "no aparecio" en el texto que
// el propio codigo construyo -- escanea el JSON.stringify real de cada
// artefacto por el valor literal del secret, si esta presente en el
// entorno. PASS solo si el secret jamas aparece.
function secretLeakCheck(apiKey, artifacts) {
  if (!apiKey) return "PASS"; // nada que filtrar si no hay key (no deberia llegar aqui, ver gate de presencia)
  const haystack = artifacts.map((a) => JSON.stringify(a)).join("\n");
  return haystack.includes(apiKey) ? "FAIL" : "PASS";
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const outDir = args["out-dir"] || ".";
  const apiKey = process.env.OPENAI_API_KEY;

  // Defensa en profundidad: el gate real de presencia vive en el
  // workflow (paso separado, igual que el patron ya probado para
  // FMP_API_KEY/FINNHUB_API_KEY) -- esto nunca asume que ese gate
  // corrio, nunca intenta la llamada sin key.
  if (!apiKey) {
    console.error("[runReviewer] OPENAI_API_KEY ausente -- STOP, no se intenta ninguna llamada.");
    writeFileSync(path.join(outDir, "openai-smoke-validation.json"), JSON.stringify({
      api_call: "FAIL", json_parse: "FAIL", schema_validation: "FAIL", consistency_validation: "FAIL",
      reviewer_model_used: args.model || null, verdict: null, secret_leak_check: "PASS",
      blocker: { reason: "OPENAI_GITHUB_SECRET_REQUIRED", description: "OPENAI_API_KEY is not present in this GitHub Actions environment." },
    }, null, 2));
    process.exit(1);
  }

  if (!args.model) {
    console.error("[runReviewer] --model es requerido (workflow input reviewer_model) -- nunca se hardcodea.");
    process.exit(1);
  }

  const systemPrompt = readFileSync(path.join(REPO_ROOT, "autonomous", "REVIEWER_SYSTEM_PROMPT.md"), "utf-8");
  const userMessage = buildSmokeUserMessage();

  const requestArtifact = {
    reviewer_prompt_version: "moni-reviewer-v1.0.0",
    reviewer_model_used: args.model,
    smoke_packet: SMOKE_PACKET,
    user_message: userMessage,
  };
  writeFileSync(path.join(outDir, "openai-smoke-request.json"), JSON.stringify(requestArtifact, null, 2));

  const validation = {
    api_call: "FAIL", json_parse: "FAIL", schema_validation: "FAIL", consistency_validation: "FAIL",
    reviewer_model_used: args.model, verdict: null, secret_leak_check: "PASS",
  };

  const result = await callReviewerOpenAI({ system: systemPrompt, userMessage, model: args.model });
  const responseArtifact = { http_status: result.httpStatus, ok: result.ok, error: result.error, content_text: result.contentText, usage: result.usage || null };
  writeFileSync(path.join(outDir, "openai-smoke-response.json"), JSON.stringify(responseArtifact, null, 2));

  if (!result.ok) {
    validation.secret_leak_check = secretLeakCheck(apiKey, [requestArtifact, responseArtifact, validation]);
    writeFileSync(path.join(outDir, "openai-smoke-validation.json"), JSON.stringify(validation, null, 2));
    console.error(`[runReviewer] api_call=FAIL: ${result.error}`);
    process.exit(1);
  }
  validation.api_call = "PASS";

  let parsed;
  try {
    parsed = JSON.parse(result.contentText || "");
    validation.json_parse = "PASS";
  } catch (e) {
    validation.secret_leak_check = secretLeakCheck(apiKey, [requestArtifact, responseArtifact, validation]);
    writeFileSync(path.join(outDir, "openai-smoke-validation.json"), JSON.stringify(validation, null, 2));
    console.error(`[runReviewer] json_parse=FAIL: ${e.message}`);
    process.exit(1);
  }

  const schemaResult = validateReviewResponse(parsed);
  validation.schema_validation = schemaResult.valid ? "PASS" : "FAIL";
  if (!schemaResult.valid) {
    validation.secret_leak_check = secretLeakCheck(apiKey, [requestArtifact, responseArtifact, validation]);
    writeFileSync(path.join(outDir, "openai-smoke-validation.json"), JSON.stringify({ ...validation, schema_errors: schemaResult.errors }, null, 2));
    console.error(`[runReviewer] schema_validation=FAIL: ${schemaResult.errors.join("; ")}`);
    process.exit(1);
  }

  // Packet sintetico minimo, solo para el check packet<->veredicto --
  // refleja exactamente el unico criterio real del smoke packet.
  const syntheticPacket = { acceptance_criteria: SMOKE_PACKET.acceptance_criteria.map((c) => ({ criterion: c.criterion, status: c.status, evidence: c.evidence })) };
  const packetConsistency = reviewerVerdictIsInternallyConsistent(parsed, syntheticPacket);
  const selfConsistency = reviewerResponseIsSelfConsistent(parsed);
  const consistencyOk = packetConsistency.consistent && selfConsistency.consistent;
  validation.consistency_validation = consistencyOk ? "PASS" : "FAIL";
  validation.verdict = parsed.verdict;

  validation.secret_leak_check = secretLeakCheck(apiKey, [requestArtifact, responseArtifact, validation, parsed]);

  writeFileSync(path.join(outDir, "openai-smoke-validation.json"), JSON.stringify({
    ...validation,
    packet_consistency_reason: packetConsistency.reason,
    self_consistency_reason: selfConsistency.reason,
  }, null, 2));

  console.log(`[runReviewer] api_call=${validation.api_call} json_parse=${validation.json_parse} schema_validation=${validation.schema_validation} consistency_validation=${validation.consistency_validation} verdict=${validation.verdict} secret_leak_check=${validation.secret_leak_check}`);

  const allPass = validation.api_call === "PASS" && validation.json_parse === "PASS" && validation.schema_validation === "PASS" && validation.consistency_validation === "PASS" && validation.secret_leak_check === "PASS";
  process.exit(allPass ? 0 : 1);
}

main();
