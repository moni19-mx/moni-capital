// lib/priceTruthProbeState.js
// Price Truth Stability Probe -- funciones PURAS de clasificacion y
// assertions. CERO red, CERO Supabase, CERO temporizadores. Consumen
// exactamente el JSON ya parseado que devuelven HOY api/market-data.js
// y api/futures-equity.js -- nunca inventan un campo que esos
// endpoints no exponen (ver limitacion documentada abajo sobre
// `reason`). scripts/priceTruthProbe.mjs es el unico llamador real
// (fetch + loop + escritura de artifacts); este archivo existe aparte
// para que la logica de deteccion sea testeable sin red.
//
// Observa. No corrige. Nunca cambia formulas financieras, TTLs,
// MAX_STALE_AGE, breaker behavior, ni el schema de market_cache.

export const USABLE_PRICE_STATUSES = ["LIVE", "CACHED", "STALE", "STALE_RATE_LIMITED"];

// ================== market-data.js ==================
// api/market-data.js devuelve {data: {ticker: {price, price_status,
// price_source, price_fetched_at, ...}}, errors: [ticker, ...]} --
// un ticker SOLO aparece en `errors` cuando es DATA_UNAVAILABLE, y el
// endpoint NUNCA expone la `reason` interna (p.ej.
// "exceeded_max_stale_age") en la respuesta HTTP publica -- esa razon
// vive solo dentro de lib/marketDataOrchestrator.js y nunca se
// serializa (ver api/market-data.js:120-126). No se inventa aqui.
export function classifyMarketDataIteration(marketDataJson, requestedTickers) {
  const data = (marketDataJson && marketDataJson.data) || {};
  const errors = new Set((marketDataJson && marketDataJson.errors) || []);
  const byTicker = {};
  for (const ticker of requestedTickers) {
    if (errors.has(ticker)) {
      byTicker[ticker] = { status: "DATA_UNAVAILABLE", price: null, source: null, fetched_at: null };
      continue;
    }
    const d = data[ticker];
    byTicker[ticker] = d
      ? { status: d.price_status || null, price: d.price ?? null, source: d.price_source || null, fetched_at: d.price_fetched_at || null }
      // Ni en `data` ni en `errors` -- no deberia pasar nunca segun el
      // contrato actual del endpoint; se reporta explicito si pasa, en
      // vez de asumir DATA_UNAVAILABLE silenciosamente.
      : { status: "MISSING_FROM_RESPONSE", price: null, source: null, fetched_at: null };
  }
  return byTicker;
}

// ================== futures-equity.js ==================
// api/futures-equity.js devuelve {total_value_usd, is_complete,
// accounts: [{account_id, product_type, valuation_status, balances:
// [{ticker, value_usd, status, price_status, price_source,
// price_fetched_at, equity_value}]}], warnings: [...]}. product_type
// real confirmado contra la DB: "USD_M" / "COIN_M" (con guion bajo,
// nunca con guion).
export function classifyFuturesIteration(futuresJson) {
  const accounts = (futuresJson && futuresJson.accounts) || [];
  const result = {
    total_value_usd: futuresJson ? futuresJson.total_value_usd ?? null : null,
    is_complete: futuresJson ? futuresJson.is_complete ?? null : null,
    warnings: (futuresJson && futuresJson.warnings) || [],
    usdm: null,
    coinm: null,
  };
  for (const acc of accounts) {
    const bucket = acc.product_type === "USD_M" ? "usdm" : acc.product_type === "COIN_M" ? "coinm" : null;
    if (!bucket) continue;
    const balance = (acc.balances && acc.balances[0]) || null;
    result[bucket] = {
      account_id: acc.account_id,
      account_name: acc.account_name ?? null,
      ticker: balance ? balance.ticker : null,
      equity_raw: balance ? balance.equity_value ?? null : null,
      price_usd_per_unit: balance ? balance.price_usd_per_unit ?? null : null,
      value_usd: balance ? balance.value_usd ?? null : null,
      valuation_status: balance ? balance.status : null, // "OK" | "PRICE_UNAVAILABLE" | "DATA_UNAVAILABLE" (valuateAccountEquity) -- NUNCA hay un campo "reason" en este objeto, api/futures-equity.js no lo expone; nunca se inventa aqui.
      price_status: balance ? balance.price_status ?? null : null,
      price_source: balance ? balance.price_source ?? null : null,
      price_fetched_at: balance ? balance.price_fetched_at ?? null : null,
      account_valuation_status: acc.valuation_status, // "OK" | "PARTIAL"
      is_stale: acc.is_stale ?? null, // antiguedad del SNAPSHOT (account_snapshots.observed_at), NUNCA la del precio -- ver price_fetched_at arriba, P0.4 item 10
      included: acc.valuation_status === "OK",
    };
  }
  return result;
}

