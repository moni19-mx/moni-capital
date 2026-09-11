import { test } from "node:test";
import assert from "node:assert/strict";
import { parseAiAdjustmentResponse, requestAiAdjustment, AI_NOT_ATTEMPTED } from "../lib/materialityAiAdjustment.js";

test("parseAiAdjustmentResponse: respuesta valida con adjustment != 0 y reason -> valid true", () => {
  const raw = JSON.stringify({ adjustment: 10, reason: "Cliente estrategico nuevo confirma expansion de segmento.", interpretation: "Fortalece la tesis.", confidence: 70 });
  const r = parseAiAdjustmentResponse(raw);
  assert.equal(r.valid, true);
  assert.equal(r.adjustment, 10);
  assert.equal(r.reason, "Cliente estrategico nuevo confirma expansion de segmento.");
});

test("parseAiAdjustmentResponse: JSON invalido -> valid false, adjustment 0", () => {
  const r = parseAiAdjustmentResponse("esto no es json {");
  assert.equal(r.valid, false);
  assert.equal(r.error, "invalid_json");
  assert.equal(r.adjustment, 0);
});

test("parseAiAdjustmentResponse: adjustment fuera de rango -> valid false", () => {
  const r = parseAiAdjustmentResponse(JSON.stringify({ adjustment: 50, reason: "x" }));
  assert.equal(r.valid, false);
  assert.equal(r.error, "adjustment_out_of_range");
});

test("parseAiAdjustmentResponse: adjustment != 0 sin reason -> valid false", () => {
  const r = parseAiAdjustmentResponse(JSON.stringify({ adjustment: 8 }));
  assert.equal(r.valid, false);
  assert.equal(r.error, "reason_required_for_nonzero_adjustment");
});

test("parseAiAdjustmentResponse: acepta markdown fences ```json alrededor del JSON", () => {
  const r = parseAiAdjustmentResponse("```json\n" + JSON.stringify({ adjustment: 0 }) + "\n```");
  assert.equal(r.valid, true);
  assert.equal(r.adjustment, 0);
});

// E (contexto AI adjustment): neutral -> NEUTRAL status, deterministic intacto en el llamador
test("requestAiAdjustment: respuesta neutral (adjustment=0) -> ai_status NEUTRAL", async () => {
  const fakeCallModel = async () => JSON.stringify({ adjustment: 0, interpretation: "Sin señal adicional." });
  const r = await requestAiAdjustment(fakeCallModel, {});
  assert.equal(r.ai_status, "NEUTRAL");
  assert.equal(r.adjustment, 0);
});

test("requestAiAdjustment: respuesta valida con adjustment != 0 -> ai_status APPLIED", async () => {
  const fakeCallModel = async () => JSON.stringify({ adjustment: -10, reason: "El riesgo regulatorio pesa mas de lo que sugiere el score determinístico." });
  const r = await requestAiAdjustment(fakeCallModel, {});
  assert.equal(r.ai_status, "APPLIED");
  assert.equal(r.adjustment, -10);
  assert.equal(r.reason, "El riesgo regulatorio pesa mas de lo que sugiere el score determinístico.");
});

// V. fallo AI conserva deterministic score -- el CONTRATO nunca lanza,
// siempre da un resultado usable con adjustment=0.
test("V - callModelFn lanza excepcion (fallo de red real) -> ai_status FAILED, adjustment 0, nunca propaga la excepcion", async () => {
  const throwingCallModel = async () => { throw new Error("network timeout"); };
  const r = await requestAiAdjustment(throwingCallModel, {});
  assert.equal(r.ai_status, "FAILED");
  assert.equal(r.adjustment, 0);
  assert.equal(r.error, "network timeout");
});

test("V - respuesta vacia -> ai_status FAILED, adjustment 0", async () => {
  const emptyCallModel = async () => "";
  const r = await requestAiAdjustment(emptyCallModel, {});
  assert.equal(r.ai_status, "FAILED");
  assert.equal(r.adjustment, 0);
});

test("V - respuesta con JSON invalido -> ai_status FAILED, adjustment 0, nunca lanza", async () => {
  const malformedCallModel = async () => "no soy json";
  const r = await requestAiAdjustment(malformedCallModel, {});
  assert.equal(r.ai_status, "FAILED");
  assert.equal(r.adjustment, 0);
});

test("V - adjustment fuera de rango devuelto por el modelo -> ai_status FAILED (rechazado), nunca aplicado a ciegas", async () => {
  const outOfRangeCallModel = async () => JSON.stringify({ adjustment: 40, reason: "demasiado agresivo" });
  const r = await requestAiAdjustment(outOfRangeCallModel, {});
  assert.equal(r.ai_status, "FAILED");
  assert.equal(r.adjustment, 0);
});

test("AI_NOT_ATTEMPTED: constante lista para scoring puramente deterministico, adjustment 0 explicito", () => {
  assert.equal(AI_NOT_ATTEMPTED.ai_status, "NOT_ATTEMPTED");
  assert.equal(AI_NOT_ATTEMPTED.adjustment, 0);
});
