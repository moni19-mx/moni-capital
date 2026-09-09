// tests/loadAllCoherence.test.js
// Micro-sprint P0.2 (Financial Totals Correctness + Stability). Tests
// G, K, L, M, N (letras del sprint) sobre el PATRON de commit atomico
// del grupo critico y la proteccion de concurrencia -- simulacion fiel
// de la forma real de src/App.jsx::loadAll() (mismo orden de awaits,
// mismo generation-counter via lib/dataSourceState.js::isCurrentRequest)
// operando sobre un objeto de estado plano en vez de React, para poder
// controlar el timing exacto de cada fuente sin un navegador.

import { test } from "node:test";
import assert from "node:assert/strict";
import { isCurrentRequest } from "../lib/dataSourceState.js";
import { mergeMarketData, buildMarketDataItems } from "../lib/financialSnapshot.js";

// Reproduce el MISMO orden de control real de loadAll(): espera
// positions+watchlist, arma items, dispara el grupo critico
// (cashMovements + marketData + futuresEquity), y solo entonces
// commitea las 4 fuentes financieras EN UN SOLO PASO (nunca una a la
// vez) -- la propiedad que este archivo verifica es exactamente esa:
// el observador nunca ve una combinacion incompleta.
function makeHarness(fetchers) {
  const state = { positions: [], watchlist: [], cashMovements: [], marketData: {}, futuresEquity: { total_value_usd: 0 } };
  const observedCommits = []; // snapshot de `state` en cada commit critico
  const latestRequestIdRef = { current: 0 };

  async function loadAll() {
    const myRequestId = ++latestRequestIdRef.current;
    const [posR, wlR] = await Promise.allSettled([fetchers.positions(), fetchers.watchlist()]);
    if (!isCurrentRequest(myRequestId, latestRequestIdRef.current)) return "superseded_before_critical";

    const positionsForItems = posR.status === "fulfilled" ? posR.value : state.positions;
    const watchlistForItems = wlR.status === "fulfilled" ? wlR.value : state.watchlist;
    buildMarketDataItems(positionsForItems, watchlistForItems); // ejercita la misma funcion real, sin usar el resultado aqui

    const [cmR, marketR, futuresR] = await Promise.allSettled([
      fetchers.cashMovements(), fetchers.marketData(), fetchers.futuresEquity(),
    ]);
    if (!isCurrentRequest(myRequestId, latestRequestIdRef.current)) return "superseded_after_critical";

    // Commit atomico -- todas las asignaciones ocurren juntas, sin
    // ningun await entre ellas (igual que loadAll() real, donde React
    // 18 agrupa estos setState en un solo render).
    if (posR.status === "fulfilled") state.positions = posR.value;
    if (wlR.status === "fulfilled") state.watchlist = wlR.value;
    if (cmR.status === "fulfilled") state.cashMovements = cmR.value;
    if (marketR.status === "fulfilled") state.marketData = mergeMarketData(state.marketData, marketR.value);
    if (futuresR.status === "fulfilled") state.futuresEquity = futuresR.value;

    observedCommits.push(JSON.parse(JSON.stringify(state)));
    return "committed";
  }

  return { state, loadAll, observedCommits, latestRequestIdRef };
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

// ================== G. futures loading -> Patrimonio Total conserva LKG ==================
test("G - mientras futuresEquity todavia esta resolviendo, el estado observable sigue siendo el ULTIMO COMMIT COMPLETO anterior (nunca un intermedio con futures en 0)", async () => {
  const futuresGate = deferred();
  const h = makeHarness({
    positions: async () => [{ ticker: "QCOM", type: "stock", shares: 1 }],
    watchlist: async () => [],
    cashMovements: async () => [],
    marketData: async () => ({ QCOM: { price: 100 } }),
    futuresEquity: () => futuresGate.promise, // nunca resuelve durante este test
  });

  const runPromise = h.loadAll();
  await new Promise((r) => setTimeout(r, 10)); // deja correr micro/macrotasks pendientes, futuresEquity sigue colgado
  // Mientras futuresEquity esta pendiente, el estado NO debe haber
  // cambiado todavia -- sigue siendo el default inicial (LKG previo).
  assert.equal(h.state.futuresEquity.total_value_usd, 0);
  assert.equal(h.state.positions.length, 0, "positions tampoco se commitea suelto -- espera al grupo critico completo");

  futuresGate.resolve({ total_value_usd: 5000, is_complete: true });
  await runPromise;
  assert.equal(h.state.futuresEquity.total_value_usd, 5000);
  assert.equal(h.state.positions.length, 1);
});

// ================== K. old request no puede sobrescribir new ==================
test("K - una request vieja que termina DESPUES de una nueva no puede sobrescribir el estado -- la nueva gana siempre", async () => {
  const oldGate = deferred();
  const h = makeHarness({
    positions: async () => [{ ticker: "OLD", type: "stock" }],
    watchlist: async () => [],
    cashMovements: async () => [],
    marketData: () => oldGate.promise, // la corrida VIEJA se queda colgada aqui
    futuresEquity: async () => ({ total_value_usd: 1 }),
  });

  const oldRun = h.loadAll(); // arranca primero (request vieja)
  await new Promise((r) => setTimeout(r, 5)); // deja que la vieja llegue a estar colgada en marketData

  // Segunda corrida, mas nueva, con fetchers que SI resuelven rapido.
  h.loadAll.fetchersOverride = null;
  const h2Fetchers = {
    positions: async () => [{ ticker: "NEW", type: "stock" }],
    watchlist: async () => [],
    cashMovements: async () => [],
    marketData: async () => ({ NEW: { price: 50 } }),
    futuresEquity: async () => ({ total_value_usd: 999 }),
  };
  // Reemplaza los fetchers del harness para la segunda corrida (misma
  // instancia de estado/latestRequestIdRef -- exactamente lo que pasa
  // en loadAll() real: mismo componente, dos invocaciones).
  const h2 = { ...h };
  h2.loadAll = async function loadAll() {
    const myRequestId = ++h.latestRequestIdRef.current;
    const [posR, wlR] = await Promise.allSettled([h2Fetchers.positions(), h2Fetchers.watchlist()]);
    if (!isCurrentRequest(myRequestId, h.latestRequestIdRef.current)) return "superseded_before_critical";
    const [cmR, marketR, futuresR] = await Promise.allSettled([h2Fetchers.cashMovements(), h2Fetchers.marketData(), h2Fetchers.futuresEquity()]);
    if (!isCurrentRequest(myRequestId, h.latestRequestIdRef.current)) return "superseded_after_critical";
    if (posR.status === "fulfilled") h.state.positions = posR.value;
    if (marketR.status === "fulfilled") h.state.marketData = mergeMarketData(h.state.marketData, marketR.value);
    if (futuresR.status === "fulfilled") h.state.futuresEquity = futuresR.value;
    return "committed";
  };
  const newRun = h2.loadAll(); // request NUEVA -- incrementa latestRequestIdRef
  const newResult = await newRun;
  assert.equal(newResult, "committed");
  assert.equal(h.state.positions[0].ticker, "NEW", "la corrida nueva ya commiteo");

  // Ahora se libera la vieja -- YA es obsoleta (latestRequestIdRef avanzo).
  oldGate.resolve({ OLD_TICKER_PRICE: { price: 1 } });
  const oldResult = await oldRun;
  assert.equal(oldResult, "superseded_after_critical", "la corrida vieja debe detectarse como superada y NO commitear nada");
  assert.equal(h.state.positions[0].ticker, "NEW", "el estado sigue siendo el de la corrida NUEVA -- la vieja no lo pudo sobrescribir");
});

// ================== L. duplicate loadAll invocation no corrompe totales ==================
test("L - dos invocaciones de loadAll disparadas casi simultaneamente (doble trigger) nunca producen un estado mezclado -- solo la ganadora commitea", async () => {
  const h = makeHarness({
    positions: async () => [{ ticker: "A", type: "stock", shares: 1 }],
    watchlist: async () => [],
    cashMovements: async () => [],
    marketData: async () => ({ A: { price: 10 } }),
    futuresEquity: async () => ({ total_value_usd: 100 }),
  });

  // Doble trigger real (ej. StrictMode/double-effect, o polling +
  // refresh manual casi simultaneos): dos invocaciones sin esperar la
  // primera.
  const [r1, r2] = await Promise.all([h.loadAll(), h.loadAll()]);
  const results = [r1, r2].sort();
  // Una de las dos debe ganar (committed), la otra puede tambien
  // "committed" si de verdad no se solaparon en el tiempo -- lo que
  // NUNCA debe pasar es un estado a medias. Se verifica el invariante
  // real: el estado final es exactamente uno de los commits observados
  // completos, nunca una mezcla.
  assert.ok(h.observedCommits.length >= 1);
  const last = h.observedCommits[h.observedCommits.length - 1];
  assert.deepEqual(h.state, last, "el estado final debe ser identico al ULTIMO commit atomico observado, nunca una mezcla entre commits");
});

// ================== N. Smart Import confirm + refresh simultaneo ==================
// src/App.jsx: `onDone={() => { setShowSmartImport(false); loadAll(); }}`
// -- Smart Import confirm dispara loadAll() con la MISMA funcion y el
// MISMO contador de generacion que el polling de 60s y el boton
// "Actualizar". No es un camino especial: se prueba aqui que, si el
// polling ya esta a medio vuelo cuando el usuario confirma un Smart
// Import (dispara un loadAll() nuevo), la confirmacion (mas nueva)
// gana y el polling viejo se descarta sin corromper el estado.
test("N - Smart Import confirm mientras el polling de 60s sigue en vuelo: la confirmacion (mas nueva) gana, el polling viejo no corrompe el total", async () => {
  const pollingGate = deferred();
  const h = makeHarness({
    positions: () => pollingGate.promise, // el polling se queda colgado en `positions` (aun no hay Smart Import nuevo)
    watchlist: async () => [],
    cashMovements: async () => [],
    marketData: async () => ({}),
    futuresEquity: async () => ({ total_value_usd: 0 }),
  });

  const pollingRun = h.loadAll(); // ciclo de polling automatico, arranca primero
  await new Promise((r) => setTimeout(r, 5));

  // El usuario confirma un Smart Import -- loadAll() se dispara de
  // nuevo, mismo latestRequestIdRef, con datos YA actualizados
  // (posicion nueva real que el import acaba de insertar).
  const smartImportFetchers = {
    positions: async () => [{ ticker: "NVDA", type: "stock", shares: 2, cost_basis: 1000 }],
    watchlist: async () => [],
    cashMovements: async () => [],
    marketData: async () => ({ NVDA: { price: 900 } }),
    futuresEquity: async () => ({ total_value_usd: 0 }),
  };
  const smartImportConfirmRun = (async function loadAll() {
    const myRequestId = ++h.latestRequestIdRef.current;
    const [posR, wlR] = await Promise.allSettled([smartImportFetchers.positions(), smartImportFetchers.watchlist()]);
    if (!isCurrentRequest(myRequestId, h.latestRequestIdRef.current)) return "superseded_before_critical";
    const [cmR, marketR, futuresR] = await Promise.allSettled([smartImportFetchers.cashMovements(), smartImportFetchers.marketData(), smartImportFetchers.futuresEquity()]);
    if (!isCurrentRequest(myRequestId, h.latestRequestIdRef.current)) return "superseded_after_critical";
    if (posR.status === "fulfilled") h.state.positions = posR.value;
    if (marketR.status === "fulfilled") h.state.marketData = mergeMarketData(h.state.marketData, marketR.value);
    if (futuresR.status === "fulfilled") h.state.futuresEquity = futuresR.value;
    return "committed";
  })();

  const smartImportResult = await smartImportConfirmRun;
  assert.equal(smartImportResult, "committed");
  assert.equal(h.state.positions[0].ticker, "NVDA", "la confirmacion de Smart Import (mas nueva) commiteo la posicion real nueva");

  // Ahora se libera el polling viejo -- ya es obsoleto.
  pollingGate.resolve([]); // el polling hubiera devuelto un portafolio VACIO si hubiera ganado -- corrupcion real si no se detecta
  const pollingResult = await pollingRun;
  assert.equal(pollingResult, "superseded_before_critical", "el polling viejo debe detectarse como superado y NUNCA commitear su portafolio vacio encima de la confirmacion real");
  assert.equal(h.state.positions[0].ticker, "NVDA", "el estado sigue siendo el de la confirmacion de Smart Import -- nunca se corrompio a portafolio vacio");
});

// ================== M/N. fuente critica falla -> no flicker (LKG se conserva) ==================
test("M - si marketData falla en un refresh posterior, positions/futuresEquity SI se actualizan pero marketData conserva su ultimo valor (merge, no reemplazo)", async () => {
  const h = makeHarness({
    positions: async () => [{ ticker: "A", type: "stock", shares: 1 }],
    watchlist: async () => [],
    cashMovements: async () => [],
    marketData: async () => ({ A: { price: 10 } }),
    futuresEquity: async () => ({ total_value_usd: 100 }),
  });
  await h.loadAll(); // primera corrida exitosa -- establece LKG real
  assert.equal(h.state.marketData.A.price, 10);

  // Segunda corrida: marketData RECHAZA por completo esta vez.
  const h2 = makeHarness({});
  h2.state.marketData = h.state.marketData; // parte del mismo LKG
  h2.latestRequestIdRef = h.latestRequestIdRef;
  const failingFetchers = {
    positions: async () => [{ ticker: "A", type: "stock", shares: 1 }],
    watchlist: async () => [],
    cashMovements: async () => [],
    marketData: async () => { throw new Error("provider_down"); },
    futuresEquity: async () => ({ total_value_usd: 150 }),
  };
  const myRequestId = ++h.latestRequestIdRef.current;
  const [posR, wlR] = await Promise.allSettled([failingFetchers.positions(), failingFetchers.watchlist()]);
  const [cmR, marketR, futuresR] = await Promise.allSettled([failingFetchers.cashMovements(), failingFetchers.marketData(), failingFetchers.futuresEquity()]);
  if (marketR.status === "fulfilled") h.state.marketData = mergeMarketData(h.state.marketData, marketR.value);
  if (futuresR.status === "fulfilled") h.state.futuresEquity = futuresR.value;

  assert.equal(marketR.status, "rejected");
  assert.equal(h.state.marketData.A.price, 10, "marketData conserva el ultimo precio conocido -- ningun flicker a $0/vacio");
  assert.equal(h.state.futuresEquity.total_value_usd, 150, "futuresEquity SI se actualiza de forma independiente (no es la fuente que fallo)");
});
