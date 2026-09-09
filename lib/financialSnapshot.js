// lib/financialSnapshot.js
// Micro-sprint P0.2 (Financial Totals Correctness + Stability). Funciones
// PURAS que consolidan el calculo de los totales financieros
// principales (Total Acciones, Total Cripto, Patrimonio Base,
// Patrimonio Total, Cash, PnL) -- extraidas de src/App.jsx para que
// exista una unica formula testeable (item 5, Single Source of Truth) y
// para poder demostrar con tests reales que la suma es correcta,
// deterministica, e independiente del orden de las posiciones. CERO
// cambio de formula respecto al codigo original -- misma matematica,
// ahora en un lugar reutilizable y testeable sin navegador.
//
// Dos correcciones REALES encontradas durante el audit de P0.2 (no son
// cambios de formula, son fixes de bugs reales documentados en el
// reporte final):
//
// 1. mergeMarketData(): el codigo original hacia
//    setMarketData(response.data) -- un REEMPLAZO COMPLETO del objeto.
//    Si un ticker tenia precio valido en el ciclo anterior pero el
//    proveedor (Finnhub/CoinGecko) fallo SOLO para ese ticker en este
//    ciclo (el resto de la respuesta sigue siendo 200 OK), ese ticker
//    desaparecia de marketData por completo -- la posicion pasaba de
//    "valuada" a "sin precio", excluyendose silenciosamente del total
//    en vez de conservar su ultimo precio conocido (violando el mismo
//    principio LAST KNOWN GOOD que P0.1 ya aplicaba a nivel de fuente
//    completa, pero que nunca se aplico a nivel de ticker individual).
//
// 2. unclassifiedPositions(): una posicion cuyo `type` no es
//    exactamente "stock"/"crypto"/"cash" (ej. NULL) nunca puede
//    valuarse -- ni market-data.js sabe que proveedor usar, ni ninguna
//    KpiCard la cuenta. Antes esto se mezclaba silenciosamente con
//    "missing" (precio no disponible este ciclo, un problema de RED),
//    cuando en realidad es un problema de DATOS distinto y permanente.

// Sprint P0.4 (item 3, positions vs watchlist TTL): cada item lleva
// `priority` -- "position" si el ticker esta en tu cartera real
// (dinero en juego), "watchlist" si SOLO lo estas observando. Un
// ticker que aparece en ambos SIEMPRE queda como "position" (se
// procesa primero, y `seen` descarta el duplicado de watchlist) --
// nunca se degrada la frescura de algo que si es tuyo. Ver
// lib/priceCache.js::computeTtlMs, que usa este campo para decidir el
// TTL (90s position / 5min watchlist-only).
export function buildMarketDataItems(positions, watchlist) {
  const items = [];
  const seen = new Set();
  (positions || []).filter((p) => p.type !== "cash").forEach((p) => {
    const key = `${p.ticker}-${p.type}`;
    if (seen.has(key)) return;
    seen.add(key);
    items.push({ ticker: p.ticker, type: p.type, coingeckoId: p.coingecko_id || undefined, priority: "position" });
  });
  (watchlist || []).forEach((p) => {
    const key = `${p.ticker}-${p.type}`;
    if (seen.has(key)) return;
    seen.add(key);
    items.push({ ticker: p.ticker, type: p.type, coingeckoId: p.coingecko_id || undefined, priority: "watchlist" });
  });
  return items;
}

// Root cause real #1 (ver arriba): MERGE por ticker, nunca reemplazo
// completo del mapa. `incoming` gana para cualquier ticker que si tuvo
// exito este ciclo; cualquier ticker que NO vino en `incoming` (fallo
// puntual de ese ticker, o simplemente no se pidio esta vez) conserva
// su ultimo valor conocido en `previous`, tal cual, nunca un $0
// inventado.
export function mergeMarketData(previous, incoming) {
  return { ...(previous || {}), ...(incoming || {}) };
}

export function enrichPositions(positions, marketData, thesisByTicker) {
  return (positions || []).map((p) => {
    const cost = Number(p.cost_basis);
    let value = null, md = null;
    if (p.type === "cash") {
      value = cost;
    } else {
      md = (marketData || {})[p.ticker];
      if (md) value = Number(p.shares) * md.price;
    }
    const gain = value != null ? value - cost : null;
    const pct = value != null && cost ? gain / cost : null;
    return { ...p, value, gain, pct, market: md || null, thesis: (thesisByTicker && thesisByTicker[p.ticker]) || null };
  });
}

export function computeCashValue(cashMovements) {
  return (cashMovements || []).reduce((a, m) => a + (m.type === "deposito" ? Number(m.amount) : -Number(m.amount)), 0);
}

// Total Acciones canonico = SUM(shares_i x current_or_last_known_good_price_i)
// para toda posicion con type==="stock" y value conocido (ver
// enrichPositions -- value ya es shares*price o null). Formula sin
// cambios respecto al codigo original.
export function computeStocksValue(enrichedPositions) {
  return (enrichedPositions || []).filter((p) => p.value != null && p.type === "stock").reduce((a, p) => a + p.value, 0);
}

