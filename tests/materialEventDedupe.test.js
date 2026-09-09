import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveClusterAssignment } from "../lib/materialEventDedupe.js";

// C. 2 providers mismo evento → 1 cluster
test("C - misma noticia reportada por 2 proveedores distintos (facts compatibles, misma ventana) -> mismo cluster", () => {
  const candidates = [{
    cluster_id: "cl-1", asset_id: 42, event_type: "MAJOR_CONTRACT",
    effective_occurred_at: "2026-08-01T10:00:00Z",
    facts: { counterparty: "Amazon", deal_value: "UNKNOWN" },
  }];
  const newReading = {
    asset_id: 42, event_type: "MAJOR_CONTRACT",
    effective_occurred_at: "2026-08-01T11:30:00Z", // 1.5h despues, misma ventana de 24h
    facts: { counterparty: "amazon" }, // mismo valor, distinto case -- debe matchear
  };
  const r = resolveClusterAssignment(candidates, newReading);
  assert.equal(r.action, "ATTACH_TO_CLUSTER");
  assert.equal(r.cluster_id, "cl-1");
});

// F. eventos distintos mismo ticker/día → no dedupe falso
test("F - mismo ticker y mismo dia pero event_type distinto -> NO fusiona", () => {
  const candidates = [{
    cluster_id: "cl-1", asset_id: 42, event_type: "EARNINGS",
    effective_occurred_at: "2026-08-01T10:00:00Z", facts: {},
  }];
  const newReading = {
    asset_id: 42, event_type: "ANALYST",
    effective_occurred_at: "2026-08-01T12:00:00Z", facts: {},
  };
  const r = resolveClusterAssignment(candidates, newReading);
  assert.equal(r.action, "NEW_CLUSTER");
});

test("F - mismo ticker, mismo event_type, mismo dia, pero facts comparables y DISTINTOS -> NO fusiona (2 contratos distintos el mismo dia)", () => {
  const candidates = [{
    cluster_id: "cl-1", asset_id: 42, event_type: "MAJOR_CONTRACT",
    effective_occurred_at: "2026-08-01T09:00:00Z",
    facts: { counterparty: "Amazon" },
  }];
  const newReading = {
    asset_id: 42, event_type: "MAJOR_CONTRACT",
    effective_occurred_at: "2026-08-01T15:00:00Z",
    facts: { counterparty: "Microsoft" }, // contraparte distinta, comparable, no coincide
  };
  const r = resolveClusterAssignment(candidates, newReading);
  assert.equal(r.action, "NEW_CLUSTER");
});

test("fuera de la ventana de 24h -> NEW_CLUSTER aunque todo lo demas coincida", () => {
  const candidates = [{
    cluster_id: "cl-1", asset_id: 42, event_type: "MAJOR_CONTRACT",
    effective_occurred_at: "2026-08-01T10:00:00Z",
    facts: { counterparty: "Amazon" },
  }];
  const newReading = {
    asset_id: 42, event_type: "MAJOR_CONTRACT",
    effective_occurred_at: "2026-08-03T10:00:00Z", // 48h despues
    facts: { counterparty: "Amazon" },
  };
  const r = resolveClusterAssignment(candidates, newReading);
  assert.equal(r.action, "NEW_CLUSTER");
});

test("asset_id distinto nunca fusiona aunque todo lo demas coincida", () => {
  const candidates = [{
    cluster_id: "cl-1", asset_id: 42, event_type: "MAJOR_CONTRACT",
    effective_occurred_at: "2026-08-01T10:00:00Z", facts: { counterparty: "Amazon" },
  }];
  const newReading = {
    asset_id: 99, event_type: "MAJOR_CONTRACT",
    effective_occurred_at: "2026-08-01T10:30:00Z", facts: { counterparty: "Amazon" },
  };
  const r = resolveClusterAssignment(candidates, newReading);
  assert.equal(r.action, "NEW_CLUSTER");
});

