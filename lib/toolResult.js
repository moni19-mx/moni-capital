// lib/toolResult.js
// Contrato estructurado obligatorio para TODAS las herramientas de Moni AI.
// Ninguna tool devuelve texto narrativo -- siempre uno de estos 3 shapes.
// El modelo interpreta `status`, nunca adivina a partir de un string libre.

export function ok(data, source) {
  return { status: "ok", data, asOf: new Date().toISOString(), source };
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