export function computeCryptoValue(enrichedPositions) {
  return (enrichedPositions || []).filter((p) => p.value != null && p.type === "crypto").reduce((a, p) => a + p.value, 0);
}

export function computePatrimonioBase(enrichedPositions, cashValue) {
  const withValue = (enrichedPositions || []).filter((p) => p.value != null);
  return withValue.reduce((a, p) => a + p.value, 0) + cashValue;
}

export function computePatrimonio(patrimonioBase, futuresEquityUsd) {
  return patrimonioBase + (futuresEquityUsd || 0);
}

export function computeInvested(enrichedPositions, cashValue) {
  const withValue = (enrichedPositions || []).filter((p) => p.value != null);
  return withValue.reduce((a, p) => a + Number(p.cost_basis), 0) + cashValue;
}

export function computeTotalGain(patrimonio, invested) {
  return patrimonio - invested;
}

// Root cause real #2 (ver arriba): posiciones que nunca pueden
// valuarse porque su `type` no es un valor conocido -- problema de
// DATOS, no de red/proveedor. Se reportan aparte de "missing" (precio
// no disponible este ciclo) para que el usuario entienda la diferencia
// real: "esto es temporal, ya llega" vs "esto no se puede resolver
// sin corregir el dato".
export function unclassifiedPositions(positions) {
  return (positions || []).filter((p) => p.type !== "stock" && p.type !== "crypto" && p.type !== "cash");
}

// Sprint P0.4 (item 5/9, Price Freshness UI). PURA -- solo lee
// `.value`/`.market.price_status` de posiciones ya enriquecidas (ver
// enrichPositions arriba) y el provider_health del ultimo batch de
// market-data.js (P0.3). Nunca decide un $ -- solo clasifica el estado
// global para el indicador discreto junto a "Precios: HH:MM:SS".
// Prioridad de severidad (mas grave gana): PROVIDER_RATE_LIMITED >
// PARTIAL_MISSING > PARTIAL_STALE > ALL_GOOD -- un rate-limit activo es
// la unica causa raiz que explica tanto stale como missing a la vez,
// asi que se reporta primero en vez de mezclar 3 mensajes.
export function summarizeGlobalFreshness(enrichedPositions, providerHealth) {
  const staleTickers = [];
  const rateLimitedTickers = [];
  const missingTickers = [];
  (enrichedPositions || []).forEach((p) => {
    if (p.type === "cash") return;
    if (p.value == null) { missingTickers.push(p.ticker); return; }
    const status = p.market?.price_status;
    if (status === "STALE_RATE_LIMITED") rateLimitedTickers.push(p.ticker);
    else if (status === "STALE") staleTickers.push(p.ticker);
  });

  let status = "ALL_GOOD";
  if (rateLimitedTickers.length > 0 || providerHealth === "RATE_LIMITED") status = "PROVIDER_RATE_LIMITED";
  else if (missingTickers.length > 0) status = "PARTIAL_MISSING";
  else if (staleTickers.length > 0) status = "PARTIAL_STALE";

  return {
    status,
    staleTickers, rateLimitedTickers, missingTickers,
    staleCount: staleTickers.length + rateLimitedTickers.length,
    missingCount: missingTickers.length,
  };
}

// ================== Sprint P5 (Portfolio Weights / Allocation Truth) ==================
// Funciones PURAS -- misma disciplina que el resto del archivo: cero
// decision de red/cache aqui, solo consumen `enrichedPositions` (ya
// resuelto por enrichPositions arriba) y numeros ya calculados
// (patrimonio, futuresEquityUsd). Dos metricas DISTINTAS, nunca
// mezcladas (item 1 del sprint):
//
// PORTFOLIO_WEIGHT_PCT = value / SUM(value de posiciones tradicionales
// valuadas) -- "que porcentaje de MI PORTAFOLIO (acciones+cripto+
// efectivo, sin Futures) es esta posicion". Futures nunca entra al
// universo tradicional (item 7 -- no double counting, ya estructural:
// enrichedPositions nunca incluye Futures, viene de una fuente de datos
// separada).
//
// TOTAL_NET_WORTH_WEIGHT_PCT = value / Patrimonio_Total -- "que
// porcentaje de TODO mi patrimonio (incluye Futures Equity) es esta
// posicion".
//
// Antes de este sprint, src/App.jsx solo calculaba la segunda metrica
// (6 veces, duplicada, mal llamada "Allocation") y NUNCA la primera --
// ver auditoria previa "PORTFOLIO WEIGHT / ALLOCATION -- AUDITORIA".

const TRADITIONAL_TYPES = new Set(["stock", "crypto", "cash"]);

