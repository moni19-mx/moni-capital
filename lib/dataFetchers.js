// lib/dataFetchers.js
// Sprint P0.1 (Reliable Data Loading). Wrappers de fetch que
// src/App.jsx usa para cargar datos -- extraidos para poder probarlos
// con fetch mockeado, sin depender de un navegador/React.
//
// Regla dura de este sprint: NINGUNO de estos wrappers puede "tragarse"
// un fallo y devolver un valor por default que se vea como un exito.
// Esa era exactamente la causa raiz del bug de Futures Equity
// convirtiendose en $0 en silencio: la version anterior de
// fetchFuturesEquity() atrapaba cualquier error y devolvia
// {total_value_usd: 0, ...} -- indistinguible de "la cuenta realmente
// vale $0". Ahora todos propagan el fallo como rejection; es
// App.jsx::loadAll() quien decide (via lib/dataSourceState.js) conservar
// el ultimo valor valido conocido en vez de aceptar ese $0 falso.
//
// Cero cambios de formula/valuacion aqui -- api/futures-equity.js,
// api/market-data.js, api/market-pulse.js y el schema de Supabase
// siguen exactamente igual. Este archivo solo decide que hacer cuando
// el fetch en si falla.

export async function sbSelectAll(supabaseUrl, anonKey, table) {
  const res = await fetch(`${supabaseUrl}/rest/v1/${table}?select=*`, {
    headers: { apikey: anonKey, Authorization: `Bearer ${anonKey}` },
  });
  if (!res.ok) throw new Error(`No se pudo leer ${table} de Supabase (HTTP ${res.status})`);
  return res.json();
}

export async function fetchMarketDataBatch(items) {
  if (!items.length) return { data: {}, errors: [], updatedAt: null };
  const res = await fetch("/api/market-data", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ items }),
  });
  if (!res.ok) throw new Error(`No se pudieron obtener datos de mercado (HTTP ${res.status})`);
  return res.json();
}

// READ-ONLY: estado actual (solo latest snapshot confirmado por cuenta/
// posicion) de Binance Futures, ya valuado a USD. Nunca escribe nada.
// A diferencia de la version anterior, NUNCA devuelve un objeto "vacio
// de exito" ante un fallo -- propaga el error, para que loadAll()
// conserve el ultimo Futures Equity valido en vez de mostrar $0.
export async function fetchFuturesEquity() {
  const res = await fetch("/api/futures-equity");
  if (!res.ok) throw new Error(`futures_equity_http_${res.status}`);
  return res.json();
}

export async function fetchMarketPulse() {
  const res = await fetch("/api/market-pulse");
  if (!res.ok) throw new Error(`market_pulse_http_${res.status}`);
  return res.json();
}
