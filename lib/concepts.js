// lib/concepts.js
// Mapa curado de temas -> tickers reales conocidos de ese tema. Es
// deterministico y mantenido a mano, NO una IA generando sugerencias en
// tiempo real. Se amplia agregando entradas aqui, nunca inventando datos
// de mercado (el precio/rango de cada ticker sigue viniendo de Finnhub/
// CoinGecko como todo lo demas).

export const CONCEPT_MAP = {
  "ia": [
    { ticker: "NVDA", name: "Nvidia Corp", type: "stock" },
    { ticker: "MSFT", name: "Microsoft Corp", type: "stock" },
    { ticker: "GOOGL", name: "Alphabet Inc Class A", type: "stock" },
    { ticker: "PLTR", name: "Palantir Technologies", type: "stock" },
    { ticker: "AMD", name: "Advanced Micro Devices", type: "stock" },
  ],
  "inteligencia artificial": "ia",
  "cloud": [
    { ticker: "MSFT", name: "Microsoft Corp", type: "stock" },
    { ticker: "AMZN", name: "Amazon.com Inc", type: "stock" },
    { ticker: "GOOGL", name: "Alphabet Inc Class A", type: "stock" },
    { ticker: "ORCL", name: "Oracle Corp", type: "stock" },
    { ticker: "NBIS", name: "Nebius Group N.V.", type: "stock" },
  ],
  "energia": [
    { ticker: "XOM", name: "Exxon Mobil Corp", type: "stock" },
    { ticker: "CVX", name: "Chevron Corp", type: "stock" },
    { ticker: "OXY", name: "Occidental Petroleum", type: "stock" },
    { ticker: "FRVO", name: "Fervo Energy Company", type: "stock" },
  ],
  "semiconductores": [
    { ticker: "NVDA", name: "Nvidia Corp", type: "stock" },
    { ticker: "AMD", name: "Advanced Micro Devices", type: "stock" },
    { ticker: "QCOM", name: "Qualcomm Inc", type: "stock" },
    { ticker: "ALAB", name: "Astera Labs Inc", type: "stock" },
    { ticker: "AAOI", name: "Applied Optoelectronics", type: "stock" },
  ],
  "fintech": [
    { ticker: "NU", name: "Nu Holdings Ltd", type: "stock" },
    { ticker: "SOFI", name: "SoFi Technologies", type: "stock" },
  ],
  "cripto": [
    { ticker: "BTC", name: "Bitcoin", type: "crypto", coingeckoId: "bitcoin" },
    { ticker: "ETH", name: "Ethereum", type: "crypto", coingeckoId: "ethereum" },
    { ticker: "SOL", name: "Solana", type: "crypto", coingeckoId: "solana" },
    { ticker: "LINK", name: "Chainlink", type: "crypto", coingeckoId: "chainlink" },
  ],
  "criptomonedas": "cripto",
  "ciberseguridad": [
    { ticker: "CRWD", name: "CrowdStrike Holdings", type: "stock" },
  ],
  "infraestructura": [
    { ticker: "VRT", name: "Vertiv Holdings Co", type: "stock" },
    { ticker: "NBIS", name: "Nebius Group N.V.", type: "stock" },
    { ticker: "ALAB", name: "Astera Labs Inc", type: "stock" },
  ],
};

// Resuelve alias (ej "inteligencia artificial" -> "ia") y devuelve la lista
// de tickers para un termino de busqueda, o null si no coincide con ningun
// concepto conocido.
export function resolveConcept(query) {
  const key = query.trim().toLowerCase();
  const entry = CONCEPT_MAP[key];
  if (!entry) return null;
  if (typeof entry === "string") return CONCEPT_MAP[entry] || null;
  return entry;
}
