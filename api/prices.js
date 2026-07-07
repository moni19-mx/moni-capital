// api/prices.js
// Devuelve precios en vivo para tickers de acciones (Finnhub) y cripto (CoinGecko).
// Nunca inventa un precio: si una fuente falla para un ticker, ese ticker
// simplemente no aparece en la respuesta y el frontend lo marca como "sin dato".

const COINGECKO_IDS = {
  BTC: "bitcoin",
  ETH: "ethereum",
  SOL: "solana",
  LINK: "chainlink",
};

export default async function handler(req, res) {
  try {
    const stocksParam = req.query.stocks || "";
    const cryptosParam = req.query.cryptos || "";
    const stockTickers = stocksParam.split(",").map((s) => s.trim()).filter(Boolean);
    const cryptoTickers = cryptosParam.split(",").map((s) => s.trim()).filter(Boolean);

    const prices = {};
    const errors = [];

    const FINNHUB_KEY = process.env.FINNHUB_API_KEY;

    await Promise.all(
      stockTickers.map(async (ticker) => {
        try {
          const r = await fetch(
            `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(ticker)}&token=${FINNHUB_KEY}`
          );
          const d = await r.json();
          if (d && typeof d.c === "number" && d.c > 0) {
            prices[ticker] = d.c;
          } else {
            errors.push(ticker);
          }
        } catch (e) {
          errors.push(ticker);
        }
      })
    );

    if (cryptoTickers.length) {
      const ids = cryptoTickers.map((t) => COINGECKO_IDS[t]).filter(Boolean);
      if (ids.length) {
        try {
          const r = await fetch(
            `https://api.coingecko.com/api/v3/simple/price?ids=${ids.join(",")}&vs_currencies=usd`
          );
          const d = await r.json();
          cryptoTickers.forEach((t) => {
            const id = COINGECKO_IDS[t];
            if (id && d[id] && typeof d[id].usd === "number") {
              prices[t] = d[id].usd;
            } else {
              errors.push(t);
            }
          });
        } catch (e) {
          cryptoTickers.forEach((t) => errors.push(t));
        }
      }
    }

    res.setHeader("Cache-Control", "s-maxage=20, stale-while-revalidate=40");
    res.status(200).json({ prices, errors, updatedAt: new Date().toISOString() });
  } catch (err) {
    res.status(500).json({ error: "price_fetch_failed", detail: String(err) });
  }
}
