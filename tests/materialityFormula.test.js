import { test } from "node:test";
import assert from "node:assert/strict";
import {
  validateAiAdjustment, computeFinalMateriality, deriveMaterialityLevel,
  AI_ADJUSTMENT_MIN, AI_ADJUSTMENT_MAX, validateScoreOrdering,
} from "../lib/materialityFormula.js";

// E. AI neutral -> deterministic intacto
test("E - ai_adjustment=0 deja el score deterministico exactamente intacto", () => {
  assert.equal(computeFinalMateriality(20, 0), 20);
  assert.equal(computeFinalMateriality(50, 0), 50);
  assert.equal(computeFinalMateriality(95, 0), 95); // el bug del blend 70/30 habria dado 66.5 aqui
});

// F. AI +15
test("F - ai_adjustment=+15 se suma exacto (sin clamp)", () => {
  assert.equal(computeFinalMateriality(20, 15), 35);
  assert.equal(computeFinalMateriality(50, 15), 65);
});

// G. AI -15
test("G - ai_adjustment=-15 se resta exacto (sin clamp)", () => {
  assert.equal(computeFinalMateriality(50, -15), 35);
  assert.equal(computeFinalMateriality(80, -15), 65);
});

// H. clamp 100
test("H - clamp superior: 95+15 nunca pasa de 100", () => {
  assert.equal(computeFinalMateriality(95, 15), 100);
});

// I. clamp 0
test("I - clamp inferior: nunca baja de 0", () => {
  assert.equal(computeFinalMateriality(5, -15), 0);
});

test("ejemplos exactos pedidos en el GO del sprint", () => {
  assert.equal(computeFinalMateriality(20, 0), 20);
  assert.equal(computeFinalMateriality(20, 15), 35);
  assert.equal(computeFinalMateriality(50, -15), 35);
  assert.equal(computeFinalMateriality(80, 15), 95);
  assert.equal(computeFinalMateriality(95, 15), 100);
  assert.equal(computeFinalMateriality(95, 0), 95);
});

// J. ai_adjustment fuera de rango -> reject
test("J - adjustment fuera de rango [-15,15] se rechaza", () => {
  assert.equal(validateAiAdjustment(16, "algo").valid, false);
  assert.equal(validateAiAdjustment(-16, "algo").valid, false);
  assert.equal(validateAiAdjustment(100, "algo").valid, false);
  assert.equal(validateAiAdjustment(AI_ADJUSTMENT_MAX, "algo").valid, true); // limite exacto SI valido
  assert.equal(validateAiAdjustment(AI_ADJUSTMENT_MIN, "algo").valid, true);
});

// K. adjustment != 0 sin reason -> reject
test("K - adjustment distinto de cero sin reason se rechaza", () => {
  assert.equal(validateAiAdjustment(5, null).valid, false);
  assert.equal(validateAiAdjustment(5, "").valid, false);
  assert.equal(validateAiAdjustment(5, "   ").valid, false);
  assert.equal(validateAiAdjustment(5, "razon real").valid, true);
});

test("adjustment=0 nunca requiere reason", () => {
  assert.equal(validateAiAdjustment(0, null).valid, true);
});

test("adjustment no numerico se rechaza", () => {
  assert.equal(validateAiAdjustment("5", "x").valid, false);
  assert.equal(validateAiAdjustment(NaN, "x").valid, false);
  assert.equal(validateAiAdjustment(undefined, "x").valid, false);
});

// R. historical ordering usa processed_at
test("R - scored_at posterior a processed_at (orden causal normal) es valido", () => {
  const r = validateScoreOrdering("2026-09-09T04:00:00Z", "2026-09-09T04:05:00Z");
  assert.equal(r.valid, true);
});

test("R - scored_at ANTERIOR a processed_at del evento es un look-ahead bias real, invalido", () => {
  const r = validateScoreOrdering("2026-09-09T04:05:00Z", "2026-09-09T04:00:00Z");
  assert.equal(r.valid, false);
  assert.match(r.error, /look-ahead/);
});

test("R - timestamps faltantes nunca se asumen validos por default", () => {
  assert.equal(validateScoreOrdering(null, "2026-09-09T04:00:00Z").valid, false);
  assert.equal(validateScoreOrdering("2026-09-09T04:00:00Z", null).valid, false);
});

test("materiality level: umbrales exactos LOW<40<=MEDIUM<70<=HIGH", () => {
  assert.equal(deriveMaterialityLevel(0), "LOW");
  assert.equal(deriveMaterialityLevel(39), "LOW");
  assert.equal(deriveMaterialityLevel(40), "MEDIUM");
  assert.equal(deriveMaterialityLevel(69), "MEDIUM");
  assert.equal(deriveMaterialityLevel(70), "HIGH");
  assert.equal(deriveMaterialityLevel(100), "HIGH");
  assert.equal(deriveMaterialityLevel(null), null); // DATA_UNAVAILABLE nunca tiene un level inventado
});