// ================== Diagnostic mode (short, non-certification probe) ==================
// Herramientas PURAS para el modo diagnostico de 3 iteraciones -- nunca
// se usan durante la corrida de certificacion de 16 iteraciones (esa
// sigue exactamente igual). Objetivo: capturar evidencia SEGURA de un
// 401/no-2xx (fingerprint) sin loguear nunca un secreto/cookie/valor de
// Authorization.

// Headers seguros de capturar para diagnosticar el origen de un
// 401/403 -- whitelist explicita, nunca una blacklist (mas seguro por
// diseño: un header nuevo desconocido nunca se loguea por accidente).
const SAFE_DIAGNOSTIC_HEADER_NAMES = [
  "content-type", "server", "x-vercel-id", "x-vercel-cache", "x-vercel-error",
  "www-authenticate", "cache-control", "location", "content-length",
];

export function sanitizeHeadersForLog(headers) {
  const out = {};
  if (!headers) return out;
  const entries = typeof headers.entries === "function" ? [...headers.entries()] : Object.entries(headers);
  for (const [key, value] of entries) {
    const lower = key.toLowerCase();
    if (SAFE_DIAGNOSTIC_HEADER_NAMES.includes(lower)) out[lower] = value;
  }
  // set-cookie: nunca se loguea el valor (podria contener session/tokens) -- solo si existe o no.
  const hasSetCookie = entries.some(([k]) => k.toLowerCase() === "set-cookie");
  if (hasSetCookie) out["set-cookie"] = "PRESENT_REDACTED";
  return out;
}

export function truncateBody(text, maxLen = 500) {
  if (text == null) return null;
  const s = String(text);
  return s.length > maxLen ? `${s.slice(0, maxLen)}...[truncated, ${s.length} bytes total]` : s;
}

// Clasifica el 401/403 SOLO cuando hay evidencia fuerte -- nunca
// adivina "WAF" o "Deployment Protection" sin una señal concreta.
// Default: UNKNOWN_NON_2XX_SOURCE, explicito, nunca oculto detras de
// una etiqueta que suene mas certera de lo que realmente es.
export function classifyResponseFingerprint({ status, contentType, bodySnippet, headers }) {
  if (status >= 200 && status < 300) return "OK";
  const isJson = (contentType || "").includes("application/json");
  const body = (bodySnippet || "").toLowerCase();
  const h = headers || {};

  // Nuestro propio shape exacto de checkAdminAuth -- pero market-data.js
  // NUNCA importa checkAdminAuth (verificado en el codigo), asi que este
  // caso documenta la imposibilidad en vez de ocultarla.
  if (isJson && body.includes('"error"') && body.includes("unauthorized")) return "APP_LEVEL_REJECTION_UNEXPECTED";

  // Vercel Deployment Protection (Vercel Authentication) tipicamente
  // redirige a una pagina de login propia de Vercel -- senal fuerte:
  // el body menciona "vercel" Y "authenticate"/"sso", o hay un header
  // x-vercel-id sin ningun otro indicio de nuestra propia app.
  if (body.includes("vercel") && (body.includes("authenticat") || body.includes("sso"))) return "VERCEL_DEPLOYMENT_PROTECTION_LIKELY";

  // Firewall/bot-challenge de Vercel -- senal fuerte: header dedicado
  // x-vercel-error, o el body menciona "challenge"/"denied"/"blocked"
  // junto con un x-vercel-id.
  if (h["x-vercel-error"] || (body.includes("challenge") || body.includes("blocked")) && h["x-vercel-id"]) return "VERCEL_FIREWALL_LIKELY";

  return "UNKNOWN_NON_2XX_SOURCE";
}

// Verdict del modo diagnostico -- vocabulario DISTINTO de PASS/FAIL
// (nunca se confunde con una certificacion de Price Truth). OK
// significa "el harness produce resultados interpretables", no "Price
// Truth esta bien" -- eso solo lo dice la corrida de 16 iteraciones.
export function buildDiagnosticVerdict({ marketDataResults, futuresResults }) {
  const marketDataAllOk = marketDataResults.every((r) => r.status >= 200 && r.status < 300);
  const futuresAllOk = futuresResults.every((r) => r.status >= 200 && r.status < 300);
  return marketDataAllOk && futuresAllOk ? "DIAGNOSTIC_OK" : "DIAGNOSTIC_BLOCKED";
}

