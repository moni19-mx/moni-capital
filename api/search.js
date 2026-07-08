// api/search.js
// Busca activos reales por nombre o ticker: acciones via Finnhub, cripto via CoinGecko.
// Devuelve una lista combinada y acotada de resultados.

export default async function handler(req, res) {
  try {
    const q = (req.query.q || "").trim();
    if (q.length < 1) {
      return res.status(200).json({ results: [] });
    }

    const FINNHUB_KEY = process.env.FINNHUB_API_KEY;
    const results = [];

    try {
      const r = await fetch(`https://finnhub.io/api/v1/search?q=${encodeURIComponent(q)}&token=${FINNHUB_KEY}`);
      const d = await r.json();
      (d.result || [])
        .filter((it) => it.type === "Common Stock" || it.type === "ETP" || it.type === "ADR")
        .slice(0, 8)
        .forEach((it) => {
          results.push({ ticker: it.symbol, name: it.description, type: "stock" });
        });
    } catch (e) {
      /* si falla acciones, seguimos con cripto */
    }

    try {
      const r2 = await fetch(`https://api.coingecko.com/api/v3/search?query=${encodeURIComponent(q)}`);
      const d2 = await r2.json();
      (d2.coins || []).slice(0, 6).forEach((c) => {
        results.push({
          ticker: (c.symbol || "").toUpperCase(),
          name: c.name,
          type: "crypto",
          coingeckoId: c.id,
        });
      });
    } catch (e) {
      /* si falla cripto, seguimos con lo que haya de acciones */
    }

    res.setHeader("Cache-Control", "s-maxage=60, stale-while-revalidate=120");
    res.status(200).json({ results: results.slice(0, 12) });
  } catch (err) {
    res.status(500).json({ error: "search_failed", detail: String(err) });
  }
}
