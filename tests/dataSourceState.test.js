import test from "node:test";
import assert from "node:assert/strict";
import {
  SOURCE_STATUS, initialSourceMeta, resolveSourceMeta, resolveAllSourceMeta,
  isCriticalInitialFailure, isCurrentRequest,
} from "../lib/dataSourceState.js";

const T1 = "2026-09-09T10:00:00.000Z";
const T2 = "2026-09-09T10:01:00.000Z";

// ================== A. Todas las fuentes responden -- comportamiento normal ==================
test("A - primer intento exitoso: NEVER_LOADED -> OK, lastSuccessfulAt = now", () => {
  const r = resolveSourceMeta(initialSourceMeta(), { status: "fulfilled", value: [1, 2, 3] }, T1);
  assert.equal(r.status, SOURCE_STATUS.OK);
  assert.equal(r.lastSuccessfulAt, T1);
  assert.equal(r.lastAttemptAt, T1);
  assert.equal(r.error, null);
});

test("A2 - segundo intento tambien exitoso: OK -> OK, lastSuccessfulAt avanza", () => {
  const prev = { status: SOURCE_STATUS.OK, lastSuccessfulAt: T1, lastAttemptAt: T1, error: null };
  const r = resolveSourceMeta(prev, { status: "fulfilled", value: [] }, T2);
  assert.equal(r.status, SOURCE_STATUS.OK);
  assert.equal(r.lastSuccessfulAt, T2);
});

// ================== B/C/D/F/G. Una fuente falla durante un refresh que ya tenia datos validos ==================
// (cash_movements, watchlist, accounts, market-data son instancias del
// mismo caso generico: "habia OK, este intento fallo" -> STALE, nunca
// se trata como si los datos no existieran.)
test("B/C/D/F - fuente con exito previo que ahora falla -> STALE, conserva lastSuccessfulAt viejo, NUNCA ERROR", () => {
  const prev = { status: SOURCE_STATUS.OK, lastSuccessfulAt: T1, lastAttemptAt: T1, error: null };
  const r = resolveSourceMeta(prev, { status: "rejected", reason: new Error("network hiccup") }, T2);
  assert.equal(r.status, SOURCE_STATUS.STALE);
  assert.equal(r.lastSuccessfulAt, T1); // el ultimo exito NO se pierde
  assert.equal(r.lastAttemptAt, T2);
  assert.equal(r.error, "network hiccup");
});

test("E - futures-equity con exito previo que ahora falla -> STALE, NUNCA se confunde con un $0 real", () => {
  // La propia funcion no sabe de dolares -- lo que prueba esto es que el
  // status resultante es STALE (dato viejo conservado), nunca OK con un
  // valor nuevo. Combinado con dataFetchers.test.js (fetchFuturesEquity
  // ahora SIEMPRE rechaza en vez de resolver con {total_value_usd:0}),
  // esto cierra el bug de raiz: App.jsx nunca llama setFuturesEquity()
  // en la rama "rejected", asi que el valor en pantalla nunca cambia a 0.
  const prev = { status: SOURCE_STATUS.OK, lastSuccessfulAt: T1, lastAttemptAt: T1, error: null };
  const r = resolveSourceMeta(prev, { status: "rejected", reason: new Error("futures_equity_http_500") }, T2);
  assert.equal(r.status, SOURCE_STATUS.STALE);
  assert.notEqual(r.status, SOURCE_STATUS.OK);
});

// ================== G. Varias fuentes fallan simultaneamente ==================
test("G - fallo simultaneo de varias fuentes: cada una se resuelve de forma independiente", () => {
  const previousMeta = {
    cash_movements: { status: SOURCE_STATUS.OK, lastSuccessfulAt: T1, lastAttemptAt: T1, error: null },
    watchlist: { status: SOURCE_STATUS.OK, lastSuccessfulAt: T1, lastAttemptAt: T1, error: null },
    positions: { status: SOURCE_STATUS.OK, lastSuccessfulAt: T1, lastAttemptAt: T1, error: null },
  };
  const results = {
    cash_movements: { status: "rejected", reason: new Error("x") },
    watchlist: { status: "rejected", reason: new Error("y") },
    positions: { status: "fulfilled", value: [{ id: 1 }] }, // esta SI se actualiza
  };
  const next = resolveAllSourceMeta(previousMeta, results, T2);
  assert.equal(next.cash_movements.status, SOURCE_STATUS.STALE);
  assert.equal(next.watchlist.status, SOURCE_STATUS.STALE);
  assert.equal(next.positions.status, SOURCE_STATUS.OK); // no se contamina por las otras dos fallando
  assert.equal(next.positions.lastSuccessfulAt, T2);
});

