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

import { computeTtlMs, isCacheFresh, isWithinMaxStaleAge, isBreakerTripped, tripBreaker } from "./priceCache.js";

function cacheSnapshot(cachedRow) {
  return {
    price: cachedRow.ai_price, changePct: cachedRow.ai_change_pct,
    high: cachedRow.high ?? null, low: cachedRow.low ?? null,
    marketCap: cachedRow.market_cap ?? null, peRatio: cachedRow.pe_ratio ?? null,
    fetchedAt: cachedRow.ai_price_updated_at,
  };
}

// LKG CONTRACT (Price Truth POST-review): un solo lugar que decide el
// fallback cuando no hay precio fresco/vivo disponible, para que las 4
// llamadas de abajo (breaker-ya-tripped, rate_limited, auth_error,
// error generico) apliquen EXACTAMENTE la misma regla, sin
// divergencias accidentales:
//   - LKG usable (existe Y no excede MAX_STALE_AGE)  -> se USA, status
//     STALE/STALE_RATE_LIMITED segun corresponda.
//   - LKG existe pero excede MAX_STALE_AGE -> DATA_UNAVAILABLE,
//     reason="exceeded_max_stale_age" (nunca se confunde con "nunca
//     hubo cache").
//   - No existe LKG -> DATA_UNAVAILABLE con el motivo real del fallo.
// Nunca: "provider fail + LKG usable" -> DATA_UNAVAILABLE (el bug real
// reportado por el usuario).
function staleFallback({ cachedRow, hasStaleCache, hasUsableStaleCache, statusIfUsable, reasonIfUsable }) {
  if (hasUsableStaleCache) {
    const snap = cacheSnapshot(cachedRow);
    return { status: statusIfUsable, source: "cache_stale", ...snap, reason: reasonIfUsable };
  }
  if (hasStaleCache) {
    return { status: "DATA_UNAVAILABLE", price: null, reason: "exceeded_max_stale_age" };
  }
  return { status: "DATA_UNAVAILABLE", price: null, reason: reasonIfUsable };
}

// item: {ticker, type, coingeckoId, priority}. `priority` es
// "position" (default) o "watchlist" -- P0.4 item 3, ver
// lib/priceCache.js::computeTtlMs. cachedRow: fila real de
// market_cache para este ticker, o null/undefined. now: Date real (o
// fijo en tests). breaker: breaker DEL PROVEEDOR de este item
// especificamente (ver lib/priceCache.js -- Price Truth POST-review:
// Finnhub y CoinGecko usan breakers INDEPENDIENTES, el llamador es
// quien selecciona cual pasar segun item.type). fetchLive:
// () => Promise<{price, changePct, high, low, marketCap, peRatio}>.
export async function resolveTickerPrice({ item, cachedRow, now, breaker, fetchLive }) {
  const ttlMs = computeTtlMs(item.type, now, item.priority || "position");
  const hasCache = !!cachedRow && cachedRow.ai_price != null && cachedRow.ai_price_updated_at;
  const hasFreshCache = hasCache && isCacheFresh(cachedRow.ai_price_updated_at, now, ttlMs);
  const hasStaleCache = hasCache && !hasFreshCache;
  const hasUsableStaleCache = hasStaleCache && isWithinMaxStaleAge(cachedRow.ai_price_updated_at, now);
  const providerName = item.type === "crypto" ? "coingecko" : "finnhub";

  if (hasFreshCache) {
    const snap = cacheSnapshot(cachedRow);
    return { status: "CACHED", source: `${providerName}_cache`, live_attempted: false, ...snap };
  }

  if (isBreakerTripped(breaker)) {
    return { ...staleFallback({
      cachedRow, hasStaleCache, hasUsableStaleCache,
      statusIfUsable: "STALE_RATE_LIMITED", reasonIfUsable: "rate_limit_cooldown_active",
    }), live_attempted: false };
  }

  try {
    const live = await fetchLive();
    return {
      status: "LIVE", source: providerName, price: live.price, changePct: live.changePct,
      high: live.high, low: live.low, marketCap: live.marketCap, peRatio: live.peRatio,
      fetchedAt: now.toISOString(), live_attempted: true,
    };
  } catch (e) {
    if (e && e.rateLimited) {
      tripBreaker(breaker, now);
      return { ...staleFallback({ cachedRow, hasStaleCache, hasUsableStaleCache, statusIfUsable: "STALE_RATE_LIMITED", reasonIfUsable: "rate_limited" }), live_attempted: true, live_error: String(e?.message || e) };
    }
    if (e && e.authError) {
      return { ...staleFallback({ cachedRow, hasStaleCache, hasUsableStaleCache, statusIfUsable: "STALE", reasonIfUsable: "auth_error" }), live_attempted: true, live_error: String(e?.message || e) };
    }
    return { ...staleFallback({ cachedRow, hasStaleCache, hasUsableStaleCache, statusIfUsable: "STALE", reasonIfUsable: String(e?.message || e) }), live_attempted: true, live_error: String(e?.message || e) };
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

// Price Truth POST-review: breaker por proveedor (item real reportado
// por el usuario -- un 429 de CoinGecko no debe cortar Finnhub y
// viceversa, ver lib/priceCache.js). El llamador (api/market-data.js /
// api/fmp-benchmark-temp.js) etiqueta cada `result.provider` segun
// item.type ANTES de llamar esta funcion -- reusa summarizeProviderHealth
// 3 veces (finnhub/coingecko/agregado), CERO logica nueva duplicada.
export function summarizeProviderHealthDetailed(results, breakers) {
  const finnhubResults = results.filter((r) => r.provider === "finnhub");
  const coingeckoResults = results.filter((r) => r.provider === "coingecko");
  // Agregado: RATE_LIMITED si CUALQUIERA de los dos breakers esta
  // activo -- un objeto sintetico basta, isBreakerTripped solo lee
  // `.tripped`.
  const aggregateBreaker = { tripped: isBreakerTripped(breakers.finnhub) || isBreakerTripped(breakers.coingecko) };
  return {
    finnhub_status: summarizeProviderHealth(finnhubResults, breakers.finnhub),
    coingecko_status: summarizeProviderHealth(coingeckoResults, breakers.coingecko),
    aggregate: summarizeProviderHealth(results, aggregateBreaker),
  };
}
