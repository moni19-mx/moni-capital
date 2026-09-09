// api/finnhub-benchmark-temp.js
//
// DIAGNOSTICO TEMPORAL -- mismo patron que api/fmp-benchmark-temp.js y
// api/sec-benchmark-temp.js (ambos "DIAGNOSTICO TEMPORAL" en su propia
// cabecera). No forma parte del flujo de produccion. Se borra de este
// repo una vez que P3.1B decida el pipeline real de ingestion.
//
// Sprint P3.1A.2 (Finnhub Real News Discovery Benchmark). Objetivo:
// determinar con evidencia REAL (no documentacion) si Finnhub
// company-news puede ser DISCOVERY_SOURCE, y -- si lo es -- ejercitar
// el pipeline REAL de P3.1A (normalize -> source role -> temporal ->
// dedupe -> confidence -> persistencia) contra articulos reales, no
// fixtures.
//
// Uso: GET /api/finnhub-benchmark-temp?pin=TU_PIN&tickers=QCOM,AAPL,AMZN,NVDA,MSFT&ingest=true
//   ingest=true ejecuta el paso 7 del sprint (ingestion real +
//   idempotencia) SOLO sobre los tickers cuyo company-news salio
//   AVAILABLE. Omitilo (o pon ingest=false) para solo ver el benchmark
//   sin escribir nada en material_events/event_sources.
//
// Nunca devuelve ni loguea la API key en la respuesta ni en errores.
// service_role solo server-side, igual que el resto de api/*.js.

import { createClient } from "@supabase/supabase-js";
import { normalizeFinnhubNews } from "../lib/materialEventNormalize.js";
import {
  assignSourceRoles, reassignRolesWithNewSource, SOURCE_ROLE,
} from "../lib/materialEventSources.js";
import { resolveClusterAssignment } from "../lib/materialEventDedupe.js";
import {
  resolveEffectiveOccurredAt, resolveDecisionAvailableAt, classifyFreshness,
} from "../lib/materialEventTemporal.js";
import { computeConfidenceBreakdown } from "../lib/materialEventConfidence.js";
import {
  ENGINE_VERSION, NORMALIZATION_POLICY_VERSION, CONFIDENCE_POLICY_VERSION,
} from "../lib/materialEventVersioning.js";