// ================== H. Initial load sin datos + fallo ==================
test("H - initial load falla, nunca hubo exito previo -> ERROR explicito, nunca datos inventados", () => {
  const r = resolveSourceMeta(initialSourceMeta(), { status: "rejected", reason: new Error("timeout") }, T1);
  assert.equal(r.status, SOURCE_STATUS.ERROR);
  assert.equal(r.lastSuccessfulAt, null);
  assert.ok(isCriticalInitialFailure(r), "debe marcarse como fallo critico de carga inicial");
});

test("H2 - isCriticalInitialFailure es false una vez que hubo al menos un exito, aunque luego falle", () => {
  const prev = { status: SOURCE_STATUS.OK, lastSuccessfulAt: T1, lastAttemptAt: T1, error: null };
  const r = resolveSourceMeta(prev, { status: "rejected", reason: new Error("timeout") }, T2);
  assert.equal(isCriticalInitialFailure(r), false);
});

// ================== K. El polling sigue funcionando tras un error transitorio ==================
test("K - STALE no es un estado terminal: un intento posterior exitoso puede volver a OK", () => {
  const afterFailure = { status: SOURCE_STATUS.STALE, lastSuccessfulAt: T1, lastAttemptAt: T1, error: "x" };
  const r = resolveSourceMeta(afterFailure, { status: "fulfilled", value: [42] }, T2);
  assert.equal(r.status, SOURCE_STATUS.OK);
  assert.equal(r.lastSuccessfulAt, T2);
  assert.equal(r.error, null);
});

// ================== L. Recuperacion: falla N, funciona N+1 ==================
test("L - secuencia OK -> falla -> OK: status vuelve a OK y el error se limpia", () => {
  let meta = resolveSourceMeta(initialSourceMeta(), { status: "fulfilled", value: [] }, T1); // N-1: OK
  assert.equal(meta.status, SOURCE_STATUS.OK);
  meta = resolveSourceMeta(meta, { status: "rejected", reason: new Error("boom") }, T2); // N: falla
  assert.equal(meta.status, SOURCE_STATUS.STALE);
  assert.equal(meta.error, "boom");
  meta = resolveSourceMeta(meta, { status: "fulfilled", value: [1] }, "2026-09-09T10:02:00.000Z"); // N+1: OK
  assert.equal(meta.status, SOURCE_STATUS.OK);
  assert.equal(meta.error, null);
  assert.equal(meta.lastSuccessfulAt, "2026-09-09T10:02:00.000Z");
});

// ================== I/J. Proteccion de concurrencia (race condition) ==================
test("I - request unica en vuelo: sigue siendo la mas reciente, se le permite commitear", () => {
  let latestStarted = 0;
  latestStarted = 1; // loadAll() #1 arranca
  assert.equal(isCurrentRequest(1, latestStarted), true);
});

test("J - respuesta vieja llegando despues de una mas nueva: NO puede commitear (se descarta entera)", () => {
  let latestStarted = 0;
  latestStarted = 1; // request A arranca, id=1
  latestStarted = 2; // antes de que A termine, request B arranca (refresh manual mientras el polling seguia esperando), id=2
  // A termina su fetch DESPUES de que B ya arranco:
  assert.equal(isCurrentRequest(1, latestStarted), false, "A (vieja) debe ser rechazada");
  // B termina, sigue siendo la mas reciente que arranco:
  assert.equal(isCurrentRequest(2, latestStarted), true, "B (nueva) debe poder commitear");
});

test("J2 - si A termina PRIMERO y B todavia no arranca, A si puede commitear (caso normal, sin solapamiento)", () => {
  let latestStarted = 0;
  latestStarted = 1; // request A arranca
  // A termina y commitea antes de que exista una B:
  assert.equal(isCurrentRequest(1, latestStarted), true);
});
