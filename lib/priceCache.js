// lib/priceCache.js
// Micro-sprint P0.3 (Market Price Cache + Provider Resilience). Funciones
// PURAS -- CERO Supabase, CERO red, CERO formula financiera. Decide
// SOLO frescura/politica de cache y clasificacion de estado de un
// precio; el llamador (api/market-data.js) hace las lecturas/escrituras
// reales a market_cache y aplica esta politica.
//
// Cambio deliberado de una decision previa documentada: lib/aiPriceCache.js
// dice explicitamente "El dashboard humano sigue sin cachear Nivel A
// (precio) jamas -- esto NO lo toca". Este sprint SI cambia esa
// decision para el dashboard humano, a proposito: el hallazgo real de
// P0.2 (Finnhub puede fallar/rate-limitear las 35 quotes de golpe) deja
// claro que "vivo siempre" ya no es sostenible sin una capa de
// resiliencia. El tradeoff (frescura perfecta -> frescura de hasta
// 30s/15min segun mercado) es intencional y documentado, no un
// descuido -- ver REPORTE FINAL de P0.3.

export const MARKET_OPEN_TTL_MS = 30 * 1000; // 30s -- la mitad del intervalo de polling real (60s, ver src/App.jsx), asi que un poll normal SIEMPRE encuentra el cache vencido y refresca, pero un refresh manual o de Smart Import disparado justo despues de un poll reciente reusa el mismo precio en vez de pedirlo de nuevo.
export const MARKET_CLOSED_TTL_MS = 15 * 60 * 1000; // 15min -- fuera de horario el precio no se mueve de forma que importe para un dashboard de patrimonio personal (no un terminal de trading); reduce drasticamente llamadas redundantes en el uso mas comun (revisar el portafolio de noche/fin de semana).
export const CRYPTO_TTL_MS = MARKET_OPEN_TTL_MS; // cripto opera 24/7 -- no aplica la distincion open/closed, usa el TTL corto siempre.

// Heuristica SIMPLE (Lunes-Viernes, 9:30-16:00 hora de New York) --
// deliberadamente NO implementa un calendario de feriados/early-close
// real (instruccion explicita del sprint: "no implementar calendarios
// complejos si no existen"). Peor caso si se equivoca (un feriado de
// mercado real): usa el TTL corto (30s) en vez del largo (15min) un
// dia al año -- nunca produce un precio incorrecto, solo un poco menos
// optimo en request-reduction ese dia puntual.
export function isLikelyMarketOpen(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(now);
  const map = {};
  parts.forEach((p) => { map[p.type] = p.value; });
  if (map.weekday === "Sat" || map.weekday === "Sun") return false;
  const hour = Number(map.hour === "24" ? "0" : map.hour);
  const minute = Number(map.minute);
  const minutesSinceMidnight = hour * 60 + minute;
  return minutesSinceMidnight >= 9 * 60 + 30 && minutesSinceMidnight < 16 * 60;
}

export function computeTtlMs(assetType, now = new Date()) {
  if (assetType === "crypto") return CRYPTO_TTL_MS;
  return isLikelyMarketOpen(now) ? MARKET_OPEN_TTL_MS : MARKET_CLOSED_TTL_MS;
}

export function isCacheFresh(fetchedAtIso, now, ttlMs) {
  if (!fetchedAtIso) return false;
  const age = now.getTime() - new Date(fetchedAtIso).getTime();
  return age >= 0 && age < ttlMs;
}

// Clasifica el resultado final para UN ticker -- el llamador arma este
// objeto a partir de lo que realmente paso (nunca se adivina aqui).
// Nunca devuelve "LIVE"/"CACHED" como si fueran lo mismo -- el
// contrato (item 10) exige distinguir price_status siempre.
export function classifyPriceStatus({ hasFreshCache, hasStaleCache, liveSucceeded, rateLimited }) {
  if (liveSucceeded) return "LIVE";
  if (hasFreshCache) return "CACHED";
  if (hasStaleCache) return rateLimited ? "STALE_RATE_LIMITED" : "STALE";
  return "DATA_UNAVAILABLE";
}

// ================== Circuit breaker (dentro de una sola corrida) ==================
// Un objeto mutable simple, creado UNA vez por invocacion de
// api/market-data.js y pasado a mapWithConcurrency -- no persiste
// entre invocaciones (los workers de Vercel son stateless), pero
// dentro de UNA corrida evita seguir golpeando un proveedor que ya
// respondio 429 para los tickers restantes del mismo batch.
export function createRateLimitBreaker() {
  return { tripped: false, trippedAt: null };
}

export function tripBreaker(breaker, now = new Date()) {
  breaker.tripped = true;
  breaker.trippedAt = now.toISOString();
  return breaker;
}

export function isBreakerTripped(breaker) {
  return !!(breaker && breaker.tripped);
}