// PORTFOLIO_WEIGHT_PCT -- denominador = SOLO posiciones tradicionales
// valuadas (nunca Futures). status:
// - DATA_UNAVAILABLE: no hay ningun valor tradicional utilizable (nunca
//   se divide por 0, nunca se muestra un % inventado).
// - PARTIAL: existe al menos una posicion tradicional sin `value`
//   (p.ej. DATA_UNAVAILABLE de precio, o unclassified) -- los pesos SI
//   se calculan para las que SI tienen precio, pero sobre un universo
//   que el llamador debe presentar como incompleto, NUNCA renormalizado
//   silenciosamente a 100% (item 3 del sprint).
// - COMPLETE: todas las posiciones tradicionales tienen `value`.
export function computePortfolioWeights(enrichedPositions) {
  const traditional = (enrichedPositions || []).filter((p) => TRADITIONAL_TYPES.has(p.type));
  const valued = traditional.filter((p) => p.value != null);
  const totalTraditionalValue = valued.reduce((a, p) => a + p.value, 0);

  let status;
  if (totalTraditionalValue <= 0) status = "DATA_UNAVAILABLE";
  else if (valued.length < traditional.length) status = "PARTIAL";
  else status = "COMPLETE";

  const weights = valued.map((p) => ({
    id: p.id, ticker: p.ticker, type: p.type, value: p.value,
    portfolio_weight_pct: totalTraditionalValue > 0 ? (p.value / totalTraditionalValue) * 100 : null,
  }));

  return { status, totalTraditionalValue, missingCount: traditional.length - valued.length, weights };
}

// TOTAL_NET_WORTH_WEIGHT_PCT -- denominador = Patrimonio_Total (incluye
// Futures). COMPLETE exige TODO: portfolioWeightStatus==="COMPLETE" Y
// Futures completo Y patrimonio>0 -- un patrimonio "completo" que se
// para sobre una valuacion tradicional parcial sigue siendo parcial
// (item 3: "todas las posiciones tradicionales estan valuadas, cash es
// conocido, Futures Equity es completo, Patrimonio Total es completo").
export function computeNetWorthWeights(enrichedPositions, patrimonio, portfolioWeightStatus, futuresIsComplete) {
  const traditional = (enrichedPositions || []).filter((p) => TRADITIONAL_TYPES.has(p.type));
  const valued = traditional.filter((p) => p.value != null);

  let status;
  if (!(patrimonio > 0)) status = "DATA_UNAVAILABLE";
  else if (portfolioWeightStatus === "COMPLETE" && futuresIsComplete === true) status = "COMPLETE";
  else status = "PARTIAL";

  const weights = valued.map((p) => ({
    id: p.id, ticker: p.ticker, type: p.type, value: p.value,
    net_worth_weight_pct: patrimonio > 0 ? (p.value / patrimonio) * 100 : null,
  }));

  return { status, patrimonio, weights };
}

// Breakdown del Patrimonio Total para el pie "Dónde está tu dinero" /
// tab Allocation (item 6): las categorias son EXACTAMENTE los
// componentes que suman Patrimonio Total (Acciones+Cripto+Efectivo+
// Futures Equity = patrimonioBase+futuresEquityUsd = patrimonio, por
// construccion de computePatrimonio) -- por eso los % SI suman ~100%,
// a diferencia del pie anterior que omitia Futures como categoria
// mientras lo seguia contando en el denominador.
export function computePatrimonioBreakdown({ stocksValue, cryptoValue, cashValue, futuresEquityUsd, patrimonio }) {
  const categories = [
    { name: "Acciones", value: stocksValue || 0 },
    { name: "Cripto", value: cryptoValue || 0 },
    { name: "Efectivo", value: cashValue || 0 },
    { name: "Futures Equity", value: futuresEquityUsd || 0 },
  ].filter((c) => c.value > 0);
  return categories.map((c) => ({ ...c, pct: patrimonio > 0 ? (c.value / patrimonio) * 100 : null }));
}

// Concentracion (item 5): SIEMPRE sobre PORTFOLIO_WEIGHT_PCT (portafolio
// tradicional), NUNCA sobre Patrimonio Total -- recibe directamente
// `weights` de computePortfolioWeights(...) para no poder mezclar
// universos por accidente. status espeja el status de weights: si no es
// COMPLETE, el llamador debe mostrar CONCENTRATION_DATA_PARTIAL en vez
// de disparar una alerta automatica de concentracion como si fuera
// confiable (item 5/item 10-J).
export function computeConcentration(portfolioWeightsResult) {
  const { status, weights } = portfolioWeightsResult || { status: "DATA_UNAVAILABLE", weights: [] };
  const sorted = [...(weights || [])].sort((a, b) => b.value - a.value);
  const sumTopN = (n) => sorted.slice(0, n).reduce((a, p) => a + (p.portfolio_weight_pct || 0), 0);
  return {
    status: status === "COMPLETE" ? "COMPLETE" : "CONCENTRATION_DATA_PARTIAL",
    top1_pct: sumTopN(1), top3_pct: sumTopN(3), top5_pct: sumTopN(5), top10_pct: sumTopN(10),
    top5: sorted.slice(0, 5), top10: sorted.slice(0, 10),
  };
}