const supabase = createClient(
  process.env.VITE_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const FINNHUB_TIER = 3; // agregador -- mismo tier que FMP en el diseño aprobado

function todayISODate(offsetDays = 0) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

// Clasifica una respuesta real de Finnhub en los 7 estados exigidos por
// el sprint -- nunca colapsa "0 resultados" y "fallo real" en el mismo
// estado (Test de "false silence").
async function classifyFinnhubResponse(url) {
  const startedAt = Date.now();
  let resp;
  try {
    resp = await fetch(url);
  } catch (networkErr) {
    return { classification: "PROVIDER_ERROR", httpStatus: null, note: `network_error: ${networkErr.message}`, latencyMs: Date.now() - startedAt, data: null };
  }
  const latencyMs = Date.now() - startedAt;

  if (resp.status === 401 || resp.status === 403) {
    return { classification: "AUTH_ERROR", httpStatus: resp.status, note: `http_${resp.status}`, latencyMs, data: null };
  }
  if (resp.status === 429) {
    return { classification: "RATE_LIMITED", httpStatus: 429, note: "rate_limited", latencyMs, data: null };
  }
  if (resp.status === 402) {
    return { classification: "PLAN_GATED", httpStatus: 402, note: "http_402", latencyMs, data: null };
  }
  if (!resp.ok) {
    return { classification: "PROVIDER_ERROR", httpStatus: resp.status, note: `http_${resp.status}`, latencyMs, data: null };
  }

  const rawText = await resp.text();
  let data;
  try {
    data = JSON.parse(rawText);
  } catch (e) {
    return { classification: "PROVIDER_ERROR", httpStatus: resp.status, note: "malformed_json_response", latencyMs, data: null };
  }

  if (data && typeof data === "object" && !Array.isArray(data) && data.error) {
    const msg = String(data.error);
    const lower = msg.toLowerCase();
    if (lower.includes("premium") || lower.includes("upgrade") || lower.includes("access") || lower.includes("plan")) {
      return { classification: "PLAN_GATED", httpStatus: resp.status, note: msg.slice(0, 150), latencyMs, data: null };
    }
    return { classification: "PROVIDER_ERROR", httpStatus: resp.status, note: msg.slice(0, 150), latencyMs, data: null };
  }
  if (Array.isArray(data) && data.length === 0) {
    return { classification: "EMPTY", httpStatus: resp.status, note: "no_event_found_from_finnhub_in_window -- NUNCA equivale a no_negative_event_exists", latencyMs, data: [] };
  }
  if (Array.isArray(data) && data.length > 0) {
    return { classification: "AVAILABLE", httpStatus: resp.status, note: null, latencyMs, data };
  }
  return { classification: "DATA_UNAVAILABLE", httpStatus: resp.status, note: "unexpected_response_shape", latencyMs, data: null };
}

async function testQuoteControl(FINNHUB_KEY, ticker) {
  const url = `https://finnhub.io/api/v1/quote?symbol=${ticker}&token=${FINNHUB_KEY}`;
  const r = await classifyFinnhubResponse(url);
  if (r.classification !== "AVAILABLE" && r.classification !== "EMPTY") return r;
  const q = r.data;
  const shapeOk = q && typeof q.c === "number" && typeof q.t === "number";
  return {
    classification: shapeOk ? "OK" : "DATA_UNAVAILABLE",
    httpStatus: r.httpStatus,
    latencyMs: r.latencyMs,
    current_price: q?.c ?? null,
    prev_close: q?.pc ?? null,
    quote_timestamp: q?.t ? new Date(q.t * 1000).toISOString() : null,
  };
}

async function testCompanyNews(FINNHUB_KEY, ticker, fromDate, toDate) {
  const url = `https://finnhub.io/api/v1/company-news?symbol=${ticker}&from=${fromDate}&to=${toDate}&token=${FINNHUB_KEY}`;
  const r = await classifyFinnhubResponse(url);
  if (r.classification !== "AVAILABLE") {
    return { classification: r.classification, httpStatus: r.httpStatus, latencyMs: r.latencyMs, note: r.note, count: 0, sample: [] };
  }
  const sample = r.data.slice(0, 5).map((a) => ({
    headline: a.headline,
    datetime_raw: a.datetime,
    published_at: typeof a.datetime === "number" ? new Date(a.datetime * 1000).toISOString() : null,
    source: a.source,
    url: a.url,
    has_summary: !!a.summary,
    related: a.related,
    category: a.category,
    finnhub_id: a.id,
  }));
  return { classification: "AVAILABLE", httpStatus: r.httpStatus, latencyMs: r.latencyMs, count: r.data.length, sample, raw: r.data };
}

// Fetch de material_events "is_current" del asset, en la forma que
// lib/materialEventDedupe.js espera como candidatos.
async function fetchClusterCandidates(assetId) {
  const { data, error } = await supabase
    .from("material_events")
    .select("cluster_id, asset_id, event_type, occurred_at, published_at, discovered_at, facts")
    .eq("asset_id", assetId)
    .eq("is_current", true);
  if (error) throw error;
  return (data || []).map((row) => ({
    cluster_id: row.cluster_id,
    asset_id: row.asset_id,
    event_type: row.event_type,
    effective_occurred_at: resolveEffectiveOccurredAt(row),
    facts: row.facts || {},
  }));
}

function newClusterId(ticker) {
  return `finnhub-${ticker}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// Ejecuta el pipeline REAL P3.1A completo sobre UN articulo normalizado.
// Devuelve el resultado + si fue idempotente (attach a cluster ya
// existente en esta misma corrida, ej. por reingestar a proposito).
async function ingestOneArticle(article, assetId, ticker, now) {
  const normalized = normalizeFinnhubNews(article, { asset_id: assetId, ticker });
  const effectiveOccurredAt = resolveEffectiveOccurredAt(normalized);
  const candidates = await fetchClusterCandidates(assetId);
  const assignment = resolveClusterAssignment(candidates, {
    asset_id: assetId, event_type: normalized.event_type,
    effective_occurred_at: effectiveOccurredAt, facts: normalized.facts,
  });

  const freshness = classifyFreshness(
    { discovered_at: now, occurred_at: normalized.occurred_at, published_at: normalized.published_at },
    now
  );
  const decisionAvailableAt = resolveDecisionAvailableAt({ processed_at: now });

  if (assignment.action === "ATTACH_TO_CLUSTER") {
    // Cluster ya existe -- solo agrega esta fuente, recalcula roles, y
    // promueve primary_source_id si corresponde (MUTABLE). Nunca toca
    // facts/timestamps del material_events existente.
    const { data: existingEvent, error: evErr } = await supabase
      .from("material_events")
      .select("id, primary_source_id")
      .eq("cluster_id", assignment.cluster_id)
      .eq("is_current", true)
      .single();
    if (evErr) throw evErr;

    const { data: existingSourcesRaw, error: srcErr } = await supabase
      .from("event_sources")
      .select("id, source_role, source_tier, ingested_at")
      .eq("cluster_id", assignment.cluster_id);
    if (srcErr) throw srcErr;
    const existingSourcesWithRoles = existingSourcesRaw.map((s) => ({ id: s.id, tier: s.source_tier, ingested_at: s.ingested_at, role: s.source_role }));

    const { data: insertedSource, error: insSrcErr } = await supabase
      .from("event_sources")
      .insert([{
        cluster_id: assignment.cluster_id,
        source_role: SOURCE_ROLE.CORROBORATING_SOURCE, // placeholder, se recalcula abajo
        source_tier: FINNHUB_TIER,
        provider: "finnhub",
        source_url: normalized.source_url,
        raw_headline: normalized.headline,
        raw_snippet: null,
        attributed_wire: normalized.attributed_wire,
        source_published_at: normalized.published_at,
      }])
      .select()
      .single();
    if (insSrcErr) throw insSrcErr;

    const { roles: recomputedRoles, promoted, newPrimaryId } = reassignRolesWithNewSource(
      existingSourcesWithRoles,
      { id: insertedSource.id, tier: FINNHUB_TIER, ingested_at: insertedSource.ingested_at }
    );
    // Bug real encontrado y corregido en este mismo sprint: los roles
    // recalculados (incluido el de la fuente recien insertada, que se
    // guardo con un placeholder) nunca se escribian de vuelta a
    // event_sources -- solo se actualizaba primary_source_id en
    // material_events. source_role es MUTABLE por diseño (ver migracion
    // P3.1A) precisamente para este caso: cada fuente cuyo role cambio
    // respecto a lo que tenia antes se actualiza aqui.
    for (const r of recomputedRoles) {
      const previous = existingSourcesWithRoles.find((s) => s.id === r.id);
      const previousRole = previous ? previous.role : SOURCE_ROLE.CORROBORATING_SOURCE; // la recien insertada
      if (r.role !== previousRole) {
        await supabase.from("event_sources").update({ source_role: r.role }).eq("id", r.id);
      }
    }
    if (promoted && newPrimaryId !== existingEvent.primary_source_id) {
      await supabase.from("material_events").update({ primary_source_id: newPrimaryId }).eq("id", existingEvent.id);
    }
    return {
      action: "ATTACH_TO_CLUSTER", cluster_id: assignment.cluster_id, event_id: existingEvent.id,
      source_id: insertedSource.id, promoted, new_primary_source_id: newPrimaryId,
    };
  }

  // NEW_CLUSTER: crea event_source + material_events juntos.
  const clusterId = newClusterId(ticker);
  const { data: insertedSource, error: insSrcErr } = await supabase
    .from("event_sources")
    .insert([{
      cluster_id: clusterId,
      source_role: SOURCE_ROLE.DISCOVERY_SOURCE,
      source_tier: FINNHUB_TIER,
      provider: "finnhub",
      source_url: normalized.source_url,
      raw_headline: normalized.headline,
      raw_snippet: null,
      attributed_wire: normalized.attributed_wire,
      source_published_at: normalized.published_at,
    }])
    .select()
    .single();
  if (insSrcErr) throw insSrcErr;

  const roles = assignSourceRoles([{ id: insertedSource.id, tier: FINNHUB_TIER, ingested_at: insertedSource.ingested_at }]);
  const primaryRole = roles[0]; // unica fuente -> DISCOVERY_SOURCE == PRIMARY_EVIDENCE_SOURCE por default de assignSourceRoles
  if (primaryRole.role !== insertedSource.source_role) {
    await supabase.from("event_sources").update({ source_role: primaryRole.role }).eq("id", insertedSource.id);
  }

  const confidence = computeConfidenceBreakdown({
    primaryEvidenceTier: FINNHUB_TIER,
    knownFactKeys: normalized.known_fact_count,
    expectedFactKeys: normalized.expected_fact_keys,
    freshnessStatus: freshness.status,
    sources: [{ provider: "finnhub", attributed_wire: normalized.attributed_wire }],
  });

  const { data: insertedEvent, error: insEvErr } = await supabase
    .from("material_events")
    .insert([{
      cluster_id: clusterId,
      asset_id: assetId,
      ticker,
      event_type: normalized.event_type,
      headline: normalized.headline,
      occurred_at: normalized.occurred_at,
      published_at: normalized.published_at,
      discovered_at: now,
      processed_at: now,
      decision_available_at: decisionAvailableAt,
      facts: normalized.facts,
      classification_method: normalized.classification_method,
      known_fact_count: normalized.known_fact_count,
      expected_fact_keys: normalized.expected_fact_keys,
      primary_source_id: insertedSource.id,
      source_confidence: confidence.source_confidence,
      data_completeness: confidence.data_completeness,
      freshness_confidence: confidence.freshness_confidence,
      corroboration_confidence: confidence.corroboration_confidence,
      overall_confidence: confidence.overall_confidence,
      confidence_policy_version: CONFIDENCE_POLICY_VERSION,
      engine_version: ENGINE_VERSION,
      normalization_policy_version: NORMALIZATION_POLICY_VERSION,
      requires_review: normalized.requires_review,
      status: "NEW",
    }])
    .select()
    .single();
  if (insEvErr) throw insEvErr;

  return {
    action: "NEW_CLUSTER", cluster_id: clusterId, event_id: insertedEvent.id, source_id: insertedSource.id,
    freshness: freshness.status, confidence: confidence.overall_confidence,
  };
}

export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  const { pin, tickers, ingest } = req.query || {};
  if (!pin || pin !== process.env.MONI_PIN) {
    return res.status(401).json({ error: "invalid_pin" });
  }

  const FINNHUB_KEY = process.env.FINNHUB_API_KEY;
  if (!FINNHUB_KEY) {
    return res.status(200).json({ blocked: true, reason: "FINNHUB_NOT_CONFIGURED" });
  }

  const tickerList = tickers ? tickers.split(",").map((t) => t.trim().toUpperCase()).filter(Boolean) : ["QCOM"];
  const shouldIngest = ingest === "true";
  const fromDate = todayISODate(-30);
  const toDate = todayISODate(0);
  const now = new Date().toISOString();

  try {
    // 1-2. Control test (quote) -- AAPL y QCOM siempre, sin importar `tickers`.
    const controlTest = {};
    for (const t of ["AAPL", "QCOM"]) {
      controlTest[t] = await testQuoteControl(FINNHUB_KEY, t);
    }

    // 3-4. company-news por ticker.
    const newsResults = {};
    for (const t of tickerList) {
      newsResults[t] = await testCompanyNews(FINNHUB_KEY, t, fromDate, toDate);
    }

    // 11. Provider failure behavior -- probado real, sin abusar del rate limit:
    // AUTH_ERROR con un token deliberadamente invalido (nunca el real).
    const failureProbe = {};
    failureProbe.auth_error_test = await classifyFinnhubResponse(
      `https://finnhub.io/api/v1/quote?symbol=AAPL&token=invalid_test_token_deliberately_wrong`
    );
    // malformed/DATA_UNAVAILABLE: symbol vacio -- provoca una forma de
    // respuesta distinta a la esperada sin gastar cuota real de datos.
    failureProbe.empty_symbol_test = await classifyFinnhubResponse(
      `https://finnhub.io/api/v1/quote?symbol=&token=${FINNHUB_KEY}`
    );
    failureProbe.rate_limited_test = { note: "no disparado deliberadamente -- requeriria volumen de requests abusivo, fuera de alcance. Estado RATE_LIMITED ya esta clasificado en classifyFinnhubResponse() vía HTTP 429, solo no ejercitado con datos reales en este benchmark." };

    // 7-8. Ingestion real + idempotencia, solo para tickers AVAILABLE.
    const ingestion = { attempted: shouldIngest, results: [] };
    if (shouldIngest) {
      // Resuelve asset_id real por ticker (nunca hardcodeado).
      const { data: assetRows, error: assetErr } = await supabase
        .from("assets").select("asset_id, ticker").in("ticker", tickerList);
      if (assetErr) throw assetErr;
      const assetByTicker = Object.fromEntries((assetRows || []).map((a) => [a.ticker, a.asset_id]));

      // Tope global de 3 articulos reales ingeridos EN TOTAL (pedido del
      // sprint), pudiendo venir de distintos tickers -- nunca 3 por
      // ticker. Se corta apenas se alcanza el total, sin importar de
      // que ticker vino cada uno.
      const MAX_REAL_INGESTIONS = 3;
      outerLoop:
      for (const t of tickerList) {
        const newsResult = newsResults[t];
        if (newsResult.classification !== "AVAILABLE" || !newsResult.raw?.length) continue;
        const assetId = assetByTicker[t];
        if (!assetId) {
          ingestion.results.push({ ticker: t, skipped: true, reason: "no_asset_id_found" });
          continue;
        }
        for (const article of newsResult.raw) {
          const ingestedSoFar = ingestion.results.filter((r) => !r.skipped).length;
          if (ingestedSoFar >= MAX_REAL_INGESTIONS) break outerLoop;
          const result = await ingestOneArticle(article, assetId, t, now);
          ingestion.results.push({ ticker: t, headline: article.headline, ...result });
        }
      }

      // Idempotencia real (paso 8): reingesta EXACTAMENTE el primer
      // articulo real ya insertado -- debe ATTACH_TO_CLUSTER, nunca
      // NEW_CLUSTER.
      const firstReal = ingestion.results.find((r) => r.action === "NEW_CLUSTER");
      if (firstReal) {
        const t = firstReal.ticker;
        const assetId = assetByTicker[t];
        const article = newsResults[t].raw.find((a) => a.headline === firstReal.headline);
        if (article && assetId) {
          const replay = await ingestOneArticle(article, assetId, t, new Date().toISOString());
          ingestion.idempotency_check = {
            original_cluster_id: firstReal.cluster_id,
            replay_action: replay.action,
            replay_cluster_id: replay.cluster_id,
            idempotent: replay.action === "ATTACH_TO_CLUSTER" && replay.cluster_id === firstReal.cluster_id,
          };
        }
      }
    }

    return res.status(200).json({
      ok: true,
      finnhub_configured: true,
      window: { from: fromDate, to: toDate },
      control_test: controlTest,
      news_results: Object.fromEntries(Object.entries(newsResults).map(([t, r]) => [t, { ...r, raw: undefined }])),
      failure_probe: failureProbe,
      ingestion,
    });
  } catch (err) {
    return res.status(500).json({ error: "finnhub_benchmark_failed", detail: String(err.message || err) });
  }
}
