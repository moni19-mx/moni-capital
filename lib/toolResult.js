// lib/toolResult.js
// Contrato estructurado obligatorio para TODAS las herramientas de Moni AI.
// Ninguna tool devuelve texto narrativo -- siempre uno de estos 4 shapes.
// El modelo interpreta `status`, nunca adivina a partir de un string libre.
//
// v1.1.1: se agrega "partial" -- corrige un riesgo critico detectado en
// testing (get_portfolio_summary podia devolver un total incompleto como
// si fuera completo, cuando solo algunos tickers fallaban al consultar
// precio). Un agregado parcial NUNCA se disfraza de agregado completo.

export function ok(data, source) {
  return { status: "ok", data, asOf: new Date().toISOString(), source };
}

export function partial(data, completeness, source) {
  // completeness: { coveragePct, missingTickers }
  return { status: "partial", data, completeness, asOf: new Date().toISOString(), source };
}

export function notFound(source) {
  // El dato genuinamente no existe (ej. nunca definiste una tesis para ese ticker)
  return { status: "not_found", data: null, asOf: new Date().toISOString(), source };
}

export function toolError(errorCode, source) {
  // Fallo tecnico (timeout, API caida, error de base de datos) -- NUNCA se
  // disfraza de "no existe". Moni AI debe decir "no pude consultar" aqui,
  // no "no tengo ese dato".
  return { status: "error", data: null, asOf: new Date().toISOString(), source, errorCode };
}
