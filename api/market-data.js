// api/market-data.js
// Devuelve precio en vivo + contexto (rango 52w/ATH-ATL, market cap, PE).
// El precio SIEMPRE se pide en vivo. El rango/market cap/PE se cachea en
// Supabase (tabla market_cache) por varias horas, porque casi no cambian
// en el dia -- esto corta a la mitad las llamadas a Finnhub/CoinGecko y
// evita que el rate limit gratuito tumbe los precios.
// Nunca se inventa un dato: si algo falla, ese ticker sale en "errors" y
// no aparece en "data".

import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.VITE_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 horas

const COINGECKO_FALLBACK_IDS = {
  BTC: "bitcoin",
  ETH: "ethereum",
  SOL: "solana",
  LINK: "chainlink",
};

async function getCache(ticker) {
  try {
    const { data } = await supabase.from("market_cache").select("*").eq("ticker", ticker).maybeSingle();
    if (!data) return null;
    const age = Date.now() - new Date(data.updated_at).getTime();
    if (age > CACHE_TTL_MS) return null;
    return data;
  } catch (e) {
    return null;
  }
}

async function setCache(ticker, type, fields) {
  try {
    await supabase.from("market_cache").upsert([{ ticker, type, ...fields, updated_at: new Date().toISOString() }]);
  } catch (e) {
    // si falla el guardado de cache no debe tronar la respuesta principal
  }
}

async function getStockData(ticker, FINNHUB_KEY) {
  const quoteRes = await fetch(`https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(ticker)}&token=${FINNHUB_KEY}`);
  const quote = await quoteRes.json();
  if (!quote || typeof quote.c !== "number" || quote.c <= 0) {
    throw new Error("no_quote");
  }

  let high = null, low = null, marketCap = null, peRatio = null;
  const cached = await getCache(ticker);
  if (cached) {
    high = cached.high; low = cached.low; marketCap = cached.market_cap; peRatio = cached.pe_ratio;
  } else {
    const metricRes = await fetch(`https://finnhub.io/api/v1/stock/metric?symbol=${encodeURIComponent(ticker)}&metric=all&token=${FINNHUB_KEY}`);
    const metricData = await metricRes.json();
    const metric = metricData?.metric || {};
    high = typeof metric["52WeekHigh"] === "number" ? metric["52WeekHigh"] : null;
    low = typeof metric["52WeekLow"] === "number" ? metric["52WeekLow"] : null;
    marketCap = typeof metric.marketCapitalization === "number" ? metric.marketCapitalization * 1_000_000 : null;
    peRatio = typeof metric.peBasicExclExtraTTM === "number" ? metric.peBasicExclExtraTTM : null;
    await setCache(ticker, "stock", { high, low, market_cap: marketCap, pe_ratio: peRatio, range_label: "52 semanas" });
  }

  return {
    price: quote.c,
    changePct: typeof quote.dp === "number" ? quote.dp : null,
    high, low, rangeLabel: "52 semanas", marketCap, peRatio,
  };
}

async function getCryptoData(ticker, coingeckoId) {
  const r = await fetch(
    `https://api.coingecko.com/api/v3/simple/price?ids=${coingeckoId}&vs_currencies=usd&include_market_cap=true&include_24hr_change=true`
  );
  const d = await r.json();
  const entry = d?.[coingeckoId];
  if (!entry || typeof entry.usd !== "number") {
    throw new Error("no_price");
  }

  let high = null, low = null;
  const cached = await getCache(ticker);
  if (cached) {
    high = cached.high; low = cached.low;
  } else {
    const r2 = await fetch(
      `https://api.coingecko.com/api/v3/coins/${coingeckoId}?localization=false&tickers=false&market_data=true&community_data=false&developer_data=false&sparkline=false`
    );
    const d2 = await r2.json();
    high = typeof d2?.market_data?.ath?.usd === "number" ? d2.market_data.ath.usd : null;
    low = typeof d2?.market_data?.atl?.usd === "number" ? d2.market_data.atl.usd : null;
    await setCache(ticker, "crypto", { high, low, market_cap: entry.usd_market_cap ?? null, pe_ratio: null, range_label: "histórico (ATH/ATL)" });
  }

  return {
    price: entry.usd,
    changePct: typeof entry.usd_24h_change === "number" ? entry.usd_24h_change : null,
    high, low, rangeLabel: "histórico (ATH/ATL)",
    marketCap: entry.usd_market_cap ?? (cached ? cached.market_cap : null),
    peRatio: null,
  };
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "method_not_allowed" });
  }

  try {
    const { items } = req.body || {};
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(200).json({ data: {}, errors: [], updatedAt: new Date().toISOString() });
    }

    const FINNHUB_KEY = process.env.FINNHUB_API_KEY;
    const data = {};
    const errors = [];

    await Promise.all(
      items.map(async (item) => {
        const ticker = item.ticker;
        try {
          if (item.type === "stock") {
            data[ticker] = await getStockData(ticker, FINNHUB_KEY);
          } else if (item.type === "crypto") {
            const id = item.coingeckoId || COINGECKO_FALLBACK_IDS[ticker];
            if (!id) throw new Error("no_coingecko_id");
            data[ticker] = await getCryptoData(ticker, id);
          }
        } catch (e) {
          errors.push(ticker);
        }
      })
    );

    res.setHeader("Cache-Control", "s-maxage=20, stale-while-revalidate=40");
    res.status(200).json({ data, errors, updatedAt: new Date().toISOString() });
  } catch (err) {
    res.status(500).json({ error: "market_data_failed", detail: String(err) });
  }
}
