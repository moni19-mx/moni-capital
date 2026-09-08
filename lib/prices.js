// lib/prices.js
// Obtiene precio en vivo + contexto (rango 52w/ATH-ATL, market cap, PE) para
// un ticker. Compartido entre api/market-data.js (lo usa el frontend) y
// lib/aiTools.js (lo usan las herramientas de Moni AI) -- una sola fuente
// de verdad, para que el chat y el dashboard nunca vean numeros distintos.

import { getCache, setCache } from "./marketCache.js";

export const COINGECKO_FALLBACK_IDS = {
  BTC: "bitcoin",
  ETH: "ethereum",
  SOL: "solana",
  LINK: "chainlink",
  // USDT agregado explicitamente: Smart Import Futures necesita valuar
  // equity de cuentas USD-M, y no quiere depender exclusivamente de que
  // el join anidado de Supabase (assets.provider_symbols) resuelva bien
  // en produccion -- este fallback es una defensa redundante, segura,
  // que nunca sobreescribe provider_symbols si ya esta poblado.
  USDT: "tether",
};

const FETCH_TIMEOUT_MS = 8000; // 8s -- generoso para Finnhub/CoinGecko, corto frente al short cache de 60s

const COINGECKO_API_KEY = process.env.COINGECKO_API_KEY;

async function fetchWithTimeout(url, { timeoutMs = FETCH_TIMEOUT_MS, headers = {} } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal, headers });
  } catch (e) {
    if (e.name === "AbortError") {
      throw new Error(`timeout_after_${timeoutMs}ms: ${url.split("?")[0]}`);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

function coingeckoHeaders() {
  return COINGECKO_API_KEY ? { "x-cg-demo-api-key": COINGECKO_API_KEY } : {};
}

export async function getStockData(supabase, ticker, FINNHUB_KEY) {
  const quoteRes = await fetchWithTimeout(`https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(ticker)}&token=${FINNHUB_KEY}`);
  const quote = await quoteRes.json();
  if (!quote || typeof quote.c !== "number" || quote.c <= 0) {
    throw new Error("no_quote");
  }

  let high = null, low = null, marketCap = null, peRatio = null;
  const cached = await getCache(supabase, ticker);
  if (cached) {
    high = cached.high; low = cached.low; marketCap = cached.market_cap; peRatio = cached.pe_ratio;
  } else {
    const metricRes = await fetchWithTimeout(`https://finnhub.io/api/v1/stock/metric?symbol=${encodeURIComponent(ticker)}&metric=all&token=${FINNHUB_KEY}`);
    const metricData = await metricRes.json();
    const metric = metricData?.metric || {};
    high = typeof metric["52WeekHigh"] === "number" ? metric["52WeekHigh"] : null;
    low = typeof metric["52WeekLow"] === "number" ? metric["52WeekLow"] : null;
    marketCap = typeof metric.marketCapitalization === "number" ? metric.marketCapitalization * 1_000_000 : null;
    peRatio = typeof metric.peBasicExclExtraTTM === "number" ? metric.peBasicExclExtraTTM : null;
    await setCache(supabase, ticker, "stock", { high, low, market_cap: marketCap, pe_ratio: peRatio, range_label: "52 semanas" });
  }

  return {
    price: quote.c,
    changePct: typeof quote.dp === "number" ? quote.dp : null,
    high, low, rangeLabel: "52 semanas", marketCap, peRatio,
  };
}

export async function getCryptoData(supabase, ticker, coingeckoId) {
  const r = await fetchWithTimeout(
    `https://api.coingecko.com/api/v3/simple/price?ids=${coingeckoId}&vs_currencies=usd&include_market_cap=true&include_24hr_change=true`,
    { headers: coingeckoHeaders() }
  );
  const d = await r.json();
  const entry = d?.[coingeckoId];
  if (!entry || typeof entry.usd !== "number") {
    throw new Error("no_price");
  }

  // El precio ya esta resuelto en este punto -- todo lo que sigue es
  // contexto adicional (ATH/ATL). Si esa segunda llamada falla (rate
  // limit, timeout, lo que sea), NUNCA debe tirar el precio ya obtenido
  // -- antes, un fallo aqui hacia que toda la funcion lanzara error,
  // perdiendo incluso el precio que ya se tenia. Ahora se degrada a
  // high/low = null en vez de perder el precio completo.
  let high = null, low = null;
  try {
    const cached = await getCache(supabase, ticker);
    if (cached) {
      high = cached.high; low = cached.low;
    } else {
      const r2 = await fetchWithTimeout(
        `https://api.coingecko.com/api/v3/coins/${coingeckoId}?localization=false&tickers=false&market_data=true&community_data=false&developer_data=false&sparkline=false`,
        { headers: coingeckoHeaders() }
      );
      const d2 = await r2.json();
      high = typeof d2?.market_data?.ath?.usd === "number" ? d2.market_data.ath.usd : null;
      low = typeof d2?.market_data?.atl?.usd === "number" ? d2.market_data.atl.usd : null;
      await setCache(supabase, ticker, "crypto", { high, low, market_cap: entry.usd_market_cap ?? null, pe_ratio: null, range_label: "histórico (ATH/ATL)" });
    }
  } catch {
    high = null; low = null; // degradado, nunca pierde el precio por esto
  }

  return {
    price: entry.usd,
    changePct: typeof entry.usd_24h_change === "number" ? entry.usd_24h_change : null,
    high, low, rangeLabel: "histórico (ATH/ATL)",
    marketCap: entry.usd_market_cap ?? null,
    peRatio: null,
  };
}
