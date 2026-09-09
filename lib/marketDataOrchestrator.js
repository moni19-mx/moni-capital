// lib/marketDataOrchestrator.js
// Micro-sprint P0.3 (Market Price Cache + Provider Resilience). Decide
// que hacer con UN ticker (servir cache fresco / intentar vivo / usar
// STALE / DATA_UNAVAILABLE) -- PURO en el sentido de que nunca toca
// Supabase ni hace fetch el mismo: `cachedRow` ya viene leido y
// `fetchLive` es la funcion real (getStockData/getCryptoData de
// lib/prices.js) inyectada, para poder testear la politica completa
// con un mock, sin red. api/market-data.js hace las lecturas/escrituras
// reales y le pasa el resultado real.
//
// CERO reimplementacion de la formula de precio -- fetchLive() SIGUE
// siendo la misma funcion real de lib/prices.js.

import { computeTtlMs, isCacheFresh, isBreakerTripped, tripBreaker } from "./priceCache.js";

function cacheSnapshot(cachedRow) {
  return {
    price: cachedRow.ai_price, changePct: cachedRow.ai_change_pct,
    high: cachedRow.high ?? null, low: cachedRow.low ?? null,
    marketCap: cachedRow.market_cap ?? null, peRatio: cachedRow.pe_ratio ?? null,
    fetchedAt: cachedRow.ai_price_updated_at,
  };
}

// item: {ticker, type, coingeckoId, priority}. `priority` es
// "position" (default) o "watchlist" -- P0.4 item 3, ver
// lib/priceCache.js::computeTtlMs. cachedRow: fila real de
// market_cache para este ticker, o null/undefined. now: Date real (o
// fijo en tests). breaker: lib/priceCache.js::createRateLimitBreaker(),
// COMPARTIDO entre todos los tickers de la misma corrida. fetchLive:
// () => Promise<{price, changePct, high, low, marketCap, peRatio}>.
export async function resolveTickerPrice({ item, cachedRow, now, breaker, fetchLive }) {
  const ttlMs = computeTtlMs(item.type, now, item.priority || "position");
  const hasCache = !!cachedRow && cachedRow.ai_price != null && cachedRow.ai_price_updated_at;
  const hasFreshCache = hasCache && isCacheFresh(cachedRow.ai_price_updated_at, now, ttlMs);
  const hasStaleCache = hasCache && !hasFreshCache;
  const providerName = item.type === "crypto" ? "coingecko" : "finnhub";

  if (hasFreshCache) {
    const snap = cacheSnapshot(cachedRow);
    return { status: "CACHED", source: `${providerName}_cache`, ...snap };
  }

  if (isBreakerTripped(breaker)) {
    if (hasStaleCache) {
      const snap = cacheSnapshot(cachedRow);
      return { status: "STALE_RATE_LIMITED", source: "cache_stale", ...snap, reason: "rate_limit_cooldown_active" };
    }
    return { status: "DATA_UNAVAILABLE", price: null, reason: "rate_limit_cooldown_active" };
  }

  try {
    const live = await fetchLive();
    return {
      status: "LIVE", source: providerName, price: live.price, changePct: live.changePct,
      high: live.high, low: live.low, marketCap: live.marketCap, peRatio: live.peRatio,
      fetchedAt: now.toISOString(),
    };
  } catch (e) {
    if (e && e.rateLimited) {
      tripBreaker(breaker, now);
      if (hasStaleCache) {
        const snap = cacheSnapshot(cachedRow);
        return { status: "STALE_RATE_LIMITED", source: "cache_stale", ...snap, reason: "rate_limited" };
      }
      return { status: "DATA_UNAVAILABLE", price: null, reason: "rate_limited" };
    }
    if (e && e.authError) {
      if (hasStaleCache) {
        const snap = cacheSnapshot(cachedRow);
        return { status: "STALE", source: "cache_stale", ...snap, reason: "auth_error" };
      }
      return { status: "DATA_UNAVAILABLE", price: null, reason: "auth_error" };
    }
    if (hasStaleCache) {
      const snap = cacheSnapshot(cachedRow);
      return { status: "STALE", source: "cache_stale", ...snap, reason: String(e?.message || e) };
    }
    return { status: "DATA_UNAVAILABLE", price: null, reason: String(e?.message || e) };
  }
}

// Resumen de salud del proveedor para TODA la corrida, a partir de los
// resultados individuales ya resueltos -- nunca inventa un estado, solo
// tabula lo que realmente paso.
export function summarizeProviderHealth(results, breaker) {
  const total = results.length;
  if (total === 0) return "OK";
  const authErrors = results.filter((r) => r.reason === "auth_error").length;
  if (authErrors === total) return "AUTH_ERROR";
  if (isBreakerTripped(breaker)) return "RATE_LIMITED";
  const unavailable = results.filter((r) => r.status === "DATA_UNAVAILABLE").length;
  if (unavailable === total) return "PROVIDER_ERROR";
  if (unavailable > 0) return "PARTIAL";
  return "OK";
}
