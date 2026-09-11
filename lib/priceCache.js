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
//
// Sprint P0.4 (Price Freshness + Request Volume Hardening): TTL de
// mercado-abierto sube de 30s a 90s (decision confirmada por el
// usuario -- "B-ajustada"). Motivo real, no arbitrario: con TTL=30s
// (mitad del poll de 60s) CADA poll normal encuentra el cache vencido a
// proposito -- cero beneficio de cache en estado estable, solo ayuda en
// refreshes casi-simultaneos. Con TTL=60s (=poll) el beneficio seguia
// sin ser confiable: el hueco real entre dos `now` de request consecutivos
// casi nunca es EXACTAMENTE 60000ms (jitter de setInterval + latencia real
// de las lecturas de positions/watchlist antes de llamar a market-data),
// asi que un TTL igual al poll interval encuentra el cache "vencido" casi
// siempre de todos modos. TTL=90s da margen real (1.5x el poll) para que
// la mayoria de los polls sirvan CACHED de verdad -- ver REQUEST MAP /
// tabla PRE-POST del reporte de este sprint para los numeros reales.
export const MARKET_OPEN_TTL_MS = 90 * 1000; // 90s -- ver nota arriba: margen real sobre el poll de 60s, ~33% de reduccion confiable en llamadas live durante horario de mercado.
export const MARKET_CLOSED_TTL_MS = 15 * 60 * 1000; // 15min -- sin cambios, fuera de horario el precio no se mueve de forma que importe para un dashboard de patrimonio personal (no un terminal de trading).
export const CRYPTO_TTL_MS = MARKET_OPEN_TTL_MS; // cripto opera 24/7 -- mismo TTL que stock en horario de mercado (90s), por el mismo motivo de margen real sobre el poll de 60s. Antes estaba atado a 30s (P0.3) que sufria el mismo problema T=P/2 sin beneficio real en estado estable.
export const WATCHLIST_TTL_MS = 5 * 60 * 1000; // 5min -- P0.4 item 3: un ticker que SOLO esta en watchlist (no es una posicion real, no hay dinero en juego) puede tolerar mas antiguedad que uno que si tienes comprado. Un ticker que este en ambos (position + watchlist) SIEMPRE usa el TTL de position (mas corto) -- ver buildMarketDataItems en lib/financialSnapshot.js.

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

// priority: "position" (default, comportamiento previo sin cambios para
// cualquier llamador que no lo pase explicitamente -- ver
// lib/futures-equity.js, que trata BTC/USDT como position-priority por
// ser dinero real en una cuenta activa) o "watchlist" (P0.4 item 3 --
// TTL mas largo, uniforme, sin distincion open/closed: un ticker que
// solo estas observando no necesita la misma urgencia de refresh que
// horario-de-mercado intenta resolver para posiciones reales).
export function computeTtlMs(assetType, now = new Date(), priority = "position") {
  if (priority === "watchlist") return WATCHLIST_TTL_MS;
  if (assetType === "crypto") return CRYPTO_TTL_MS;
  return isLikelyMarketOpen(now) ? MARKET_OPEN_TTL_MS : MARKET_CLOSED_TTL_MS;
}

export function isCacheFresh(fetchedAtIso, now, ttlMs) {
  if (!fetchedAtIso) return false;
  const age = now.getTime() - new Date(fetchedAtIso).getTime();
  return age >= 0 && age < ttlMs;
}

// ================== LKG CONTRACT (Price Truth POST-review) ==================
// Separacion explicita, pedida por el usuario tras el bug real de LKG
// (ETH/LINK/SOL/USDT desapareciendo con hiccups de proveedor):
//
// TTL = cuando INTENTAR un refresh (ver computeTtlMs arriba). Vencer el
// TTL NUNCA significa "el precio ya no sirve" -- solo significa "hay que
// intentar uno nuevo, y si falla, se sigue usando el ultimo conocido".
//
// MAX_STALE_AGE = el UNICO limite real que puede hacer que un LKG deje
// de ser defendible para valuacion. Antes de este cambio, un precio
// STALE podia usarse para siempre si el proveedor nunca se recuperaba,
// sin que el usuario se enterara de que el dato tiene dias. Con este
// limite, pasado MAX_STALE_AGE el LKG se trata como si no existiera
// (DATA_UNAVAILABLE, reason "exceeded_max_stale_age") -- explicito y
// auditable, nunca un colapso silencioso.
//
// Decision del usuario (revisada, NO 7 dias como propuesta inicial):
// 24h para TODO, incluido USDT, "por ahora" -- sin diseño especial de
// stablecoin todavia (eso queda para una version futura con
// second-provider/health especifico). STABLECOIN_TICKERS se declara
// aqui como el lugar donde esa politica futura se activaria, pero HOY
// no cambia el valor de MAX_STALE_AGE_MS -- NUNCA se hardcodea
// USDT=1.00 en ningun lado.
export const MAX_STALE_AGE_MS = 24 * 60 * 60 * 1000; // 24h -- mismo limite para todos los activos, incluido USDT, por decision explicita del usuario.
export const STABLECOIN_TICKERS = ["USDT"]; // whitelist explicita, nunca inferida por nombre -- reservada para una politica futura, sin efecto en MAX_STALE_AGE_MS todavia.

export function isWithinMaxStaleAge(fetchedAtIso, now = new Date()) {
  if (!fetchedAtIso) return false;
  const age = now.getTime() - new Date(fetchedAtIso).getTime();
  return age >= 0 && age < MAX_STALE_AGE_MS;
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

// Bugfix real de P0.3 (encontrado con una prueba SQL directa en
// produccion): `market_cache.type` es NOT NULL sin default. Postgres
// exige que la fila CANDIDATA de un `INSERT ... ON CONFLICT DO UPDATE`
// satisfaga las columnas NOT NULL ANTES de evaluar el conflicto --
// incluso si el UPDATE resultante nunca toca esa columna, y AUNQUE la
// fila YA EXISTA con `type` poblado. El upsert de precio fallaba
// SIEMPRE sin este campo (confirmado con SQL crudo, no solo teoria).
// Un solo lugar para la forma del payload -- evita que el mismo bug
// reaparezca si otro call site construye el upsert a mano.
export function buildCacheWriteRow(ticker, itemType, result) {
  return { ticker, type: itemType, ai_price: result.price, ai_change_pct: result.changePct, ai_price_updated_at: result.fetchedAt };
}
