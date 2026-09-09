// tests/neutralMarkerRegression.test.js
// Micro-sprint P3.2.1, item 16. Regresion PERMANENTE del bug real
// encontrado y corregido en vivo durante P3.2: un evento que el AI
// evaluo con exito y no encontro efecto en ninguna dimension
// (affected_dimensions=[], component_deltas=[] -> ai_status NEUTRAL)
// nunca dejaba fila en thesis_dimension_effects, asi que
// fetchUnprocessedEvents() (api/conviction-benchmark-temp.js) lo volvia
// a seleccionar -- y a re-facturar al AI -- en cada corrida siguiente.
// Confirmado en produccion: evento 4 (QCOM) reprocesado ~12x, evento 8
// (AMD) ~11x en una sola sesion, 23 filas de conviction_history creadas
// por 2 decisiones reales.

import { test } from "node:test";
import assert from "node:assert/strict";
import { shouldInsertNeutralMarker, requestThesisImpact } from "../lib/thesisImpactAi.js";

// ================== shouldInsertNeutralMarker: la decision pura ==================
test("shouldInsertNeutralMarker: AI corrio con exito y NEUTRAL (0 efectos) -> true (debe insertar marcador)", () => {
  assert.equal(shouldInsertNeutralMarker({ effectRowsCount: 0, aiStatus: "NEUTRAL" }), true);
});

test("shouldInsertNeutralMarker: AI corrio con exito, APPLIED, pero por alguna razon 0 filas de efecto -> true", () => {
  assert.equal(shouldInsertNeutralMarker({ effectRowsCount: 0, aiStatus: "APPLIED" }), true);
});

test("shouldInsertNeutralMarker: AI corrio y produjo filas de efecto reales (APPLIED con dimensiones) -> false (no duplica marcador)", () => {
  assert.equal(shouldInsertNeutralMarker({ effectRowsCount: 2, aiStatus: "APPLIED" }), false);
});

test("shouldInsertNeutralMarker: AI FAILED -> false SIEMPRE, el evento debe reintentarse la proxima corrida, nunca marcarse como evaluado", () => {
  assert.equal(shouldInsertNeutralMarker({ effectRowsCount: 0, aiStatus: "FAILED" }), false);
});

test("shouldInsertNeutralMarker: NOT_ATTEMPTED (ai_test=false) -> false SIEMPRE, nunca se marca como evaluado sin haber corrido", () => {
  assert.equal(shouldInsertNeutralMarker({ effectRowsCount: 0, aiStatus: "NOT_ATTEMPTED" }), false);
});

// ================== N. Ciclo completo: simulacion funcional sin Supabase ==================
// Reproduce el ciclo real de api/conviction-benchmark-temp.js con una
// tabla en memoria que imita thesis_dimension_effects + el filtro de
// fetchUnprocessedEvents (eventos SIN fila en esa tabla) -- usa las
// MISMAS funciones puras reales (shouldInsertNeutralMarker,
// requestThesisImpact), nunca una reimplementacion paralela de la
// logica que se quiere proteger.
function fetchUnprocessedEventIds(allEventIds, effectsTable) {
  const processed = new Set(effectsTable.map((r) => r.material_event_id));
  return allEventIds.filter((id) => !processed.has(id));
}

async function runOnePass(allEvents, effectsTable, callModelFn, billingLog, validDimensionIds = []) {
  const unprocessedIds = fetchUnprocessedEventIds(allEvents.map((e) => e.id), effectsTable);
  const unprocessed = allEvents.filter((e) => unprocessedIds.includes(e.id));
  for (const event of unprocessed) {
    billingLog.push(event.id); // cada llamada real al AI factura -- este es el conteo que el bug disparaba en runaway
    const aiResult = await requestThesisImpact(callModelFn, "prompt", { validDimensionIds, validComponentKeys: [] });
    const effectRows = aiResult.affected_dimensions.map((d) => ({ material_event_id: event.id, dimension_id: d.dimension_id }));
    if (shouldInsertNeutralMarker({ effectRowsCount: effectRows.length, aiStatus: aiResult.ai_status })) {
      effectRows.push({ material_event_id: event.id, dimension_id: null, effect: "NEUTRAL" });
    }
    effectsTable.push(...effectRows);
  }
  return unprocessed.length;
}

