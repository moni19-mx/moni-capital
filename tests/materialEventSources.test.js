import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assignSourceRoles, reassignRolesWithNewSource, countIndependentSources, tierScore, SOURCE_ROLE,
} from "../lib/materialEventSources.js";

// C. 2 providers mismo evento → 1 cluster (parte de roles: ambas quedan en el mismo set de roles)
test("C - 2 sources del mismo cluster reciben roles distintos, nunca duplicados", () => {
  const sources = [
    { id: "s1", tier: 3, ingested_at: "2026-08-01T10:00:00Z" },
    { id: "s2", tier: 1, ingested_at: "2026-08-01T11:00:00Z" },
  ];
  const roles = assignSourceRoles(sources);
  const byId = Object.fromEntries(roles.map((r) => [r.id, r.role]));
  assert.equal(byId.s1, SOURCE_ROLE.DISCOVERY_SOURCE);
  assert.equal(byId.s2, SOURCE_ROLE.PRIMARY_EVIDENCE_SOURCE);
});

// D. misma wire republicada 5 veces → corroboration no se infla
test("D - 5 republicaciones del mismo wire cuentan como 1 fuente independiente", () => {
  const sources = [
    { provider: "outlet-a", attributed_wire: "reuters-wire-123" },
    { provider: "outlet-b", attributed_wire: "reuters-wire-123" },
    { provider: "outlet-c", attributed_wire: "reuters-wire-123" },
    { provider: "outlet-d", attributed_wire: "reuters-wire-123" },
    { provider: "outlet-e", attributed_wire: "reuters-wire-123" },
  ];
  assert.equal(countIndependentSources(sources), 1);
});

test("D - 2 fuentes de wires distintos SI cuentan como 2 independientes", () => {
  const sources = [
    { provider: "fmp", attributed_wire: "reuters-wire-123" },
    { provider: "sec_edgar", attributed_wire: null },
  ];
  assert.equal(countIndependentSources(sources), 2);
});

test("D - sin attributed_wire, se deduplica por provider", () => {
  const sources = [
    { provider: "fmp", attributed_wire: null },
    { provider: "fmp", attributed_wire: null },
    { provider: "finnhub", attributed_wire: null },
  ];
  assert.equal(countIndependentSources(sources), 2);
});

// E. fuente Tier 3 llega primero, Tier 1 después → primary promotion correcta
test("E - Tier 3 primero (discovery), Tier 1 despues -> promocion correcta a PRIMARY_EVIDENCE_SOURCE", () => {
  const existing = assignSourceRoles([{ id: "s1", tier: 3, ingested_at: "2026-08-01T10:00:00Z" }]);
  const newSource = { id: "s2", tier: 1, ingested_at: "2026-08-01T14:00:00Z" };
  const { roles, promoted, previousPrimaryId, newPrimaryId } = reassignRolesWithNewSource(existing, newSource);

  assert.equal(promoted, true);
  assert.equal(previousPrimaryId, "s1");
  assert.equal(newPrimaryId, "s2");
  const byId = Object.fromEntries(roles.map((r) => [r.id, r.role]));
  assert.equal(byId.s2, SOURCE_ROLE.PRIMARY_EVIDENCE_SOURCE);
  assert.equal(byId.s1, SOURCE_ROLE.DISCOVERY_SOURCE); // sigue siendo discovery, nunca pierde ese hecho historico
});

test("E - una segunda fuente de MENOR tier que la primary actual nunca la desplaza", () => {
  const existing = assignSourceRoles([{ id: "s1", tier: 1, ingested_at: "2026-08-01T10:00:00Z" }]);
  const newSource = { id: "s2", tier: 3, ingested_at: "2026-08-01T14:00:00Z" };
  const { promoted, newPrimaryId } = reassignRolesWithNewSource(existing, newSource);
  assert.equal(promoted, false);
  assert.equal(newPrimaryId, "s1");
});

test("empate de tier: gana la que llego primero como primary, nunca ambiguo", () => {
  const sources = [
    { id: "s1", tier: 1, ingested_at: "2026-08-01T10:00:00Z" },
    { id: "s2", tier: 1, ingested_at: "2026-08-01T11:00:00Z" },
  ];
  const roles = assignSourceRoles(sources);
  const byId = Object.fromEntries(roles.map((r) => [r.id, r.role]));
  assert.equal(byId.s1, SOURCE_ROLE.PRIMARY_EVIDENCE_SOURCE);
  assert.equal(byId.s2, SOURCE_ROLE.CORROBORATING_SOURCE);
});

test("tierScore: tabla exacta 1->100, 2->70, 3->50, 4->25, desconocido->0", () => {
  assert.equal(tierScore(1), 100);
  assert.equal(tierScore(2), 70);
  assert.equal(tierScore(3), 50);
  assert.equal(tierScore(4), 25);
  assert.equal(tierScore(99), 0);
});

test("assignSourceRoles nunca muta el array de entrada", () => {
  const sources = [{ id: "s1", tier: 3, ingested_at: "2026-08-01T10:00:00Z" }];
  const copy = JSON.parse(JSON.stringify(sources));
  assignSourceRoles(sources);
  assert.deepEqual(sources, copy);
});
