// lib/assetResolver.js
// Capa neutral de resolucion/creacion de assets. Dos mitades separadas
// en el mismo archivo (mismo dominio -- identidad de un asset -- dos
// consumidores distintos):
//
//   1. resolveAsset/resolveAssetById/createAsset -- lado SERVIDOR,
//      consultan Supabase directo. Consumidas por api/manage.js. Sin
//      cambios en este sprint (P1 Universal Asset Detail).
//
//   2. resolveAssetIdentity (abajo) -- lado CLIENTE, funcion PURA: cero
//      red, cero Supabase, cero PIN. Consume solo datos que src/App.jsx
//      ya tiene cargados en memoria (positions/watchlist) mas lo que el
//      llamador de openAsset() ya sabe. Es el resolver canonico
//      centralizado en App.jsx::openAsset() (Sprint P1) -- ningun call
//      site de onOpenAsset necesita parchearse individualmente para
//      quedar bien resuelto (ver App.jsx::openAsset).

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

// Resuelve por asset_id directo -- usado cuando un user_edit provee un
// asset_id numerico ya elegido (ej. de un selector), no un ticker de texto.
export async function resolveAssetById(supabase, assetId) {
  if (assetId == null) {
    return { status: "error", error: "missing_asset_id" };
  }
  const { data, error } = await supabase.from("assets").select("*").eq("asset_id", assetId).maybeSingle();
  if (error) throw error;
  if (!data) {
    return { status: "UNKNOWN_ASSET", ticker_normalized: null, asset_id: assetId, asset: null };
  }
  return { status: "MATCHED_ASSET", ticker_normalized: data.ticker, asset_id: data.asset_id, asset: data };
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

// ================== resolveAssetIdentity (cliente, PURA) ==================
// Resuelve {ticker, type, name, coingeckoId} para abrir Asset Detail
// desde CUALQUIER caller (posicion, watchlist, Discover/busqueda,
// Decisions {ticker} suelto, etc.) con una sola precedencia explicita,
// nunca adivina `type`:
//
//   A. Metadata de confianza del caller -- el caller ya trae un `type`
//      no nulo (filas ya cargadas de positions/watchlist/Discover ya
//      vienen asi). Un {ticker} suelto (ej. Decisions) NO califica aqui.
//   B. Metadata canonica local, SI esta cargada hoy -- `canonicalAssetsByTicker`
//      es opcional y hoy nunca se pasa (App.jsx no carga un catalogo de
//      assets todavia); existe para extension futura (catalogo completo,
//      metadata de Discover, provider symbol registry) sin romper esta
//      firma ni a ningun caller existente.
//   C. positions/watchlist ya cargados en memoria -- esto es lo que
//      resuelve el bug real de Decisions: un ticker referenciado ahi
//      SIEMPRE esta tambien en `positions` hoy (decisions se generan
//      sobre posiciones existentes), asi que cae aqui y queda resuelto.
//   D. No resuelto -- NUNCA se inventa un type. El caller (App.jsx::
//      openAsset) recibe type:null y AssetDetailScreen debe renderizar
//      un estado explicito "pendiente de resolver", nunca pedir
//      market-data con type undefined ni crashear.
export function resolveAssetIdentity({ callerMeta, positions, watchlist, canonicalAssetsByTicker } = {}) {
  const ticker = normalizeTickerInput(callerMeta && callerMeta.ticker);
  if (!ticker) {
    return { ticker: null, type: null, name: null, coingeckoId: null, resolved: false, source: "UNRESOLVED" };
  }

  if (callerMeta.type != null) {
    return {
      ticker, type: callerMeta.type, name: callerMeta.name ?? ticker,
      coingeckoId: callerMeta.coingeckoId ?? null, resolved: true, source: "CALLER_TRUSTED",
    };
  }

  const canonical = canonicalAssetsByTicker && canonicalAssetsByTicker[ticker];
  if (canonical && canonical.type != null) {
    return {
      ticker, type: canonical.type, name: canonical.name ?? callerMeta.name ?? ticker,
      coingeckoId: canonical.coingeckoId ?? callerMeta.coingeckoId ?? null, resolved: true, source: "CANONICAL_LOCAL",
    };
  }

  const fromPosition = (positions || []).find((p) => p.ticker === ticker);
  if (fromPosition && fromPosition.type != null) {
    return {
      ticker, type: fromPosition.type, name: fromPosition.name ?? callerMeta.name ?? ticker,
      coingeckoId: fromPosition.coingecko_id ?? callerMeta.coingeckoId ?? null, resolved: true, source: "POSITION",
    };
  }

  const fromWatchlist = (watchlist || []).find((w) => w.ticker === ticker);
  if (fromWatchlist && fromWatchlist.type != null) {
    return {
      ticker, type: fromWatchlist.type, name: fromWatchlist.name ?? callerMeta.name ?? ticker,
      coingeckoId: fromWatchlist.coingecko_id ?? callerMeta.coingeckoId ?? null, resolved: true, source: "WATCHLIST",
    };
  }

  return {
    ticker, type: null, name: (callerMeta && callerMeta.name) ?? ticker,
    coingeckoId: (callerMeta && callerMeta.coingeckoId) ?? null, resolved: false, source: "UNRESOLVED",
  };
}
