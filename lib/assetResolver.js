// lib/assetResolver.js
// Capa neutral de resolucion/creacion de assets. NO conoce HTTP, PIN,
// Smart Import, ni UI -- solo Supabase y logica de identidad de assets.
// api/manage.js y api/smart-import.js (futuro) consumen exactamente esto,
// nunca una copia propia.

export function normalizeTickerInput(input) {
  if (input == null) return null;
  const t = String(input).trim().toUpperCase();
  return t.length > 0 ? t : null;
}

// Solo LEE. Nunca crea. UNKNOWN_ASSET es un resultado valido, no un error.
export async function resolveAsset(supabase, rawTicker) {
  const ticker_normalized = normalizeTickerInput(rawTicker);
  if (!ticker_normalized) {
    return { status: "error", error: "missing_ticker", ticker_normalized: null, asset_id: null, asset: null };
  }

  const { data, error } = await supabase.from("assets").select("*").eq("ticker", ticker_normalized);
  if (error) throw error;

  if (!data || data.length === 0) {
    return { status: "UNKNOWN_ASSET", ticker_normalized, asset_id: null, asset: null };
  }
  if (data.length > 1) {
    return { status: "ASSET_AMBIGUOUS", ticker_normalized, asset_id: null, asset: null, candidates: data };
  }
  return { status: "MATCHED_ASSET", ticker_normalized, asset_id: data[0].asset_id, asset: data[0] };
}

// Accion EXPLICITA -- el llamador (manage.js hoy, potencialmente
// smart-import.js despues) ya decidio crear el asset. Idempotente: si
// ya existe (carrera con otro proceso), devuelve el existente en vez de
// duplicar o fallar.
export async function createAsset(supabase, { ticker, name, asset_type, exchange, currency, provider_symbols, created_source }) {
  const ticker_normalized = normalizeTickerInput(ticker);
  if (!ticker_normalized) {
    return { status: "error", error: "missing_ticker" };
  }

  const { data: existing, error: findErr } = await supabase.from("assets").select("*").eq("ticker", ticker_normalized);
  if (findErr) throw findErr;
  if (existing && existing.length === 1) {
    return { status: "MATCHED_ASSET", ticker_normalized, asset_id: existing[0].asset_id, asset: existing[0], already_existed: true };
  }
  if (existing && existing.length > 1) {
    return { status: "ASSET_AMBIGUOUS", ticker_normalized, asset_id: null, asset: null, candidates: existing };
  }

  const payload = {
    ticker: ticker_normalized,
    name: name || null,
    asset_type: asset_type || null,
    exchange: exchange || null,
    currency: currency || "USD",
    provider_symbols: provider_symbols || {},
    is_active: true,
    created_source: created_source || "MANUAL",
  };
  const { data, error } = await supabase.from("assets").insert([payload]).select();
  if (error) throw error;
  return { status: "MATCHED_ASSET", ticker_normalized, asset_id: data[0].asset_id, asset: data[0], already_existed: false };
}
