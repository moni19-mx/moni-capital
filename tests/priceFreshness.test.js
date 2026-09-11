// tests/priceFreshness.test.js
// Micro-sprint P0.4 (Price Freshness + Request Volume Hardening). Tests
// A-N sobre lib/financialSnapshot.js::summarizeGlobalFreshness,
// lib/priceCache.js (nueva cadencia TTL=90s + WATCHLIST_TTL_MS) y
// lib/financialSnapshot.js::buildMarketDataItems (priority por
// position/watchlist). CERO red, CERO Supabase real.
//
// Nota honesta sobre cobertura: PriceFreshnessDot/freshnessStatusText
// (src/App.jsx) son mapeos DIRECTOS y sin logica propia del status que
// summarizeGlobalFreshness ya calcula (misma convencion que P0.2/P0.3:
// la logica de DECISION vive en lib/, testeada aqui sin navegador; la
// presentacion en App.jsx es un mapeo 1:1 verificado por lectura de
// codigo + build, no por un test de React).

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  enrichPositions, computeStocksValue, computeCryptoValue,
  buildMarketDataItems, summarizeGlobalFreshness,
} from "../lib/financialSnapshot.js";
import {
  MARKET_OPEN_TTL_MS, MARKET_CLOSED_TTL_MS, CRYPTO_TTL_MS, WATCHLIST_TTL_MS,
  computeTtlMs, createRateLimitBreaker, tripBreaker,
} from "../lib/priceCache.js";
import { resolveTickerPrice } from "../lib/marketDataOrchestrator.js";

const NOW = new Date("2026-09-09T15:00:00Z"); // martes 11am ET, mercado abierto

function pos(ticker, status, value = 100) {
  return { ticker, type: "stock", value, market: { price_status: status } };
}

// ================== A/B. LIVE / CACHED fresco -> sin warning ==================
test("A - todas LIVE -> status ALL_GOOD, sin warning", () => {
  const f = summarizeGlobalFreshness([pos("AAPL", "LIVE"), pos("MSFT", "LIVE")], "OK");
  assert.equal(f.status, "ALL_GOOD");
  assert.equal(f.staleCount, 0);
});

test("B - todas CACHED (fresco, dentro de TTL) -> status ALL_GOOD, CACHED nunca cuenta como warning", () => {
  const f = summarizeGlobalFreshness([pos("AAPL", "CACHED"), pos("MSFT", "CACHED")], "OK");
  assert.equal(f.status, "ALL_GOOD");
  assert.equal(f.staleCount, 0, "REGRESION: CACHED dentro de TTL no es degradacion, item 7 del sprint");
});

// ================== C. STALE -> warning ==================
test("C - una posicion STALE -> status PARTIAL_STALE, staleCount=1", () => {
  const f = summarizeGlobalFreshness([pos("AAPL", "LIVE"), pos("MSFT", "STALE")], "OK");
  assert.equal(f.status, "PARTIAL_STALE");
  assert.equal(f.staleCount, 1);
  assert.deepEqual(f.staleTickers, ["MSFT"]);
});

// ================== D. STALE_RATE_LIMITED -> warning + provider health ==================
test("D - una posicion STALE_RATE_LIMITED -> status PROVIDER_RATE_LIMITED (mas grave que PARTIAL_STALE)", () => {
  const f = summarizeGlobalFreshness([pos("AAPL", "LIVE"), pos("MSFT", "STALE_RATE_LIMITED")], "OK");
  assert.equal(f.status, "PROVIDER_RATE_LIMITED");
  assert.deepEqual(f.rateLimitedTickers, ["MSFT"]);
});

test("D2 - provider_health='RATE_LIMITED' del batch completo activa PROVIDER_RATE_LIMITED aunque ninguna posicion individual este STALE_RATE_LIMITED", () => {
  const f = summarizeGlobalFreshness([pos("AAPL", "LIVE")], "RATE_LIMITED");
  assert.equal(f.status, "PROVIDER_RATE_LIMITED");
});

