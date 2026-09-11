// lib/thesisDimensions.js
// Sprint P3.2 (Thesis / Conviction Engine 2.0). Migracion CONSERVADORA
// de thesis (texto libre) a thesis_dimensions (filas explicitas) --
// CERO LLM, CERO reescritura. Cada campo de thesis mapea 1:1 a UN tipo
// de dimension, preservando el texto ORIGINAL verbatim. No se parte un
// parrafo en multiples afirmaciones atomicas (eso requeriria NLP/LLM,
// explicitamente fuera de alcance: "No reescribir automaticamente la
// thesis completa con AI"). CATALYST nunca se migra desde aqui -- no
// existe un campo `catalyst` en thesis; se declara ausente, nunca se
// inventa contenido para completarlo.

export const DIMENSION_TYPE = Object.freeze({
  WHY_OWN: "WHY_OWN", EDGE: "EDGE", CATALYST: "CATALYST", RISK: "RISK", SELL_TRIGGER: "SELL_TRIGGER",
});

export const DIMENSION_STATUS = Object.freeze({
  ACTIVE: "ACTIVE", CONFIRMED: "CONFIRMED", WEAKENED: "WEAKENED", INVALIDATED: "INVALIDATED", RETIRED: "RETIRED",
});

// Mapeo 1:1 explicito -- campo real de `thesis` -> dimension_type real.
// No incluye CATALYST a proposito (sin campo origen).
const FIELD_TO_DIMENSION = Object.freeze([
  { field: "why_bought", dimensionType: DIMENSION_TYPE.WHY_OWN, labelPrefix: "Por qué se compró" },
  { field: "what_special", dimensionType: DIMENSION_TYPE.EDGE, labelPrefix: "Qué la hace especial" },
  { field: "risks", dimensionType: DIMENSION_TYPE.RISK, labelPrefix: "Riesgos identificados" },
  { field: "sell_trigger", dimensionType: DIMENSION_TYPE.SELL_TRIGGER, labelPrefix: "Gatillo de venta" },
]);

function isMeaningfulText(v) {
  return typeof v === "string" && v.trim().length > 0;
}

// thesisRow: fila real de la tabla `thesis` ({asset_id, ticker,
//   why_bought, what_special, sell_trigger, risks, ...}).
// Devuelve el array de dimensiones a INSERTAR -- nunca muta thesis,
// nunca decide por si sola escribir en la base (eso lo hace el
// llamador). Campo vacio/null -> esa dimension simplemente no se
// genera (nunca una fila vacia "por completar").
export function extractDimensionsFromThesis(thesisRow) {
  if (!thesisRow || !thesisRow.asset_id || !thesisRow.ticker) {
    return { dimensions: [], skipped_reason: "missing_asset_id_or_ticker" };
  }
  const dimensions = [];
  for (const { field, dimensionType, labelPrefix } of FIELD_TO_DIMENSION) {
    const text = thesisRow[field];
    if (!isMeaningfulText(text)) continue;
    dimensions.push({
      asset_id: thesisRow.asset_id,
      ticker: thesisRow.ticker,
      dimension_type: dimensionType,
      label: `${labelPrefix}: ${thesisRow.ticker}`,
      detail: text.trim(), // texto ORIGINAL verbatim, nunca reescrito
      status: DIMENSION_STATUS.ACTIVE,
      source: "MIGRATED_FROM_THESIS_TEXT",
      // CLEAR: el mapeo campo->tipo de dimension es inequivoco (1:1,
      // sin ambiguedad de a cual dimension pertenece). No es un
      // juicio sobre la CALIDAD del contenido -- solo sobre la
      // certeza de la clasificacion estructural.
      source_confidence: "CLEAR",
    });
  }
  return { dimensions, skipped_reason: null };
}