// ================== LKG regression ==================
// Contrato bajo prueba: una vez que el probe observo un status usable
// (LIVE/CACHED/STALE/STALE_RATE_LIMITED) para un ticker, ese ticker
// NUNCA deberia volver a DATA_UNAVAILABLE dentro de esta corrida.
// MAX_STALE_AGE_MS=24h (lib/priceCache.js) hace que "expiro
// legitimamente" sea estructuralmente imposible dentro de una ventana
// de ~15 minutos -- si ya habia expirado, apareceria DATA_UNAVAILABLE
// desde la primera iteracion, nunca como transicion a mitad de
// corrida. Por eso NO se acepta ninguna excepcion aqui.
export function detectLkgRegression({ ticker, provider, previousBest, current, iterationIndex, providerHealth }) {
  const isUsable = (s) => USABLE_PRICE_STATUSES.includes(s);
  const currentIsUsable = isUsable(current.status);

  if (!previousBest || !isUsable(previousBest.status)) {
    return { regression: null, newBest: currentIsUsable ? { ...current, iteration: iterationIndex } : previousBest || null };
  }

  if (current.status === "DATA_UNAVAILABLE") {
    return {
      regression: {
        ticker, provider,
        previous_iteration: previousBest.iteration, previous_status: previousBest.status, previous_price: previousBest.price,
        current_iteration: iterationIndex, provider_health: providerHealth ?? null,
        current_error_state: "DATA_UNAVAILABLE",
      },
      // El "mejor conocido" se conserva -- si vuelve a desaparecer en
      // una iteracion futura, se sigue detectando (no se resetea el
      // baseline solo porque ya regreso una vez).
      newBest: previousBest,
    };
  }
  return { regression: null, newBest: currentIsUsable ? { ...current, iteration: iterationIndex } : previousBest };
}

// ================== Cross-provider isolation (revision correccion 2) ==================
// NUNCA infiere contaminacion solo porque un proveedor esta
// RATE_LIMITED y, en paralelo, algun ticker del OTRO proveedor aparece
// DATA_UNAVAILABLE -- eso puede ser una condicion preexistente sin
// relacion real (instruccion explicita del usuario: "Do not infer
// causation from simultaneous missing tickers alone").
//
// finnhub_status/coingecko_status vienen de summarizeProviderHealth,
// que SOLO lee los resultados y el breaker DEL PROPIO proveedor
// (marketDataOrchestrator.js:118-130, breakers son objetos
// independientes desde api/market-data.js:63) -- por diseño, es
// estructuralmente imposible que el status agregado de un proveedor
// cambie por una falla del otro, SALVO que exista un bug real. La
// unica evidencia fuerte observable desde fuera (el endpoint no expone
// `reason` interno) es: el status agregado del proveedor B empeora en
// la MISMA iteracion en que A entra en RATE_LIMITED, viniendo de un
// estado sano en la iteracion anterior. Se marca como correlacional,
// nunca como prueba definitiva de causalidad.
const DEGRADED_PROVIDER_STATUSES = new Set(["RATE_LIMITED", "PROVIDER_ERROR", "AUTH_ERROR"]);

export function detectCrossProviderContamination({ providerAName, providerBName, prevStatuses, currStatuses }) {
  const aNewlyRateLimited = currStatuses[providerAName] === "RATE_LIMITED" && (!prevStatuses || prevStatuses[providerAName] !== "RATE_LIMITED");
  const bWasHealthy = !!prevStatuses && !DEGRADED_PROVIDER_STATUSES.has(prevStatuses[providerBName]);
  const bNowDegraded = DEGRADED_PROVIDER_STATUSES.has(currStatuses[providerBName]);
  if (aNewlyRateLimited && bWasHealthy && bNowDegraded) {
    return {
      violation: true, provider_a: providerAName, provider_b: providerBName,
      provider_b_before: prevStatuses[providerBName], provider_b_after: currStatuses[providerBName],
      note: "Correlacional: el status agregado de un proveedor solo deberia depender de sus propios resultados/breaker. El endpoint no expone `reason` interno, asi que esto es evidencia fuerte de coincidencia temporal, no una prueba causal absoluta -- requiere revision manual.",
    };
  }
  return { violation: false };
}

// ================== Futures valuation regression (equivalente LKG para USD-M/COIN-M) ==================
export function detectFuturesValuationRegression({ bucket, previousIncluded, currentIncluded, iterationIndex, current }) {
  if (!previousIncluded || !previousIncluded.included) return { regression: null, newIncluded: currentIncluded && currentIncluded.included ? { ...currentIncluded, iteration: iterationIndex } : previousIncluded || null };
  if (!currentIncluded || !currentIncluded.included) {
    return {
      regression: {
        bucket, previous_iteration: previousIncluded.iteration, previous_value_usd: previousIncluded.value_usd,
        current_iteration: iterationIndex, current_valuation_status: current ? current.valuation_status : null,
        current_price_status: current ? current.price_status : null,
      },
      newIncluded: previousIncluded,
    };
  }
  return { regression: null, newIncluded: { ...currentIncluded, iteration: iterationIndex } };
}