// ================== E. DATA_UNAVAILABLE nunca es 0 ==================
test("E - posicion sin market data (value=null) -> nunca se confunde con value=0, cuenta como missing", () => {
  const positions = [{ ticker: "X", type: "stock", shares: 5, cost_basis: 100 }];
  const [enriched] = enrichPositions(positions, {}, {});
  assert.equal(enriched.value, null);
  assert.notEqual(enriched.value, 0);
  const f = summarizeGlobalFreshness([enriched], "OK");
  assert.equal(f.status, "PARTIAL_MISSING");
  assert.equal(f.missingCount, 1);
});

// ================== F. mixed live+stale -> patrimonio usa ambos correctamente ==================
test("F - Total Acciones suma correctamente una mezcla de posiciones LIVE y STALE -- ambas tienen .price real, la formula no distingue status", () => {
  const positions = [
    { ticker: "AAPL", type: "stock", shares: 2, cost_basis: 100 },
    { ticker: "MSFT", type: "stock", shares: 1, cost_basis: 100 },
  ];
  const marketData = {
    AAPL: { price: 200, price_status: "LIVE" },
    MSFT: { price: 300, price_status: "STALE" }, // ultimo precio conocido, sirve igual para el total
  };
  const enriched = enrichPositions(positions, marketData, {});
  assert.equal(computeStocksValue(enriched), 700, "400 (AAPL live) + 300 (MSFT stale, LKG) = 700");
});

// ================== G. missing component marca valuation partial ==================
test("G - un componente sin valuar entre varios -> PARTIAL_MISSING aunque el resto tenga precio", () => {
  const positions = [
    { ticker: "AAPL", type: "stock", shares: 2, cost_basis: 100 },
    { ticker: "ZZZ", type: "stock", shares: 1, cost_basis: 50 },
  ];
  const marketData = { AAPL: { price: 200, price_status: "LIVE" } }; // ZZZ nunca llego (DATA_UNAVAILABLE en el batch)
  const enriched = enrichPositions(positions, marketData, {});
  const f = summarizeGlobalFreshness(enriched, "PARTIAL");
  assert.equal(f.status, "PARTIAL_MISSING");
  assert.deepEqual(f.missingTickers, ["ZZZ"]);
  // Y el total SOLO incluye lo valuado -- nunca 0 para ZZZ, simplemente excluido (comportamiento previo, sin cambios):
  assert.equal(computeStocksValue(enriched), 400);
});

// ================== H. status global: severidad correcta en las 4 combinaciones ==================
test("H - severidad: PROVIDER_RATE_LIMITED > PARTIAL_MISSING > PARTIAL_STALE > ALL_GOOD", () => {
  assert.equal(summarizeGlobalFreshness([], "OK").status, "ALL_GOOD");
  assert.equal(summarizeGlobalFreshness([pos("A", "STALE")], "OK").status, "PARTIAL_STALE");
  assert.equal(summarizeGlobalFreshness([{ ticker: "A", type: "stock", value: null }], "OK").status, "PARTIAL_MISSING");
  // missing + stale a la vez -> gana missing (mas grave, ver comentario en la funcion)
  assert.equal(
    summarizeGlobalFreshness([pos("A", "STALE"), { ticker: "B", type: "stock", value: null }], "OK").status,
    "PARTIAL_MISSING"
  );
  // rate-limited siempre gana sobre cualquier otra combinacion
  assert.equal(
    summarizeGlobalFreshness([pos("A", "STALE_RATE_LIMITED"), { ticker: "B", type: "stock", value: null }], "OK").status,
    "PROVIDER_RATE_LIMITED"
  );
});

// ================== I. nueva cadencia TTL ==================
test("I - TTL de mercado-abierto y cripto suben a 90s (decision B-ajustada confirmada por el usuario), fuera de horario sin cambios", () => {
  assert.equal(MARKET_OPEN_TTL_MS, 90 * 1000);
  assert.equal(CRYPTO_TTL_MS, 90 * 1000);
  assert.equal(MARKET_CLOSED_TTL_MS, 15 * 60 * 1000, "sin cambios -- 15min fuera de horario sigue igual");
  assert.equal(WATCHLIST_TTL_MS, 5 * 60 * 1000);
});

test("I2 - computeTtlMs(stock, mercado abierto, position) = 90s; computeTtlMs(crypto, cualquier hora, position) = 90s", () => {
  assert.equal(computeTtlMs("stock", NOW, "position"), 90000);
  assert.equal(computeTtlMs("crypto", NOW, "position"), 90000);
});