test("N - ciclo completo: evento de ruido real (NEUTRAL) se procesa UNA sola vez -- la segunda corrida no vuelve a facturar al AI ni crea nueva fila", async () => {
  const events = [{ id: 999, headline: "Ruido generico sin relacion a la tesis" }];
  const effectsTable = [];
  const billingLog = [];
  // Simula exactamente el resultado real: JSON valido, sin dimensiones ni deltas -> ai_status NEUTRAL.
  const callModelFn = async () => '{"affected_dimensions": [], "component_deltas": [], "requires_review": false}';

  const processedFirstPass = await runOnePass(events, effectsTable, callModelFn, billingLog);
  assert.equal(processedFirstPass, 1, "primera corrida debe procesar el evento");
  assert.equal(billingLog.length, 1, "primera corrida debe facturar al AI exactamente 1 vez");
  assert.equal(effectsTable.length, 1, "debe quedar exactamente 1 fila marcadora tras la primera corrida");
  assert.equal(effectsTable[0].dimension_id, null);
  assert.equal(effectsTable[0].effect, "NEUTRAL");

  const processedSecondPass = await runOnePass(events, effectsTable, callModelFn, billingLog);
  assert.equal(processedSecondPass, 0, "REGRESION: la segunda corrida NO debe reprocesar el evento ya marcado NEUTRAL");
  assert.equal(billingLog.length, 1, "REGRESION: el AI no debe volver a facturarse -- este es el bug real de re-billing runaway");
  assert.equal(effectsTable.length, 1, "REGRESION: no debe crearse una segunda fila para el mismo evento");
});

test("N - ciclo completo: 5 corridas consecutivas sobre el mismo evento NEUTRAL -> AI facturado exactamente 1 vez en total (nunca runaway)", async () => {
  const events = [{ id: 4, headline: "QCOM: evento real que en produccion causo ~12 reprocesos antes del fix" }];
  const effectsTable = [];
  const billingLog = [];
  const callModelFn = async () => '{"affected_dimensions": [], "component_deltas": [], "requires_review": false}';

  for (let i = 0; i < 5; i++) {
    await runOnePass(events, effectsTable, callModelFn, billingLog);
  }
  assert.equal(billingLog.length, 1, `REGRESION runaway-billing: 5 corridas deberian facturar 1 sola vez, factured ${billingLog.length}`);
  assert.equal(effectsTable.length, 1);
});

test("N - un evento con efecto real (APPLIED, dimension afectada) tambien queda protegido de reproceso -- no solo el caso NEUTRAL", async () => {
  const events = [{ id: 7, headline: "QCOM anuncia guidance real con impacto directo en la tesis" }];
  const effectsTable = [];
  const billingLog = [];
  const callModelFn = async () => JSON.stringify({
    affected_dimensions: [{ dimension_id: 1, effect: "CONFIRMS", confidence: 80, explanation: "guidance real confirma la tesis" }],
    component_deltas: [], requires_review: false,
  });

  await runOnePass(events, effectsTable, callModelFn, billingLog, [1]);
  await runOnePass(events, effectsTable, callModelFn, billingLog, [1]);
  assert.equal(billingLog.length, 1, "un evento con efecto real tampoco debe reprocesarse");
  assert.equal(effectsTable.length, 1);
  assert.equal(effectsTable[0].dimension_id, 1);
});

test("N - AI FAILED se reintenta correctamente en la siguiente corrida (esto NO es el bug -- es el comportamiento correcto)", async () => {
  const events = [{ id: 11, headline: "Evento cuyo AI fallo la primera vez (JSON invalido)" }];
  const effectsTable = [];
  const billingLog = [];
  let call = 0;
  const callModelFn = async () => {
    call++;
    if (call === 1) return "esto no es JSON valido";
    return '{"affected_dimensions": [], "component_deltas": [], "requires_review": false}';
  };

  await runOnePass(events, effectsTable, callModelFn, billingLog);
  assert.equal(effectsTable.length, 0, "FAILED nunca debe dejar fila marcadora");
  await runOnePass(events, effectsTable, callModelFn, billingLog);
  assert.equal(billingLog.length, 2, "a diferencia de NEUTRAL, un FAILED SI debe reintentarse -- 2 facturas reales, no un bug");
  assert.equal(effectsTable.length, 1, "la segunda corrida (exitosa) si deja marcador");
});
