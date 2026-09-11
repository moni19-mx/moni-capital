// lib/fmpHistoricalNormalizer.js
//
// PURE, sin red. Normaliza la respuesta cruda de FMP
// `/historical-price-eod/full` hacia un array de records real --
// independiente de la forma exacta del JSON (bug real encontrado en la
// revision de Historical Multiple Data: el temp historical_probe asumia
// SIEMPRE `{ historical: [...] }`, pero la respuesta real de FMP para
// NVDA/AMZN es un ARRAY de nivel superior directamente -- eso hacia que
// `data?.historical` fuera `undefined`, y el probe clasificaba
// erroneamente NO_DATA para un ticker con ~1255 registros reales).
//
// NUNCA adivina una forma no reconocida en silencio -- si ninguna de
// las formas conocidas aplica, devuelve records:[] con shape:
// "unsupported", para que el llamador lo reporte explicitamente en vez
// de confundirlo con un NO_DATA real (array vacio genuino).
export function normalizeFmpHistoricalResponse(body) {
  if (Array.isArray(body)) {
    return { shape: "array", records: body };
  }
  if (body && typeof body === "object" && Array.isArray(body.historical)) {
    return { shape: "object.historical", records: body.historical };
  }
  if (body && typeof body === "object" && Array.isArray(body.data)) {
    return { shape: "object.data", records: body.data };
  }
  return { shape: "unsupported", records: [] };
}
