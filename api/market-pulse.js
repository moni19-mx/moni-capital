// api/market-pulse.js
// 4 numeros de contexto de mercado, sin ruido, sin noticias.
// Honestidad de fuentes:
// - BTC: CoinGecko (confiable)
// - NASDAQ: proxy via QQQ (ETF liquido que sigue al Nasdaq-100) por Finnhub (confiable)
// - Fear & Greed: alternative.me -- es el indice de CRIPTO, no el de CNN para
//   acciones (ese no tiene API publica gratuita real). Se etiqueta como tal,
//   nunca se presenta como si midiera el mercado accionario.
// - VIX: se intenta via Finnhub (^VIX). Si el plan gratuito no lo entrega,
//   sale como null -- nunca se inventa.

import { createClient } from "@supabase/supabase-js";
import { getCache, setCache } from "../lib/marketCache.js";

const supabase = createClient(
  process.env.VITE_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const PULSE_TTL_MS = 15 * 60 * 1000; // 15 minutos, mas fresco que el cache normal

async function getFearGreed() {
  try {
    const r = await fetch("https://api.alternative.me/fng/?limit=1");
    const d = await r.json();
    const val = d?.data?.[0]?.value;
    return val != null ? Number(val) : null;
  } catch (e) {
    return null;
  }
}

async function getVix(FINNHUB_KEY) {
  try {
    const r = await fetch(`https://finnhub.io/api/v1/quote?symbol=%5EVIX&token=${FINNHUB_KEY}`);
    const d = await r.json();
    return typeof d?.c === "number" && d.c > 0 ? d.c : null;
  } catch (e) {
    return null;
  }
}

async function getNasdaqProxy(FINNHUB_KEY) {
  try {
    const r = await fetch(`https://finnhub.io/api/v1/quote?symbol=QQQ&token=${FINNHUB_KEY}`);
    const d = await r.json();
    return typeof d?.dp === "number" ? d.dp : null;
  } catch (e) {
    return null;
  }
}

async function getBtcChange() {
  try {
    const r = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd&include_24hr_change=true");
    const d = await r.json();
    return typeof d?.bitcoin?.usd_24h_change === "number" ? d.bitcoin.usd_24h_change : null;
  } catch (e) {
    return null;
  }
}

export default async function handler(req, res) {
  try {
    const cached = await getCache(supabase, "MKT_PULSE", PULSE_TTL_MS);
    if (cached) {
      return res.status(200).json({
        fearGreed: cached.high, // reutilizamos columnas existentes de market_cache
        vix: cached.low,
        nasdaqChangePct: cached.market_cap,
        btcChangePct: cached.pe_ratio,
        updatedAt: cached.updated_at,
        fromCache: true,
      });
    }

    const FINNHUB_KEY = process.env.FINNHUB_API_KEY;
    const [fearGreed, vix, nasdaqChangePct, btcChangePct] = await Promise.all([
      getFearGreed(),
      getVix(FINNHUB_KEY),
      getNasdaqProxy(FINNHUB_KEY),
      getBtcChange(),
    ]);

    await setCache(supabase, "MKT_PULSE", "market_pulse", {
      high: fearGreed, low: vix, market_cap: nasdaqChangePct, pe_ratio: btcChangePct, range_label: "pulse",
    });

    res.setHeader("Cache-Control", "s-maxage=60, stale-while-revalidate=120");
    res.status(200).json({ fearGreed, vix, nasdaqChangePct, btcChangePct, updatedAt: new Date().toISOString(), fromCache: false });
  } catch (err) {
    res.status(500).json({ error: "market_pulse_failed", detail: String(err) });
  }
}
