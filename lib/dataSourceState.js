// lib/dataSourceState.js
// Sprint P0.1 (Reliable Data Loading). Clasificacion PURA del estado de
// una fuente de datos que src/App.jsx lee directo (una tabla de
// Supabase, o un endpoint como /api/futures-equity). Nunca hace fetch,
// nunca toca React, nunca decide un valor financiero -- solo decide,
// dado el resultado de un intento (misma forma que Promise.allSettled)
// y el estado anterior, cual debe ser el nuevo status.
//
// Principio (Sprint P0.1): LAST KNOWN GOOD DATA > EMPTY DATA CAUSED BY
// NETWORK FAILURE. La preservacion del ultimo dato valido la hace el
// llamador con un simple `if (result.status === "fulfilled") setX(...)`
// -- no llamar al setter en el caso "rejected" YA preserva el valor
// anterior, no hace falta logica adicional para eso. Este modulo solo
// resuelve el STATUS (para poder mostrar frescura), nunca el dato.

export const SOURCE_STATUS = {
  NEVER_LOADED: "NEVER_LOADED",
  OK: "OK",
  STALE: "STALE",
  ERROR: "ERROR",
};

export function initialSourceMeta() {
  return { status: SOURCE_STATUS.NEVER_LOADED, lastSuccessfulAt: null, lastAttemptAt: null, error: null };
}

// previous: { status, lastSuccessfulAt, lastAttemptAt, error } (o undefined/null -> se trata como initialSourceMeta())
// result: { status: "fulfilled", value } | { status: "rejected", reason }
//   (la forma exacta que devuelve Promise.allSettled -- ningun contrato nuevo que aprender)
// now: string ISO -- inyectado por el llamador, nunca Date.now() interno,
//   para que esta funcion sea 100% determinista y testeable sin mockear el reloj.
export function resolveSourceMeta(previous, result, now) {
  const prev = previous || initialSourceMeta();
  if (result.status === "fulfilled") {
    return { status: SOURCE_STATUS.OK, lastSuccessfulAt: now, lastAttemptAt: now, error: null };
  }
  // Fallo. Si ya habia un exito previo (OK o STALE), el nuevo estado es
  // STALE -- hay datos validos en pantalla, solo desactualizados, NUNCA
  // se tratan como si no existieran. Si nunca hubo un exito, es ERROR
  // -- nunca se disfraza de "datos reales pero viejos" cuando en
  // realidad nunca hubo datos.
  const hadPreviousSuccess = prev.status === SOURCE_STATUS.OK || prev.status === SOURCE_STATUS.STALE;
  return {
    status: hadPreviousSuccess ? SOURCE_STATUS.STALE : SOURCE_STATUS.ERROR,
    lastSuccessfulAt: prev.lastSuccessfulAt,
    lastAttemptAt: now,
    error: result.reason ? String(result.reason.message || result.reason) : "unknown_error",
  };
}

// Aplica resolveSourceMeta a un mapa completo { name: PromiseSettledResult }
// de una sola pasada de loadAll(), devolviendo el mapa de meta actualizado.
export function resolveAllSourceMeta(previousMetaMap, resultsMap, now) {
  const next = {};
  for (const name of Object.keys(resultsMap)) {
    next[name] = resolveSourceMeta(previousMetaMap ? previousMetaMap[name] : null, resultsMap[name], now);
  }
  return next;
}

// true UNICAMENTE cuando esta fuente nunca ha tenido datos validos Y el
// intento actual tambien fallo -- el unico caso en el que es correcto
// mostrar un error explicito en vez de conservar datos anteriores en
// silencio (porque, en este caso, no existen datos anteriores que
// conservar).
export function isCriticalInitialFailure(meta) {
  return !!meta && meta.status === SOURCE_STATUS.ERROR && meta.lastSuccessfulAt == null;
}

// ==================================================
// Proteccion de concurrencia (race condition guard)
// ==================================================
// Mecanismo elegido: un contador monotonico simple (request generation
// id), no AbortController -- loadAll() dispara ~15 requests en paralelo
// via Promise.allSettled/Promise.all, y lo unico que importa es "que
// respuesta gano la carrera de terminar ultimo mientras sigue siendo la
// mas reciente que se inicio", no cancelar las requests HTTP en si
// mismas a medio vuelo. Un solo entero comparado antes de cada commit de
// estado es mas simple de razonar y de probar que N AbortControllers.
//
// Regla dura: la request MAS RECIENTE EN INICIAR siempre gana. Si una
// request mas nueva ya empezo antes de que esta termine, esta se
// descarta ENTERA (nunca se mezclan resultados de dos ciclos de
// loadAll() distintos) -- eso es lo que evita que una respuesta vieja
// sobrescriba estado mas nuevo.
export function isCurrentRequest(requestId, latestStartedRequestId) {
  return requestId === latestStartedRequestId;
}