test("facts con UNKNOWN de un lado nunca cuentan como conflicto -- match procede por asset+type+ventana", () => {
  const candidates = [{
    cluster_id: "cl-1", asset_id: 42, event_type: "MAJOR_CONTRACT",
    effective_occurred_at: "2026-08-01T10:00:00Z", facts: { deal_value: "UNKNOWN" },
  }];
  const newReading = {
    asset_id: 42, event_type: "MAJOR_CONTRACT",
    effective_occurred_at: "2026-08-01T11:00:00Z", facts: { deal_value: 500000000 },
  };
  const r = resolveClusterAssignment(candidates, newReading);
  assert.equal(r.action, "ATTACH_TO_CLUSTER");
});

test("montos numericos con diferencia menor al 5% matchean (tolerancia de redondeo entre proveedores)", () => {
  const candidates = [{
    cluster_id: "cl-1", asset_id: 42, event_type: "MAJOR_CONTRACT",
    effective_occurred_at: "2026-08-01T10:00:00Z", facts: { deal_value: 500000000 },
  }];
  const newReading = {
    asset_id: 42, event_type: "MAJOR_CONTRACT",
    effective_occurred_at: "2026-08-01T11:00:00Z", facts: { deal_value: 510000000 }, // +2%
  };
  const r = resolveClusterAssignment(candidates, newReading);
  assert.equal(r.action, "ATTACH_TO_CLUSTER");
});

test("multiples clusters candidatos: solo fusiona con el que realmente matchea", () => {
  const candidates = [
    { cluster_id: "cl-old", asset_id: 42, event_type: "EARNINGS", effective_occurred_at: "2026-07-01T10:00:00Z", facts: {} },
    { cluster_id: "cl-match", asset_id: 42, event_type: "MAJOR_CONTRACT", effective_occurred_at: "2026-08-01T10:00:00Z", facts: { counterparty: "Amazon" } },
  ];
  const newReading = { asset_id: 42, event_type: "MAJOR_CONTRACT", effective_occurred_at: "2026-08-01T11:00:00Z", facts: { counterparty: "Amazon" } };
  const r = resolveClusterAssignment(candidates, newReading);
  assert.equal(r.cluster_id, "cl-match");
});

// L. rerun/idempotencia
test("L - reprocesar la MISMA lectura dos veces (ej. retry tras timeout) nunca crea un segundo cluster -- el candidato ya persistido de la primera corrida hace que la segunda ataque al mismo cluster", () => {
  // Simula: corrida 1 inserto un evento -> ahora es un candidato real.
  const persistedAfterFirstRun = [{
    cluster_id: "cl-real-1", asset_id: 29, event_type: "MAJOR_CONTRACT",
    effective_occurred_at: "2026-08-01T10:00:00Z", facts: { counterparty: "Amazon", deal_value: "UNKNOWN" },
  }];
  // Corrida 2: el mismo job de ingestion procesa la MISMA fuente cruda otra
  // vez (ej. un retry automatico tras un timeout de red a mitad de la
  // corrida 1) -- la lectura normalizada es identica.
  const sameReadingAgain = {
    asset_id: 29, event_type: "MAJOR_CONTRACT",
    effective_occurred_at: "2026-08-01T10:00:00Z", facts: { counterparty: "Amazon", deal_value: "UNKNOWN" },
  };
  const r = resolveClusterAssignment(persistedAfterFirstRun, sameReadingAgain);
  assert.equal(r.action, "ATTACH_TO_CLUSTER");
  assert.equal(r.cluster_id, "cl-real-1");
  // Nota de diseño (ver reporte del sprint): la idempotencia real depende
  // de que el llamador SIEMPRE consulte los clusters existentes antes de
  // insertar (responsabilidad de la capa de persistencia/orquestacion,
  // fuera de este modulo puro) -- este test prueba que, dado ese
  // candidato, la decision de dedupe es correcta y estable.
});
