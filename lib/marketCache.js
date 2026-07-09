// lib/marketCache.js
// Cache compartido en Supabase (tabla market_cache) para cualquier dato de
// mercado que casi no cambia en el dia (rango 52w, market cap, indices).
// Se usa desde api/market-data.js y api/market-pulse.js -- una sola fuente
// de verdad para no duplicar la logica de cache en dos archivos.

const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 horas, default

export async function getCache(supabase, key, ttlMs = CACHE_TTL_MS) {
  try {
    const { data } = await supabase.from("market_cache").select("*").eq("ticker", key).maybeSingle();
    if (!data) return null;
    const age = Date.now() - new Date(data.updated_at).getTime();
    if (age > ttlMs) return null;
    return data;
  } catch (e) {
    return null;
  }
}

export async function setCache(supabase, key, type, fields) {
  try {
    await supabase.from("market_cache").upsert([{ ticker: key, type, ...fields, updated_at: new Date().toISOString() }]);
  } catch (e) {
    // si falla el guardado de cache no debe tronar la respuesta principal
  }
}
