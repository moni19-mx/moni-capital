// tests/thesisDimensions.test.js
// Sprint P3.2. Migracion conservadora thesis -> thesis_dimensions.

import { test } from "node:test";
import assert from "node:assert/strict";
import { extractDimensionsFromThesis, DIMENSION_TYPE, DIMENSION_STATUS } from "../lib/thesisDimensions.js";

test("extrae 4 dimensiones reales (WHY_OWN, EDGE, RISK, SELL_TRIGGER) cuando los 4 campos existen, texto verbatim preservado", () => {
  const thesisRow = {
    asset_id: 29, ticker: "QCOM",
    why_bought: "Diversificacion fuera de smartphones hacia auto y IoT.",
    what_special: "Portafolio de patentes de modem lider en la industria.",
    sell_trigger: "Perdida sostenida de share en modems premium.",
    risks: "Dependencia historica de Apple y del ciclo de smartphones.",
  };
  const { dimensions, skipped_reason } = extractDimensionsFromThesis(thesisRow);
  assert.equal(skipped_reason, null);
  assert.equal(dimensions.length, 4);
  const byType = Object.fromEntries(dimensions.map((d) => [d.dimension_type, d]));
  assert.equal(byType[DIMENSION_TYPE.WHY_OWN].detail, thesisRow.why_bought);
  assert.equal(byType[DIMENSION_TYPE.EDGE].detail, thesisRow.what_special);
  assert.equal(byType[DIMENSION_TYPE.RISK].detail, thesisRow.risks);
  assert.equal(byType[DIMENSION_TYPE.SELL_TRIGGER].detail, thesisRow.sell_trigger);
  for (const d of dimensions) {
    assert.equal(d.status, DIMENSION_STATUS.ACTIVE);
    assert.equal(d.source, "MIGRATED_FROM_THESIS_TEXT");
    assert.equal(d.source_confidence, "CLEAR");
  }
});

test("CATALYST nunca se genera desde la migracion -- no existe campo origen en thesis, nunca se inventa", () => {
  const thesisRow = {
    asset_id: 29, ticker: "QCOM", why_bought: "x", what_special: "y", sell_trigger: "z", risks: "w",
  };
  const { dimensions } = extractDimensionsFromThesis(thesisRow);
  assert.ok(!dimensions.some((d) => d.dimension_type === DIMENSION_TYPE.CATALYST));
});

test("campo vacio/null -> esa dimension simplemente no se genera, nunca una fila vacia", () => {
  const thesisRow = { asset_id: 4, ticker: "AMD", why_bought: "Lidera en CPUs de servidor.", what_special: null, sell_trigger: "", risks: "  " };
  const { dimensions } = extractDimensionsFromThesis(thesisRow);
  assert.equal(dimensions.length, 1);
  assert.equal(dimensions[0].dimension_type, DIMENSION_TYPE.WHY_OWN);
});

test("sin asset_id/ticker -> no migra nada, declara la razon explicitamente", () => {
  const { dimensions, skipped_reason } = extractDimensionsFromThesis({ why_bought: "x" });
  assert.equal(dimensions.length, 0);
  assert.equal(skipped_reason, "missing_asset_id_or_ticker");
});

test("W - el texto original nunca se trunca ni se reescribe -- se preserva byte a byte (trim solo de espacios en los extremos)", () => {
  const longText = "Frase uno con matices. Frase dos con mas contexto real, sin resumir. Frase tres.";
  const { dimensions } = extractDimensionsFromThesis({ asset_id: 1, ticker: "TEST", why_bought: `  ${longText}  ` });
  assert.equal(dimensions[0].detail, longText);
});
