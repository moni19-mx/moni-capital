// lib/prices.js
// Obtiene precio en vivo + contexto (rango 52w/ATH-ATL, market cap, PE) para
// un ticker. Compartido entre api/market-data.js (lo usa el frontend) y
// lib/aiTools.js (lo usan las herramientas de Moni AI) -- una sola fuente
// de verdad, para que el chat y el dashboard nunca vean numeros distintos.

import { getCache, setCache } from "./marketCache.js";

// Micro-sprint P0.3 (Market Price Cache + Provider Resilience). Error
// distinguible cuando el proveedor responde 429 -- el llamador
// (api/market-data.js) necesita diferenciar "este ticker en particular
// no tiene precio" de "el proveedor completo esta rate-limiteado
// ahora mismo" para poder activar el circuit breaker y dejar de pedir
// los tickers restantes del mismo batch en vivo.
export class ProviderRateLimitError extends Error {
  constructor(provider) {
    super(`${provider}_rate_limited_429`);
    this.name = "ProviderRateLimitError";
    this.rateLimited = true;
    this.provider = provider;
  }
}

export class ProviderAuthError extends Error {
  constructor(provider, status) {
    super(`${provider}_auth_error_${status}`);
    this.name = "ProviderAuthError";
    this.authError = true;
    this.provider = provider;
  }
}

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
  const headers = {
    // Algunos proveedores (CoinGecko incluido, de forma no documentada)
    // tratan distinto el trafico sin User-Agent tipo navegador -- comun
    // en llamadas server-to-server desde plataformas serverless como
    // Vercel, que comparten IPs entre miles de proyectos.
    "User-Agent": "Mozilla/5.0 (compatible; MoniCapital/1.0; +https://moni-capital.vercel.app)",
    Accept: "application/json",
  };
  if (COINGECKO_API_KEY) headers["x-cg-demo-api-key"] = COINGECKO_API_KEY;
  return headers;
}

export async function getStockData(supabase, ticker, FINNHUB_KEY) {
  const quoteRes = await fetchWithTimeout(`https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(ticker)}&token=${FINNHUB_KEY}`);
  if (quoteRes.status === 429) throw new ProviderRateLimitError("finnhub");
  if (quoteRes.status === 401 || quoteRes.status === 403) throw new ProviderAuthError("finnhub", quoteRes.status);
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
  let d, r;
  // 1 reintento con backoff corto -- resiliente contra bloqueos/limites
  // de tasa transitorios (comunes en trafico serverless sin browser
  // fingerprint), sin convertir esto en un retry-loop agresivo.
  for (let attempt = 0; attempt < 2; attempt++) {
    r = await fetchWithTimeout(
      `https://api.coingecko.com/api/v3/simple/price?ids=${coingeckoId}&vs_currencies=usd&include_market_cap=true&include_24hr_change=true`,
      { headers: coingeckoHeaders() }
    );
    // P0.3: un 429 nunca se reintenta de inmediato -- reintentar contra
    // un rate-limit activo solo lo empeora. Se propaga distinguible de
    // una vez para que el llamador active el circuit breaker.
    if (r.status === 429) throw new ProviderRateLimitError("coingecko");
    const text = await r.text();
    try {
      d = JSON.parse(text);
    } catch {
      d = { _parseError: true, _rawText: text.slice(0, 300) };
    }
    const entry = d?.[coingeckoId];
    if (entry && typeof entry.usd === "number") {
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
        high = null; low = null;
      }
      return {
        price: entry.usd,
        changePct: typeof entry.usd_24h_change === "number" ? entry.usd_24h_change : null,
        high, low, rangeLabel: "histórico (ATH/ATL)",
        marketCap: entry.usd_market_cap ?? null,
        peRatio: null,
      };
    }
    if (attempt === 0) await new Promise((res) => setTimeout(res, 400)); // backoff corto antes del reintento
  }
  // Ambos intentos fallaron -- error con la evidencia real de CoinGecko,
  // no un mensaje generico, para poder diagnosticar de verdad la proxima vez.
  throw new Error(`no_price: status=${r?.status} body=${JSON.stringify(d).slice(0, 300)}`);
}
