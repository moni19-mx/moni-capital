// tests/assetResolver.test.js
// Sprint P1 (Universal Asset Detail) -- tests de resolveAssetIdentity,
// el resolver PURO centralizado en App.jsx::openAsset(). Cero red, cero
// Supabase (esas funciones -- resolveAsset/resolveAssetById/createAsset
// -- son server-side y ya viven probadas indirectamente via api/manage.js;
// este archivo cubre solo la mitad cliente nueva de este sprint).

import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveAssetIdentity } from "../lib/assetResolver.js";

const POSITIONS = [
  { ticker: "AAPL", type: "stock", name: "Apple Inc.", coingecko_id: null },
  { ticker: "ETH", type: "crypto", name: "Ethereum", coingecko_id: "ethereum" },
];
const WATCHLIST = [
  { ticker: "CRCL", type: "stock", name: "Circle Internet Group", coingecko_id: null },
];

test("A - ticker propio (owned): caller ya trae type/name -> CALLER_TRUSTED, sin tocar positions/watchlist", () => {
  const result = resolveAssetIdentity({
    callerMeta: { ticker: "AAPL", type: "stock", name: "Apple Inc.", coingeckoId: null },
    positions: POSITIONS, watchlist: WATCHLIST,
  });
  assert.deepEqual(result, { ticker: "AAPL", type: "stock", name: "Apple Inc.", coingeckoId: null, resolved: true, source: "CALLER_TRUSTED" });
});

test("B - ticker solo en watchlist, caller NO trae type (shape Decisions/{ticker}) -> cae a WATCHLIST, nunca se pierde", () => {
  const result = resolveAssetIdentity({
    callerMeta: { ticker: "CRCL" },
    positions: POSITIONS, watchlist: WATCHLIST,
  });
  assert.equal(result.type, "stock");
  assert.equal(result.source, "WATCHLIST");
  assert.equal(result.resolved, true);
  assert.equal(result.name, "Circle Internet Group");
});

test("C - ticker de Discover/busqueda con metadata propia (type+name ya resueltos por /api/search) -> CALLER_TRUSTED", () => {
  const result = resolveAssetIdentity({
    callerMeta: { ticker: "NVDA", type: "stock", name: "NVIDIA Corp", coingeckoId: null },
    positions: [], watchlist: [],
  });
  assert.equal(result.source, "CALLER_TRUSTED");
  assert.equal(result.type, "stock");
});

test("D - shape exacto real del bug de Decisions ({ ticker: d.ticker }, sin type/name) sobre una posicion real -> se resuelve via POSITION, nunca crashea ni pide market-data con type undefined", () => {
  const result = resolveAssetIdentity({
    callerMeta: { ticker: "ETH" },
    positions: POSITIONS, watchlist: WATCHLIST,
  });
  assert.equal(result.type, "crypto");
  assert.equal(result.source, "POSITION");
  assert.equal(result.coingeckoId, "ethereum");
});

test("E - ticker externo totalmente desconocido (no owned, no watchlist, sin metadata del caller) -> UNRESOLVED, type:null, NUNCA inventado", () => {
  const result = resolveAssetIdentity({
    callerMeta: { ticker: "XYZQ" },
    positions: POSITIONS, watchlist: WATCHLIST,
  });
  assert.deepEqual(result, { ticker: "XYZQ", type: null, name: "XYZQ", coingeckoId: null, resolved: false, source: "UNRESOLVED" });
});

test("F - precedencia: caller trusted (A) gana aunque el ticker tambien exista en positions con otro type -- el caller es la fuente mas confiable declarada", () => {
  const result = resolveAssetIdentity({
    callerMeta: { ticker: "AAPL", type: "stock", name: "Apple Inc. (override)" },
    positions: POSITIONS, watchlist: WATCHLIST,
  });
  assert.equal(result.source, "CALLER_TRUSTED");
  assert.equal(result.name, "Apple Inc. (override)");
});

test("G - precedencia: sin caller trust, canonicalAssetsByTicker (B) gana sobre positions/watchlist (C) cuando esta presente", () => {
  const result = resolveAssetIdentity({
    callerMeta: { ticker: "CRCL" },
    positions: POSITIONS, watchlist: WATCHLIST,
    canonicalAssetsByTicker: { CRCL: { type: "stock", name: "Circle (canonico)", coingeckoId: null } },
  });
  assert.equal(result.source, "CANONICAL_LOCAL");
  assert.equal(result.name, "Circle (canonico)");
});

test("H - precedencia: sin caller trust y sin canonical -- positions (C) gana sobre watchlist si el ticker esta en ambos", () => {
  const bothPositions = [{ ticker: "DUAL", type: "stock", name: "En posicion", coingecko_id: null }];
  const bothWatchlist = [{ ticker: "DUAL", type: "crypto", name: "En watchlist", coingecko_id: null }];
  const result = resolveAssetIdentity({ callerMeta: { ticker: "DUAL" }, positions: bothPositions, watchlist: bothWatchlist });
  assert.equal(result.source, "POSITION");
  assert.equal(result.type, "stock");
});

test("I - canonicalAssetsByTicker ausente (caso real de este sprint -- App.jsx no carga catalogo todavia) -> nunca explota, cae limpio a C/D", () => {
  const result = resolveAssetIdentity({ callerMeta: { ticker: "AAPL" }, positions: POSITIONS, watchlist: WATCHLIST });
  assert.equal(result.source, "POSITION");
});

test("J - ticker vacio/whitespace -> UNRESOLVED sin crashear, nunca revienta sobre callerMeta null", () => {
  assert.deepEqual(
    resolveAssetIdentity({ callerMeta: { ticker: "   " }, positions: POSITIONS, watchlist: WATCHLIST }),
    { ticker: null, type: null, name: null, coingeckoId: null, resolved: false, source: "UNRESOLVED" }
  );
  assert.deepEqual(resolveAssetIdentity({}), { ticker: null, type: null, name: null, coingeckoId: null, resolved: false, source: "UNRESOLVED" });
});

test("K - ticker se normaliza (lowercase input, ej. de una URL o input manual) -> matchea la fila real en mayusculas", () => {
  const result = resolveAssetIdentity({ callerMeta: { ticker: "aapl" }, positions: POSITIONS, watchlist: WATCHLIST });
  assert.equal(result.ticker, "AAPL");
  assert.equal(result.source, "POSITION");
});

test("L - nunca auto-crea nada: resolveAssetIdentity no toca Supabase ni retorna ninguna senal de escritura -- solo lectura de lo ya cargado en memoria", () => {
  const result = resolveAssetIdentity({ callerMeta: { ticker: "NEWTICKER" }, positions: [], watchlist: [] });
  assert.equal(result.resolved, false);
  assert.equal(result.type, null);
  assert.equal(Object.prototype.hasOwnProperty.call(result, "created"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(result, "asset_id"), false);
});

test("M - nunca adivina type: un match en positions/watchlist con type null/undefined en la fila NO cuenta como resuelto, sigue cayendo a D (mismo caso real que motivo el fix de asset_type en `assets` este sprint)", () => {
  const positionsWithNullType = [{ ticker: "TSM", type: null, name: "TSMC", coingecko_id: null }];
  const result = resolveAssetIdentity({ callerMeta: { ticker: "TSM" }, positions: positionsWithNullType, watchlist: [] });
  assert.equal(result.type, null);
  assert.equal(result.source, "UNRESOLVED");
});
