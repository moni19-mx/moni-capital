// lib/aiPriceCache.js
// Politica de frescura DISTINTA para Moni AI (Architecture v1.1.1, punto 4
// de la revision critica). El dashboard humano sigue sin cachear Nivel A
// (precio) jamas -- esto NO lo toca. Solo las tools de IA pueden reusar un
// quote de hasta 60 segundos si el proveedor en vivo falla, para no
// tumbar toda una respuesta por un timeout puntual de Finnhub/CoinGecko.
//
// Se guarda en la misma tabla market_cache, en columnas separadas
// (ai_price, ai_change_pct, ai_price_updated_at) para no interferir con
// el cache de 6h de Nivel B (rango/market cap) que ya usa esa tabla.

import { getStockData, getCryptoData, COINGECKO_FALLBACK_IDS } from "./prices.js";

const SHORT_CACHE_TTL_MS = 60 * 1000;

async function getShortCache(supabase, ticker) {
  try {
    const { data } = await supabase.from("market_cache").select("ai_price, ai_change_pct, ai_price_updated_at").eq("ticker", ticker).maybeSingle();
    if (!data || data.ai_price == null || !data.ai_price_updated_at) return null;
    const age = Date.now() - new Date(data.ai_price_updated_at).getTime();
    if (age > SHORT_CACHE_TTL_MS) return null;
    return { price: data.ai_price, changePct: data.ai_change_pct, cachedAt: data.ai_price_updated_at };
  } catch (e) {
    return null;
  }
}

async function setShortCache(supabase, ticker, price, changePct) {
  try {
    await supabase.from("market_cache").upsert([{ ticker, ai_price: price, ai_change_pct: changePct, ai_price_updated_at: new Date().toISOString() }], { onConflict: "ticker" });
  } catch (e) {
    // el cache nunca debe tumbar la respuesta principal
  }
}

// Reemplazo de fetchMarketFor para uso de IA: intenta vivo primero, y solo
// si el proveedor en vivo falla, reusa un quote de <=60s. Si no hay nada
// fresco disponible, propaga el fallo -- nunca se inventa un precio.
export async function fetchMarketForAI(supabase, ticker, type, coingeckoId, FINNHUB_KEY) {
  try {
    let market = null, source = null;
    if (type === "stock") { market = await getStockData(supabase, ticker, FINNHUB_KEY); source = "finnhub"; }
    else if (type === "crypto") {
      const id = coingeckoId || COINGECKO_FALLBACK_IDS[ticker];
      if (!id) return { market: null, source: null };
      market = await getCryptoData(supabase, ticker, id); source = "coingecko";
    } else {
      return { market: null, source: null };
    }
    if (market) setShortCache(supabase, ticker, market.price, market.changePct); // fire-and-forget, no await bloqueante
    return { market, source };
  } catch (e) {
    const cached = await getShortCache(supabase, ticker);
    if (cached) {
      return { market: { price: cached.price, changePct: cached.changePct, high: null, low: null, rangeLabel: null }, source: "short_cache", cachedAt: cached.cachedAt };
    }
    return { market: null, source: null, failed: true };
  }
}

// Concurrencia limitada: procesa `items` con `worker` sin disparar mas de
// `limit` llamadas simultaneas. Una posicion que falla no tumba las demas
// -- cada resultado se resuelve independiente (equivalente a
// Promise.allSettled pero con control de cuantas corren a la vez).
export async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function runNext() {
    const i = nextIndex++;
    if (i >= items.length) return;
    try {
      results[i] = await worker(items[i], i);
    } catch (e) {
      results[i] = undefined; // el worker debe manejar sus propios errores; esto es solo un resguardo
    }
    return runNext();
  }

  const workers = Array.from({ length: Math.min(limit, items.length) }, () => runNext());
  await Promise.all(workers);
  return results;
}