// ================== J. watchlist-only no fuerza cadencia de position ==================
test("J - computeTtlMs con priority='watchlist' usa 5min SIEMPRE, incluso en horario de mercado (nunca la cadencia corta de una position real)", () => {
  assert.equal(computeTtlMs("stock", NOW, "watchlist"), WATCHLIST_TTL_MS);
  assert.equal(computeTtlMs("crypto", NOW, "watchlist"), WATCHLIST_TTL_MS);
});

test("J2 - buildMarketDataItems: position tiene prioridad sobre watchlist para un ticker en ambos -- nunca se degrada la frescura de algo que si es tuyo", () => {
  const positions = [{ ticker: "TSM", type: "stock" }];
  const watchlist = [{ ticker: "TSM", type: "stock" }, { ticker: "ASML.AS", type: "stock" }];
  const items = buildMarketDataItems(positions, watchlist);
  const tsm = items.find((i) => i.ticker === "TSM");
  const asml = items.find((i) => i.ticker === "ASML.AS");
  assert.equal(items.length, 2, "TSM se dedupea, no aparece 2 veces");
  assert.equal(tsm.priority, "position");
  assert.equal(asml.priority, "watchlist");
});

// ================== K. manual refresh dentro del nuevo TTL no golpea al proveedor ==================
test("K - dos resoluciones con 60s de diferencia (dentro del NUEVO TTL de 90s, hubiera sido MISS con el TTL viejo de 30s) -> la segunda sirve CACHED, cero llamada live extra", async () => {
  let liveCalls = 0;
  const fetchLive = async () => { liveCalls++; return { price: 300, changePct: 1, high: null, low: null, marketCap: null, peRatio: null }; };
  const breaker = createRateLimitBreaker();
  const first = await resolveTickerPrice({ item: { ticker: "AAPL", type: "stock", priority: "position" }, cachedRow: null, now: NOW, breaker, fetchLive });
  assert.equal(first.status, "LIVE");
  const cachedRow = { ticker: "AAPL", ai_price: first.price, ai_change_pct: 1, ai_price_updated_at: first.fetchedAt, high: null, low: null, market_cap: null, pe_ratio: null };
  const secondNow = new Date(NOW.getTime() + 60000); // 60s despues: STALE con TTL viejo (30s), CACHED con el nuevo (90s)
  const second = await resolveTickerPrice({ item: { ticker: "AAPL", type: "stock", priority: "position" }, cachedRow, now: secondNow, breaker, fetchLive });
  assert.equal(second.status, "CACHED", "REGRESION: con TTL=90s, un refresh a los 60s debe servir cache, no volver a pedir al proveedor");
  assert.equal(liveCalls, 1, "solo 1 llamada live real en las 2 resoluciones");
});

// ================== L. circuit breaker sigue funcionando (tambien para watchlist) ==================
test("L - breaker activado corta llamadas live tanto para position como para watchlist -- la prioridad no bypassa el circuit breaker", async () => {
  const breaker = createRateLimitBreaker();
  tripBreaker(breaker, NOW);
  let liveCalled = false;
  const fetchLive = async () => { liveCalled = true; return { price: 999 }; };
  const result = await resolveTickerPrice({ item: { ticker: "ASML.AS", type: "stock", priority: "watchlist" }, cachedRow: null, now: NOW, breaker, fetchLive });
  assert.equal(liveCalled, false);
  assert.equal(result.status, "DATA_UNAVAILABLE");
});

// ================== N. formula financiera identica (sin cambios de P0.4) ==================
test("N - P0.4 no cambia ninguna formula financiera: mismo precio -> mismo Total Acciones/Cripto sin importar priority/TTL/status", () => {
  const positions = [
    { ticker: "AAPL", type: "stock", shares: 3, cost_basis: 100 },
    { ticker: "BTC", type: "crypto", shares: 0.5, cost_basis: 1000 },
  ];
  const marketData = {
    AAPL: { price: 200, price_status: "CACHED", price_source: "finnhub_cache" },
    BTC: { price: 60000, price_status: "LIVE", price_source: "coingecko" },
  };
  const enriched = enrichPositions(positions, marketData, {});
  assert.equal(computeStocksValue(enriched), 600);
  assert.equal(computeCryptoValue(enriched), 30000);
});
