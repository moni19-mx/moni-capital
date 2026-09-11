// tests/fmpHistoricalNormalizer.test.js
//
// Regresion del bug real encontrado en la revision de Historical
// Multiple Data: el probe de precios historicos de FMP asumia siempre
// `{ historical: [...] }` y clasificaba NO_DATA para NVDA/AMZN, cuando
// la respuesta real de FMP es un ARRAY de nivel superior directamente
// (~1255 registros reales, confirmado en vivo). Esta suite prueba
// SOLO la funcion pura de normalizacion -- cero red.

import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeFmpHistoricalResponse } from "../lib/fmpHistoricalNormalizer.js";

test("A - top-level array -> records preservados, shape=array (caso real NVDA/AMZN)", () => {
  const body = [{ date: "2026-01-02", close: 100 }, { date: "2026-01-01", close: 99 }];
  const result = normalizeFmpHistoricalResponse(body);
  assert.equal(result.shape, "array");
  assert.equal(result.records.length, 2);
  assert.deepEqual(result.records, body);
});

test("B - object.historical array -> records preservados, shape=object.historical", () => {
  const body = { symbol: "AAPL", historical: [{ date: "2026-01-02", close: 100 }] };
  const result = normalizeFmpHistoricalResponse(body);
  assert.equal(result.shape, "object.historical");
  assert.equal(result.records.length, 1);
  assert.equal(result.records[0].close, 100);
});

test("C - object.data array -> records preservados, shape=object.data", () => {
  const body = { data: [{ date: "2026-01-02", close: 100 }] };
  const result = normalizeFmpHistoricalResponse(body);
  assert.equal(result.shape, "object.data");
  assert.equal(result.records.length, 1);
});

test("D - forma desconocida (objeto sin historical/data) -> shape=unsupported, records=[], NUNCA adivina", () => {
  const body = { symbol: "AAPL", quote: { price: 100 } };
  const result = normalizeFmpHistoricalResponse(body);
  assert.equal(result.shape, "unsupported");
  assert.deepEqual(result.records, []);
});

test("E - null/undefined/numero -> shape=unsupported, nunca truena", () => {
  assert.equal(normalizeFmpHistoricalResponse(null).shape, "unsupported");
  assert.equal(normalizeFmpHistoricalResponse(undefined).shape, "unsupported");
  assert.equal(normalizeFmpHistoricalResponse(42).shape, "unsupported");
  assert.equal(normalizeFmpHistoricalResponse("plain string").shape, "unsupported");
});

test("F - array vacio [] -> shape=array pero records=[] (NO_DATA real, distinto de forma no soportada)", () => {
  const result = normalizeFmpHistoricalResponse([]);
  assert.equal(result.shape, "array");
  assert.deepEqual(result.records, []);
});

test("G - object.historical vacio -> shape=object.historical, records=[] (NO_DATA real)", () => {
  const result = normalizeFmpHistoricalResponse({ historical: [] });
  assert.equal(result.shape, "object.historical");
  assert.deepEqual(result.records, []);
});

test("H - object.historical NO es array (forma malformada) -> nunca la usa, cae a unsupported", () => {
  const result = normalizeFmpHistoricalResponse({ historical: { foo: "bar" } });
  assert.equal(result.shape, "unsupported");
  assert.deepEqual(result.records, []);
});

test("I - precedencia: si `historical` y `data` coexisten, gana `historical` primero (orden documentado)", () => {
  const body = { historical: [{ date: "H" }], data: [{ date: "D" }] };
  const result = normalizeFmpHistoricalResponse(body);
  assert.equal(result.shape, "object.historical");
  assert.equal(result.records[0].date, "H");
});

test("J - un array de nivel superior NUNCA se clasifica como unsupported/NO_DATA solo por tener muchos elementos", () => {
  const bigArray = Array.from({ length: 1255 }, (_, i) => ({ date: `2020-01-${(i % 28) + 1}`, close: i }));
  const result = normalizeFmpHistoricalResponse(bigArray);
  assert.equal(result.shape, "array");
  assert.equal(result.records.length, 1255);
});