// ================== Summary ==================
export function buildProbeSummary({
  startedAt, finishedAt, requestedIterations, actualIterations,
  httpFailures, finnhubRateLimitEvents, coingeckoRateLimitEvents,
  providerIsolationViolations, lkgRegressions, futuresRegressions,
  tickerAvailability, usdmAvailability, coinmAvailability,
  futuresEquityMinMax, dataUnavailableLog, staleTransitionLog,
  codeBaseSha, probeCommitSha,
}) {
  const elapsedSeconds = startedAt && finishedAt ? Math.round((new Date(finishedAt).getTime() - new Date(startedAt).getTime()) / 1000) : null;
  const verdict = lkgRegressions.length === 0
    && futuresRegressions.length === 0
    && providerIsolationViolations.length === 0
    && httpFailures.length === 0
    ? "PASS" : "FAIL";

  const lines = [];
  lines.push("# PRICE TRUTH STABILITY PROBE");
  lines.push("");
  lines.push(`verdict: **${verdict}**`);
  lines.push("");
  lines.push(`code_base_sha: ${codeBaseSha}`);
  if (probeCommitSha) lines.push(`probe_commit_sha: ${probeCommitSha}`);
  lines.push(`started_at: ${startedAt}`);
  lines.push(`finished_at: ${finishedAt}`);
  lines.push(`elapsed_seconds: ${elapsedSeconds}`);
  lines.push(`requested_iterations: ${requestedIterations} | actual_iterations: ${actualIterations}`);
  lines.push(`http_failures: ${httpFailures.length}`);
  lines.push(`finnhub_rate_limit_events: ${finnhubRateLimitEvents}`);
  lines.push(`coingecko_rate_limit_events: ${coingeckoRateLimitEvents}`);
  lines.push(`provider_isolation_violations: ${providerIsolationViolations.length}`);
  lines.push(`REGRESSION_LKG_DISAPPEARED count: ${lkgRegressions.length}`);
  lines.push(`futures valuation regressions: ${futuresRegressions.length}`);
  lines.push("");
  lines.push("## Availability por ticker (X/actual_iterations, status usable)");
  for (const [ticker, count] of Object.entries(tickerAvailability)) {
    lines.push(`- ${ticker}: ${count}/${actualIterations}`);
  }
  lines.push(`- USD-M valuation: ${usdmAvailability}/${actualIterations}`);
  lines.push(`- COIN-M valuation: ${coinmAvailability}/${actualIterations}`);
  lines.push("");
  if (futuresEquityMinMax) {
    lines.push(`## Futures Equity min/max: ${futuresEquityMinMax.min} / ${futuresEquityMinMax.max}`);
    lines.push("");
  }
  if (lkgRegressions.length > 0) {
    lines.push("## REGRESSION_LKG_DISAPPEARED");
    lkgRegressions.forEach((r) => lines.push(`- ${r.ticker} (${r.provider}): iter ${r.previous_iteration} (${r.previous_status}, price=${r.previous_price}) -> iter ${r.current_iteration} DATA_UNAVAILABLE (provider_health=${JSON.stringify(r.provider_health)})`));
    lines.push("");
  }
  if (futuresRegressions.length > 0) {
    lines.push("## Futures valuation regressions");
    futuresRegressions.forEach((r) => lines.push(`- ${r.bucket}: iter ${r.previous_iteration} (value_usd=${r.previous_value_usd}) -> iter ${r.current_iteration} excluded (valuation_status=${r.current_valuation_status}, price_status=${r.current_price_status})`));
    lines.push("");
  }
  if (providerIsolationViolations.length > 0) {
    lines.push("## Provider isolation violations (correlacional, ver nota)");
    providerIsolationViolations.forEach((v) => lines.push(`- ${v.provider_a} rate-limited -> ${v.provider_b} ${v.provider_b_before} -> ${v.provider_b_after}. ${v.note}`));
    lines.push("");
  }
  if (dataUnavailableLog.length > 0) {
    lines.push("## Toda ocurrencia DATA_UNAVAILABLE");
    dataUnavailableLog.forEach((e) => lines.push(`- iter ${e.iteration} [${e.timestamp}]: ${e.ticker}`));
    lines.push("");
  }
  if (staleTransitionLog.length > 0) {
    lines.push("## Transiciones STALE/STALE_RATE_LIMITED");
    staleTransitionLog.forEach((e) => lines.push(`- iter ${e.iteration} [${e.timestamp}]: ${e.ticker} ${e.from} -> ${e.to}`));
    lines.push("");
  }
  if (httpFailures.length > 0) {
    lines.push("## HTTP failures");
    httpFailures.forEach((f) => lines.push(`- iter ${f.iteration} [${f.timestamp}] ${f.endpoint}: status=${f.status} ${f.detail || ""}`));
    lines.push("");
  }
  return { markdown: lines.join("\n"), verdict, elapsedSeconds };
}
