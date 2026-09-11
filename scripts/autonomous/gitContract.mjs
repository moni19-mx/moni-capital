#!/usr/bin/env node
// scripts/autonomous/gitContract.mjs
//
// Moni Autonomous Dev Loop V1, Fase A. Unico rol: leer el estado REAL
// de git y pasarselo a checkGitState() (lib/autonomousGitContract.js,
// pura). Nunca decide nada por si mismo -- nunca rebasea, resetea, ni
// fuerza nada. Exit 0 solo si el estado es exactamente el esperado;
// exit 1 con el reason explicito en cualquier otro caso (fail closed).
//
// Uso:
//   node scripts/autonomous/gitContract.mjs \
//     --expected-branch autonomous/some-task \
//     --expected-base-sha <sha> \
//     [--expected-previous-sha <sha>]
//
// Si se omiten los --expected-*, se usan los valores REALES actuales --
// modo autoprueba: siempre debe dar ok:true contra un repo limpio,
// sirve para demostrar que el script funciona sin necesitar un task
// autonomo en curso todavia.

import { execFileSync } from "node:child_process";
import { checkGitState } from "../../lib/autonomousGitContract.js";

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

function git(args) {
  return execFileSync("git", args, { encoding: "utf-8" }).trim();
}

// BUGFIX (encontrado en autoprueba real): `git status --porcelain` usa
// el/los primeros 2 caracteres de CADA linea como codigo de estado (ej.
// " M archivo.js") -- un espacio inicial es significativo, parte del
// codigo XY, no whitespace incidental. `.trim()` sobre la salida
// COMPLETA borra el espacio inicial SOLO de la primera linea, corrompiendo
// el primer archivo listado (ej. "package.json" -> "ackage.json"). Se usa
// output crudo, sin trim, y se filtran solo las lineas vacias del split.
function gitRaw(args) {
  return execFileSync("git", args, { encoding: "utf-8" });
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  const currentBranch = git(["rev-parse", "--abbrev-ref", "HEAD"]);
  const currentSha = git(["rev-parse", "HEAD"]);
  const statusPorcelain = gitRaw(["status", "--porcelain"]);
  const isCleanWorkingTree = statusPorcelain.trim().length === 0;
  const unrelatedUncommittedFiles = statusPorcelain
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => l.slice(3));

  const expectedBranch = args["expected-branch"] || currentBranch;
  const expectedBaseSha = args["expected-base-sha"] || currentSha;
  const expectedPreviousSha = args["expected-previous-sha"] || null;

  const result = checkGitState({
    expectedBranch,
    expectedBaseSha,
    expectedPreviousSha,
    currentBranch,
    currentSha,
    isCleanWorkingTree,
    unrelatedUncommittedFiles,
  });

  console.log(JSON.stringify({
    ...result,
    observed: { currentBranch, currentSha, isCleanWorkingTree, unrelatedUncommittedFiles },
    expected: { expectedBranch, expectedBaseSha, expectedPreviousSha },
  }, null, 2));

  process.exit(result.ok ? 0 : 1);
}

main();
