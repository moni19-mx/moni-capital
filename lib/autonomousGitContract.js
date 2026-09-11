// lib/autonomousGitContract.js
//
// PURA -- decide si el estado de git observado es seguro para correr
// una iteracion autonoma, o si se debe BLOCKED_HUMAN. NUNCA ejecuta
// comandos git por si misma (eso vive en scripts/autonomous/gitContract.mjs,
// que recolecta el estado real y le pasa el resultado a estas
// funciones). Nunca adivina, nunca rebasea, nunca resetea -- si el
// estado observado no coincide exactamente con lo esperado, la unica
// salida es GIT_STATE_CHANGED.

// state esperado (todo provisto por el llamador, nunca inferido aqui):
//   expectedBranch, expectedBaseSha, expectedPreviousSha (null en iteracion 1)
// state real:
//   currentBranch, currentSha, isCleanWorkingTree, unrelatedUncommittedFiles (string[])
export function checkGitState({ expectedBranch, expectedBaseSha, expectedPreviousSha, currentBranch, currentSha, isCleanWorkingTree, unrelatedUncommittedFiles }) {
  if (!isCleanWorkingTree) {
    if (Array.isArray(unrelatedUncommittedFiles) && unrelatedUncommittedFiles.length > 0) {
      return {
        ok: false,
        reason: "UNRELATED_UNCOMMITTED_CHANGES",
        detail: `working tree tiene cambios sin commitear no relacionados a este task: ${unrelatedUncommittedFiles.join(", ")}`,
      };
    }
    return { ok: false, reason: "DIRTY_WORKING_TREE", detail: "working tree no esta limpio" };
  }

  if (currentBranch !== expectedBranch) {
    return {
      ok: false,
      reason: "GIT_STATE_CHANGED",
      detail: `rama esperada "${expectedBranch}", rama real "${currentBranch}"`,
    };
  }

  // Iteracion 1: el SHA actual debe ser exactamente la base (nada se ha
  // commiteado todavia en esta rama de task). Iteraciones > 1: el SHA
  // actual debe ser exactamente el SHA de la iteracion previa -- si
  // difiere, alguien (humano u otro proceso) empujo algo inesperado.
  const expectedSha = expectedPreviousSha || expectedBaseSha;
  if (currentSha !== expectedSha) {
    return {
      ok: false,
      reason: "GIT_STATE_CHANGED",
      detail: `SHA esperado "${expectedSha}", SHA real "${currentSha}" -- posible push humano inesperado durante la iteracion`,
    };
  }

  return { ok: true, reason: null, detail: null };
}

// Construye la traza de trazabilidad obligatoria para un task autonomo
// -- base SHA, rama, SHAs de cada iteracion, head SHA final. Funcion
// pura de acumulacion -- el llamador es responsable de invocarla una
// vez por iteracion con el SHA real recien commiteado.
export function appendIterationRecord(trace, { iteration, headSha, verdict }) {
  const iterations = [...(trace.iterations || []), { iteration, head_sha: headSha, verdict }];
  return { ...trace, iterations, final_head_sha: headSha };
}

export function buildInitialTrace({ taskId, branch, baseSha }) {
  return { task_id: taskId, branch, base_sha: baseSha, iterations: [], final_head_sha: null };
}
