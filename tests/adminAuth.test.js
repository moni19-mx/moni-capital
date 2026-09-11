// tests/adminAuth.test.js
// Conviction Coverage Orchestrator -- Priority 2 (automatizacion).
// checkAdminAuth es pura: nunca lee process.env, recibe env resuelto --
// testeable sin mocks de Vercel/req.

import { test } from "node:test";
import assert from "node:assert/strict";
import { checkAdminAuth } from "../lib/adminAuth.js";

const ENV = { MONI_ADMIN_SECRET: "s3cr3t-header-value", MONI_PIN: "1234" };

test("A: header x-admin-secret correcto -> authorized, method=header", () => {
  const result = checkAdminAuth({ headers: { "x-admin-secret": "s3cr3t-header-value" }, query: {} }, ENV);
  assert.deepEqual(result, { authorized: true, method: "header" });
});

test("B: header x-admin-secret incorrecto y sin PIN -> unauthorized", () => {
  const result = checkAdminAuth({ headers: { "x-admin-secret": "wrong" }, query: {} }, ENV);
  assert.equal(result.authorized, false);
});

test("C: sin header, PIN correcto en query -> authorized, method=pin_fallback", () => {
  const result = checkAdminAuth({ headers: {}, query: { pin: "1234" } }, ENV);
  assert.deepEqual(result, { authorized: true, method: "pin_fallback" });
});

test("D: PIN incorrecto -> unauthorized", () => {
  const result = checkAdminAuth({ headers: {}, query: { pin: "0000" } }, ENV);
  assert.equal(result.authorized, false);
});

test("E: header tiene prioridad sobre PIN si ambos estan presentes y el header es correcto", () => {
  const result = checkAdminAuth({ headers: { "x-admin-secret": "s3cr3t-header-value" }, query: { pin: "0000" } }, ENV);
  assert.deepEqual(result, { authorized: true, method: "header" });
});

test("F: header incorrecto pero PIN correcto -> cae al fallback, authorized", () => {
  const result = checkAdminAuth({ headers: { "x-admin-secret": "wrong" }, query: { pin: "1234" } }, ENV);
  assert.deepEqual(result, { authorized: true, method: "pin_fallback" });
});

test("G: nada presente -> unauthorized, method=none", () => {
  const result = checkAdminAuth({ headers: {}, query: {} }, ENV);
  assert.deepEqual(result, { authorized: false, method: "none" });
});

test("H: env sin MONI_ADMIN_SECRET configurado -> header vacio nunca autoriza", () => {
  const result = checkAdminAuth({ headers: { "x-admin-secret": "" } }, { MONI_PIN: "1234" });
  assert.equal(result.authorized, false);
});

test("I: headers/query ausentes por completo (llamada sin objeto) -> no explota, unauthorized", () => {
  assert.doesNotThrow(() => checkAdminAuth(undefined, ENV));
  assert.equal(checkAdminAuth(undefined, ENV).authorized, false);
});
