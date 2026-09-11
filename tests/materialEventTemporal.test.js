import { test } from "node:test";
import assert from "node:assert/strict";
import {
  resolveEffectiveOccurredAt, resolveDecisionAvailableAt, classifyFreshness, validateTemporalOrder, FRESHNESS_STATUS,
} from "../lib/materialEventTemporal.js";

// H. timestamps preservados correctamente
test("H - resolveEffectiveOccurredAt prioriza occurred_at, luego published_at, luego discovered_at", () => {
  assert.equal(resolveEffectiveOccurredAt({ occurred_at: "2026-08-01", published_at: "2026-08-02", discovered_at: "2026-08-03" }), "2026-08-01");
  assert.equal(resolveEffectiveOccurredAt({ occurred_at: null, published_at: "2026-08-02", discovered_at: "2026-08-03" }), "2026-08-02");
  assert.equal(resolveEffectiveOccurredAt({ occurred_at: null, published_at: null, discovered_at: "2026-08-03" }), "2026-08-03");
  assert.equal(resolveEffectiveOccurredAt({ occurred_at: null, published_at: null, discovered_at: null }), null);
});

test("decision_available_at = processed_at en P3.1A, nunca inventado si processed_at falta", () => {
  assert.equal(resolveDecisionAvailableAt({ processed_at: "2026-08-01T12:00:00Z" }), "2026-08-01T12:00:00Z");
  assert.equal(resolveDecisionAvailableAt({ processed_at: null }), null);
});

// G. evento antiguo descubierto hoy → no se marca FRESH incorrectamente
test("G - evento que OCURRIO hace 60 dias pero se DESCUBRIO hoy -> NO es FRESH (occurred_at manda, no solo discovered_at)", () => {
  const now = "2026-08-01T00:00:00Z";
  const r = classifyFreshness({ discovered_at: "2026-08-01T00:00:00Z", occurred_at: "2026-06-01T00:00:00Z", published_at: "2026-06-01T00:00:00Z" }, now);
  assert.notEqual(r.status, FRESHNESS_STATUS.FRESH);
  assert.equal(r.status, FRESHNESS_STATUS.STALE);
});

test("evento descubierto y ocurrido ambos dentro de la ventana -> FRESH", () => {
  const now = "2026-08-01T12:00:00Z";
  const r = classifyFreshness({ discovered_at: "2026-08-01T00:00:00Z", occurred_at: "2026-07-31T00:00:00Z", published_at: "2026-07-31T00:00:00Z" }, now);
  assert.equal(r.status, FRESHNESS_STATUS.FRESH);
});

test("evento con discovered_at reciente pero occurred_at hace 15 dias -> RECENT, no FRESH ni STALE", () => {
  const now = "2026-08-15T00:00:00Z";
  const r = classifyFreshness({ discovered_at: "2026-08-15T00:00:00Z", occurred_at: "2026-08-01T00:00:00Z", published_at: "2026-08-01T00:00:00Z" }, now);
  assert.equal(r.status, FRESHNESS_STATUS.RECENT);
});

test("sin discovered_at ni occurred_at/published_at -> STALE por defecto, nunca FRESH por ausencia de dato", () => {
  const now = "2026-08-15T00:00:00Z";
  const r = classifyFreshness({ discovered_at: null, occurred_at: null, published_at: null }, now);
  assert.equal(r.status, FRESHNESS_STATUS.STALE);
  assert.equal(r.reason, "missing_required_timestamp");
});

// Validacion de orden temporal
test("validateTemporalOrder detecta discovered_at antes que published_at como invalido", () => {
  const r = validateTemporalOrder({ occurred_at: "2026-08-01T09:00", published_at: "2026-08-01T10:00", discovered_at: "2026-08-01T08:00", processed_at: "2026-08-01T11:00" });
  assert.equal(r.valid, false);
  assert.ok(r.errors.includes("published_at_after_discovered_at"));
});

test("validateTemporalOrder acepta orden causal correcto", () => {
  const r = validateTemporalOrder({ occurred_at: "2026-08-01T08:00", published_at: "2026-08-01T09:00", discovered_at: "2026-08-01T10:00", processed_at: "2026-08-01T11:00" });
  assert.equal(r.valid, true);
  assert.deepEqual(r.errors, []);
});

test("validateTemporalOrder con campos null no falla -- solo compara lo que existe", () => {
  const r = validateTemporalOrder({ occurred_at: null, published_at: null, discovered_at: "2026-08-01T10:00", processed_at: "2026-08-01T11:00" });
  assert.equal(r.valid, true);
});
