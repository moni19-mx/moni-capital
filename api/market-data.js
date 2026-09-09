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
import { createRateLimitBreaker, buildCacheWriteRow } from "../lib/priceCache.js";
import { resolveTickerPrice, summarizeProviderHealthDetailed } from "../lib/marketDataOrchestrator.js";

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
    // Price Truth POST-review (bug real reportado por el usuario):
    // breakers INDEPENDIENTES por proveedor -- antes un solo breaker
    // compartido significaba que un 429 de CoinGecko (5 tickers cripto)
    // cortaba tambien los 42 tickers de Finnhub en el MISMO batch, sin
    // relacion real entre los dos proveedores. Ahora un 429 de
    // CoinGecko solo afecta a los tickers cripto restantes de esta
    // corrida; Finnhub sigue intentando en vivo normalmente, y viceversa.
    const breakers = { finnhub: createRateLimitBreaker(), coingecko: createRateLimitBreaker() };

    await mapWithConcurrency(items, CONCURRENCY, async (item) => {
      const ticker = item.ticker;
      const cachedRow = cacheByTicker[ticker] || null;
      const providerBreaker = item.type === "crypto" ? breakers.coingecko : breakers.finnhub;

      const fetchLive = async () => {
        if (item.type === "stock") return getStockData(supabase, ticker, FINNHUB_KEY);
        if (item.type === "crypto") {
          const id = item.coingeckoId || COINGECKO_FALLBACK_IDS[ticker];
          if (!id) { const e = new Error("no_coingecko_id"); throw e; }
          return getCryptoData(supabase, ticker, id);
        }
        throw new Error("unknown_asset_type");
      };

      const result = await resolveTickerPrice({ item, cachedRow, now, breaker: providerBreaker, fetchLive });
      result.provider = item.type === "crypto" ? "coingecko" : "finnhub";
      results.push(result);

      if (result.status === "LIVE") {
        // Bugfix real #1 de P0.3 (encontrado en la corrida en vivo): un
        // upsert fire-and-forget (sin await) puede quedar cortado a
        // medias -- Vercel puede congelar/terminar el entorno de
        // ejecucion en cuanto el handler manda la respuesta y retorna,
        // ANTES de que la promesa suelta termine de escribir. Ahora se
        // espera (await) DENTRO del worker de cada ticker --
        // mapWithConcurrency ya espera a que todos los workers terminen
        // antes de que el handler responda, asi que esto SI garantiza
        // que el cache quede escrito (si no falla por otra razon).
        //
        // Bugfix real #2 de P0.3 (encontrado DESPUES del fix #1, con
        // una prueba SQL directa): `type` es NOT NULL en market_cache y
        // no tenia default. Postgres valida las columnas NOT NULL de la
        // fila candidata de un INSERT ANTES de siquiera evaluar el
        // ON CONFLICT DO UPDATE -- asi que el upsert fallaba SIEMPRE
        // (fila nueva o existente, da igual) por no incluir `type`,
        // aunque el UPDATE en si nunca lo hubiera tocado. Confirmado
        // con SQL directo: el mismo upsert sin `type` falla incluso
        // sobre una fila YA EXISTENTE con `type='stock'`. Supabase-js
        // tampoco lanza (`.upsert()` resuelve `{data,error}`, nunca
        // rechaza por un error de base de datos) -- por eso el
        // try/catch nunca lo detectaba; ahora se revisa `error`
        // explicitamente.
        const { error: cacheWriteError } = await supabase.from("market_cache").upsert(
          [buildCacheWriteRow(ticker, item.type, result)],
          { onConflict: "ticker" }
        );
        if (cacheWriteError) result.cacheWriteFailed = true; // el cache nunca debe tumbar la respuesta principal, pero se registra para provider_health
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

    // provider_health se mantiene como STRING (contrato sin cambios para
    // App.jsx::summarizeGlobalFreshness) -- finnhub_status/coingecko_status
    // son ADITIVOS, para UI futura que quiera distinguir cual proveedor
    // especifico esta degradado.
    const providerHealthDetailed = summarizeProviderHealthDetailed(results, breakers);

    res.setHeader("Cache-Control", "s-maxage=20, stale-while-revalidate=40");
    res.status(200).json({
      data, errors, updatedAt: now.toISOString(),
      provider_health: providerHealthDetailed.aggregate,
      finnhub_status: providerHealthDetailed.finnhub_status,
      coingecko_status: providerHealthDetailed.coingecko_status,
    });
  } catch (err) {
    res.status(500).json({ error: "market_data_failed", detail: String(err) });
  }
}
