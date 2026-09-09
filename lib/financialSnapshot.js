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

export function buildMarketDataItems(positions, watchlist) {
  const items = [];
  const seen = new Set();
  [...(positions || []).filter((p) => p.type !== "cash"), ...(watchlist || [])].forEach((p) => {
    const key = `${p.ticker}-${p.type}`;
    if (seen.has(key)) return;
    seen.add(key);
    items.push({ ticker: p.ticker, type: p.type, coingeckoId: p.coingecko_id || undefined });
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
