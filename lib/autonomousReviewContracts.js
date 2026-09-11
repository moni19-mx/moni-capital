// lib/autonomousReviewContracts.js
//
// PURA, sin red, sin fs para las funciones de decision -- solo la carga
// de los tres schemas usa fs, una sola vez al importar el modulo. Reglas
// deterministas del Moni Autonomous Dev Loop V1 (Fase A): validacion de
// contrato contra los JSON Schemas de autonomous/, el guard de
// auto-modificacion de infraestructura, la consistencia interna
// veredicto<->packet, y la logica de corte de iteraciones. CERO llamada
// a OpenAI/Claude -- eso vive en fases posteriores (B/C/D), nunca aqui.
//
// Reutiliza lib/jsonSchemaLite.js (ya existente, cero dependencias
// nuevas) para las tres validaciones de schema -- misma maquinaria que
// ya usa Smart Import para su structured output.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { validateJsonSchema } from "./jsonSchemaLite.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AUTONOMOUS_DIR = path.join(__dirname, "..", "autonomous");

function loadSchema(fileName) {
  const raw = readFileSync(path.join(AUTONOMOUS_DIR, fileName), "utf-8");
  return JSON.parse(raw);
}

export const TASK_SPEC_SCHEMA = loadSchema("TASK_SPEC.schema.json");
export const REVIEW_PACKET_SCHEMA = loadSchema("REVIEW_PACKET.schema.json");
export const REVIEW_RESPONSE_SCHEMA = loadSchema("REVIEW_RESPONSE.schema.json");

export function validateTaskSpec(taskSpec) {
  return validateJsonSchema(taskSpec, TASK_SPEC_SCHEMA);
}

export function validateReviewPacket(packet) {
  return validateJsonSchema(packet, REVIEW_PACKET_SCHEMA);
}

export function validateReviewResponse(response) {
  return validateJsonSchema(response, REVIEW_RESPONSE_SCHEMA);
}

// ================== Self-modification guard ==================
// Un task NORMAL nunca puede tocar la infraestructura que lo controla o
// lo juzga. Si un archivo modificado hace match con cualquiera de estos
// patrones, el cambio se clasifica AUTONOMOUS_INFRA_CHANGE y exige
// aprobacion humana explicita -- el implementador nunca puede debilitar
// su propio reviewer, schemas, limite de iteraciones o gates de
// seguridad durante un task normal.
export const DEFAULT_PROTECTED_PATTERNS = [
  ".github/workflows/moni-autonomous-review.yml",
  ".github/workflows/*autonomous*",
  "autonomous/REVIEWER_SYSTEM_PROMPT.md",
  "autonomous/*.schema.json",
  "scripts/autonomous/*",
  "lib/autonomousReviewContracts.js",
];

// Traduccion MINIMA de glob a regex -- solo soporta `*` (cualquier
// secuencia de caracteres, incluyendo `/`), suficiente para los
// patrones declarados arriba. Nunca se interpreta como regex arbitraria
// del llamador -- el patron siempre viene de DEFAULT_PROTECTED_PATTERNS
// o de una lista igualmente confiable pasada explicitamente.
function globToRegExp(pattern) {
  const escaped = pattern
    .split("*")
    .map((segment) => segment.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${escaped}$`);
}

export function isProtectedPath(filePath, patterns = DEFAULT_PROTECTED_PATTERNS) {
  return patterns.some((pattern) => globToRegExp(pattern).test(filePath));
}

export function classifyFileChanges(filesChanged, taskSpec) {
  const allowed = new Set(taskSpec?.scope?.allowed_files || []);
  const forbidden = new Set(taskSpec?.scope?.forbidden_files || []);
  return filesChanged.map((file) => {
    if (isProtectedPath(file)) {
      return { file, classification: "AUTONOMOUS_INFRA_CHANGE", requires_human_approval: true };
    }
    if (forbidden.has(file)) {
      return { file, classification: "FORBIDDEN_BY_TASK_SCOPE", requires_human_approval: true };
    }
    if (allowed.size > 0 && !allowed.has(file)) {
      return { file, classification: "OUTSIDE_ALLOWED_SCOPE", requires_human_approval: true };
    }
    return { file, classification: "IN_SCOPE", requires_human_approval: false };
  });
}

// ================== Veredicto <-> packet, consistencia ==================
// El reviewer NUNCA se confia ciegamente -- exactamente el mismo
// principio "no confiar en afirmaciones sin evidencia" que ya rige a
// Claude en este proyecto se le aplica tambien al reviewer. Un PASS solo
// es valido si CADA criterio de aceptacion del packet esta en PASS --
// nunca FAIL/UNVERIFIED/MISSING_EVIDENCE.
export function packetSupportsPass(packet) {
  if (!Array.isArray(packet?.acceptance_criteria) || packet.acceptance_criteria.length === 0) {
    return false;
  }
  return packet.acceptance_criteria.every((c) => c.status === "PASS");
}

export function reviewerVerdictIsInternallyConsistent(response, packet) {
  if (response.verdict === "PASS" && !packetSupportsPass(packet)) {
    return {
      consistent: false,
      reason: "reviewer_returned_PASS_but_packet_has_a_non_PASS_acceptance_criterion",
    };
  }
  return { consistent: true, reason: null };
}

// ================== Corte de iteraciones ==================
export const DEFAULT_MAX_ITERATIONS = 5;

export function shouldStopIteration({ iteration, maxIterations = DEFAULT_MAX_ITERATIONS, verdict }) {
  if (verdict === "PASS") return { stop: true, reason: "PASS" };
  if (verdict === "BLOCKED_HUMAN") return { stop: true, reason: "BLOCKED_HUMAN" };
  if (verdict === "HOLD" && iteration >= maxIterations) {
    return { stop: true, reason: "MAX_AUTONOMOUS_ITERATIONS_REACHED" };
  }
  return { stop: false, reason: null };
}

// ================== Nombre de rama por task ==================
// autonomous/<task_id>, saneado a caracteres seguros para un nombre de
// rama de git -- nunca se usa el task_id crudo sin sanear.
export function deriveTaskBranchName(taskId) {
  const safe = String(taskId || "").trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!safe) throw new Error("invalid_task_id: no produce un nombre de rama valido");
  return `autonomous/${safe}`;
}

// ================== Modelo del reviewer, desde env (inyectado) ==================
// Nunca hardcodea un modelo -- MONI_REVIEWER_MODEL tiene prioridad,
// OPENAI_MODEL como fallback (mismo patron que ya usa
// lib/providers/openai.js), null si ninguno esta configurado (el
// llamador decide que hacer, nunca se asume un default silencioso aqui).
export function reviewerModelFromEnv(env = process.env) {
  return env.MONI_REVIEWER_MODEL || env.OPENAI_MODEL || null;
}

// ================== Guard: nunca force-push ==================
export function isForcePushArgs(gitArgs) {
  return (gitArgs || []).some((a) => a === "--force" || a === "-f" || a === "--force-with-lease" || /^\+/.test(a));
}
