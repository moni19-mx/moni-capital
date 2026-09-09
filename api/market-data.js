// api/market-data.js
// Micro-sprint P0.3 (Market Price Cache + Provider Resilience). Cache-first
// con circuit breaker -- ver lib/priceCache.js y
// lib/marketDataOrchestrator.js para la politica completa (pura,
// testeada aparte). Este archivo solo hace la I/O real: lee
// market_cache en un solo batch, llama getStockData/getCryptoData
// (SIN cambios de formula) cuando corresponde, y escribe de vuelta.
//
// CONTRATO SIN CAMBIOS para el llamador (src/App.jsx): data[ticker]
// sigue siendo {price, changePct, high, low, rangeLabel, marketCap,
// peRatio}, ahora con price_status/price_source/price_fetched_at
// agregados (aditivo, nunca rompe enrichPositions -- ver
// lib/financialSnapshot.js, que solo lee `.price`).
import { createClient } from "@supabase/supabase-js";
import { getStockData, getCryptoData, COINGECKO_FALLBACK_IDS } from "../lib/prices.js";
import { mapWithConcurrency } from "../lib/aiPriceCache.js";
import { createRateLimitBreaker } from "../lib/priceCache.js";
import { resolveTickerPrice, summarizeProviderHealth } from "../lib/marketDataOrchestrator.js";

const supabase = createClient(
  process.env.VITE_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const CONCURRENCY = 6; // mismo limite que usa Moni AI (aiTools.js) -- una sola politica de concurrencia

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "method_not_allowed" });
  }

  try {
    const { items } = req.body || {};
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(200).json({ data: {}, errors: [], updatedAt: new Date().toISOString(), provider_health: "OK" });
    }

    const FINNHUB_KEY = process.env.FINNHUB_API_KEY;
    const now = new Date();

    // Un solo batch read para TODOS los tickers pedidos -- evita N
    // queries individuales (misma columna reusada de
    // lib/aiPriceCache.js: ai_price/ai_change_pct/ai_price_updated_at,
    // mas high/low/market_cap/pe_ratio del cache de 6h ya existente).
    const tickers = [...new Set(items.map((i) => i.ticker))];
    const { data: cachedRows } = await supabase
      .from("market_cache")
      .select("ticker, ai_price, ai_change_pct, ai_price_updated_at, high, low, market_cap, pe_ratio")
      .in("ticker", tickers);
    const cacheByTicker = {};
    (cachedRows || []).forEach((r) => { cacheByTicker[r.ticker] = r; });

    const data = {};
    const errors = [];
    const results = [];
    // UN breaker compartido por TODA la corrida -- si Finnhub responde
    // 429 para un ticker, los tickers restantes de este mismo batch
    // dejan de intentar vivo (van directo a cache/STALE/DATA_UNAVAILABLE)
    // en vez de seguir golpeando un proveedor que ya dijo que pare.
    const breaker = createRateLimitBreaker();

    await mapWithConcurrency(items, CONCURRENCY, async (item) => {
      const ticker = item.ticker;
      const cachedRow = cacheByTicker[ticker] || null;

      const fetchLive = async () => {
        if (item.type === "stock") return getStockData(supabase, ticker, FINNHUB_KEY);
        if (item.type === "crypto") {
          const id = item.coingeckoId || COINGECKO_FALLBACK_IDS[ticker];
          if (!id) { const e = new Error("no_coingecko_id"); throw e; }
          return getCryptoData(supabase, ticker, id);
        }
        throw new Error("unknown_asset_type");
      };

      const result = await resolveTickerPrice({ item, cachedRow, now, breaker, fetchLive });
      results.push(result);

      if (result.status === "LIVE") {
        // Persistencia fire-and-forget (misma politica que
        // lib/aiPriceCache.js::setShortCache): el cache nunca debe
        // tumbar la respuesta principal si el upsert falla.
        supabase.from("market_cache").upsert(
          [{ ticker, ai_price: result.price, ai_change_pct: result.changePct, ai_price_updated_at: result.fetchedAt }],
          { onConflict: "ticker" }
        ).then(() => {}, () => {});
      }

      if (result.status === "DATA_UNAVAILABLE") {
        errors.push(ticker);
        return;
      }

      data[ticker] = {
        price: result.price, changePct: result.changePct,
        high: result.high, low: result.low,
        rangeLabel: item.type === "crypto" ? "histórico (ATH/ATL)" : "52 semanas",
        marketCap: result.marketCap, peRatio: result.peRatio,
        price_status: result.status, price_source: result.source, price_fetched_at: result.fetchedAt,
      };
    });

    const providerHealth = summarizeProviderHealth(results, breaker);

    res.setHeader("Cache-Control", "s-maxage=20, stale-while-revalidate=40");
    res.status(200).json({ data, errors, updatedAt: now.toISOString(), provider_health: providerHealth });
  } catch (err) {
    res.status(500).json({ error: "market_data_failed", detail: String(err) });
  }
}
