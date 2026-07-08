// api/market-data.js
// Recibe una lista de activos (POST) y devuelve, por cada uno, precio en vivo
// + contexto: rango de referencia (52 semanas para acciones, ATH/ATL para
// cripto), cambio del dia y capitalizacion de mercado.
// Nunca inventa un dato: si una fuente falla, ese ticker no aparece en la
// respuesta ("data"), solo en "errors".

const COINGECKO_FALLBACK_IDS = {
  BTC: "bitcoin",
  ETH: "ethereum",
  SOL: "solana",
  LINK: "chainlink",
};

async function getStockData(ticker, FINNHUB_KEY) {
  const [quoteRes, metricRes] = await Promise.all([
    fetch(`https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(ticker)}&token=${FINNHUB_KEY}`),
    fetch(`https://finnhub.io/api/v1/stock/metric?symbol=${encodeURIComponent(ticker)}&metric=all&token=${FINNHUB_KEY}`),
  ]);
  const quote = await quoteRes.json();
  const metricData = await metricRes.json();
  const metric = metricData?.metric || {};

  if (!quote || typeof quote.c !== "number" || quote.c <= 0) {
    throw new Error("no_quote");
  }

  return {
    price: quote.c,
    changePct: typeof quote.dp === "number" ? quote.dp : null,
    high: typeof metric["52WeekHigh"] === "number" ? metric["52WeekHigh"] : null,
    low: typeof metric["52WeekLow"] === "number" ? metric["52WeekLow"] : null,
    rangeLabel: "52 semanas",
    marketCap: typeof metric.marketCapitalization === "number" ? metric.marketCapitalization * 1_000_000 : null,
    peRatio: typeof metric.peBasicExclExtraTTM === "number" ? metric.peBasicExclExtraTTM : null,
  };
}

async function getCryptoData(coingeckoId) {
  const r = await fetch(
    `https://api.coingecko.com/api/v3/coins/${coingeckoId}?localization=false&tickers=false&market_data=true&community_data=false&developer_data=false&sparkline=false`
  );
  const d = await r.json();
  const md = d?.market_data;
  if (!md || typeof md.current_price?.usd !== "number") {
    throw new Error("no_market_data");
  }
  return {
    price: md.current_price.usd,
    changePct: typeof md.price_change_percentage_24h === "number" ? md.price_change_percentage_24h : null,
    high: typeof md.ath?.usd === "number" ? md.ath.usd : null,
    low: typeof md.atl?.usd === "number" ? md.atl.usd : null,
    rangeLabel: "histórico (ATH/ATL)",
    marketCap: typeof md.market_cap?.usd === "number" ? md.market_cap.usd : null,
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
            data[ticker] = await getCryptoData(id);
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
