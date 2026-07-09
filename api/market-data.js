// api/market-data.js
// Endpoint que usa el frontend para pedir precios en vivo de varios tickers
// a la vez. La logica real vive en lib/prices.js (compartida con las
// herramientas de Moni AI).
 
import { createClient } from "@supabase/supabase-js";
import { getStockData, getCryptoData, COINGECKO_FALLBACK_IDS } from "../lib/prices.js";
 
const supabase = createClient(
  process.env.VITE_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);
 
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
            data[ticker] = await getStockData(supabase, ticker, FINNHUB_KEY);
          } else if (item.type === "crypto") {
            const id = item.coingeckoId || COINGECKO_FALLBACK_IDS[ticker];
            if (!id) throw new Error("no_coingecko_id");
            data[ticker] = await getCryptoData(supabase, ticker, id);
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
 
