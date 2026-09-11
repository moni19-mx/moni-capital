import test from "node:test";
import assert from "node:assert/strict";
import { sbSelectAll, fetchMarketDataBatch, fetchFuturesEquity, fetchMarketPulse } from "../lib/dataFetchers.js";

function mockFetchOnce({ ok, status = 200, json }) {
  const calls = [];
  global.fetch = async (url, opts) => {
    calls.push({ url, opts });
    return { ok, status, json: async () => json };
  };
  return calls;
}

function mockFetchThrows(err) {
  global.fetch = async () => { throw err; };
}

test.afterEach(() => { delete global.fetch; });

// ================== sbSelectAll ==================
test("sbSelectAll: exito -> devuelve el JSON tal cual", async () => {
  mockFetchOnce({ ok: true, json: [{ id: 1 }] });
  const data = await sbSelectAll("https://x.supabase.co", "anon-key", "positions");
  assert.deepEqual(data, [{ id: 1 }]);
});

test("sbSelectAll: HTTP no-ok -> rechaza (nunca devuelve [] en silencio)", async () => {
  mockFetchOnce({ ok: false, status: 500, json: {} });
  await assert.rejects(() => sbSelectAll("https://x.supabase.co", "anon-key", "cash_movements"));
});

test("sbSelectAll: fallo de red -> rechaza (nunca devuelve [] en silencio)", async () => {
  mockFetchThrows(new Error("network down"));
  await assert.rejects(() => sbSelectAll("https://x.supabase.co", "anon-key", "watchlist"));
});

// ================== fetchFuturesEquity -- el caso critico del bug ==================
test("fetchFuturesEquity: exito -> devuelve el payload real", async () => {
  const payload = { total_value_usd: 4338.66, is_complete: true, accounts: [], positions: [], warnings: [] };
  mockFetchOnce({ ok: true, json: payload });
  const data = await fetchFuturesEquity();
  assert.equal(data.total_value_usd, 4338.66);
});

test("E (causa raiz) - fetchFuturesEquity: HTTP 500 -> RECHAZA, ya NUNCA devuelve {total_value_usd:0,...} como si fuera exito", async () => {
  mockFetchOnce({ ok: false, status: 500, json: {} });
  await assert.rejects(
    () => fetchFuturesEquity(),
    (err) => {
      assert.match(err.message, /futures_equity_http_500/);
      return true;
    }
  );
});

test("E2 (causa raiz) - fetchFuturesEquity: fallo de red -> RECHAZA, ya NUNCA devuelve {total_value_usd:0,...} como si fuera exito", async () => {
  mockFetchThrows(new Error("fetch failed"));
  await assert.rejects(() => fetchFuturesEquity());
});

// ================== fetchMarketPulse ==================
test("fetchMarketPulse: HTTP no-ok -> rechaza (antes devolvia null, borrando el pulse anterior en pantalla)", async () => {
  mockFetchOnce({ ok: false, status: 503, json: {} });
  await assert.rejects(() => fetchMarketPulse());
});

// ================== fetchMarketDataBatch ==================
test("fetchMarketDataBatch: items vacio -> resuelve sin llamar a fetch", async () => {
  let called = false;
  global.fetch = async () => { called = true; return { ok: true, json: async () => ({}) }; };
  const r = await fetchMarketDataBatch([]);
  assert.equal(called, false);
  assert.deepEqual(r, { data: {}, errors: [], updatedAt: null });
});

test("fetchMarketDataBatch: HTTP no-ok -> rechaza (nunca deja precios en un estado a medias silencioso)", async () => {
  mockFetchOnce({ ok: false, status: 500, json: {} });
  await assert.rejects(() => fetchMarketDataBatch([{ ticker: "BTC", type: "crypto" }]));
});
