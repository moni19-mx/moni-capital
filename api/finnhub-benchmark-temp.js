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
import { normalizeFinnhubNews, normalizeFinnhubEarnings } from "../lib/materialEventNormalize.js";
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
  MATERIALITY_ENGINE_VERSION, SCORING_POLICY_VERSION,
} from "../lib/materialEventVersioning.js";
// Sprint P3.1B.1 (Materiality Real-World Validation)
import {
  computeFinancialScale, computeStrategicRelevance, computeTimelineUrgency,
  computeSourceStrength, computeDeterministicScore, classifyPortfolioRelevance,
} from "../lib/materialityEngine.js";
import { computeFinalMateriality, deriveMaterialityLevel } from "../lib/materialityFormula.js";
import { requestAiAdjustment, AI_NOT_ATTEMPTED } from "../lib/materialityAiAdjustment.js";
import { callModel } from "../lib/aiGateway.js";

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

// Sprint P3.1B.1. /stock/earnings -- nunca antes probado contra la API
// real (FMP /earnings ya se confirmo PLAN_BLOCKED en P3.1A.1 para este
// portfolio). Objetivo: al menos 2 eventos reales EARNINGS donde
// FINANCIAL_SCALE sea calculable (Regla 6 del sprint) con eps_actual/
// eps_estimated reales, no UNKNOWN.
async function testEarnings(FINNHUB_KEY, ticker) {
  const url = `https://finnhub.io/api/v1/stock/earnings?symbol=${ticker}&token=${FINNHUB_KEY}`;
  const r = await classifyFinnhubResponse(url);
  if (r.classification !== "AVAILABLE") {
    return { classification: r.classification, httpStatus: r.httpStatus, latencyMs: r.latencyMs, note: r.note, count: 0, sample: [] };
  }
  // Solo registros con actual Y estimate reales son utiles para
  // FINANCIAL_SCALE (computeFinancialScale exige ambos, ver
  // lib/materialityEngine.js) -- se conservan todos en `raw` para
  // transparencia del benchmark, pero se marca cuales son usables.
  const usable = r.data.filter((rec) => typeof rec.actual === "number" && typeof rec.estimate === "number");
  const sample = r.data.slice(0, 6).map((rec) => ({
    period: rec.period, year: rec.year, quarter: rec.quarter,
    actual: rec.actual ?? null, estimate: rec.estimate ?? null,
    surprise: rec.surprise ?? null, surprisePercent: rec.surprisePercent ?? null,
    financial_scale_computable: typeof rec.actual === "number" && typeof rec.estimate === "number",
  }));
  return {
    classification: "AVAILABLE", httpStatus: r.httpStatus, latencyMs: r.latencyMs,
    count: r.data.length, usable_count: usable.length, sample, raw: r.data,
  };
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

// Ejecuta el pipeline REAL P3.1A completo sobre UN evento YA
// normalizado (noticia o earnings, Sprint P3.1B.1 generaliza esta
// funcion para reusar exactamente la misma logica de dedupe/roles/
// confidence/persistencia sin importar el normalizador de origen -- el
// unico cambio real es que el provider/tier viajan como parametro en
// vez de estar hardcodeados a "finnhub"/FINNHUB_TIER). Devuelve el
// resultado + si fue idempotente (attach a cluster ya existente en esta
// misma corrida, ej. por reingestar a proposito).
async function ingestNormalizedEvent(normalized, assetId, ticker, now, sourceTier, provider) {
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
        source_tier: sourceTier,
        provider,
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
      { id: insertedSource.id, tier: sourceTier, ingested_at: insertedSource.ingested_at }
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
      source_tier: sourceTier,
      provider,
      source_url: normalized.source_url,
      raw_headline: normalized.headline,
      raw_snippet: null,
      attributed_wire: normalized.attributed_wire,
      source_published_at: normalized.published_at,
    }])
    .select()
    .single();
  if (insSrcErr) throw insSrcErr;

  const roles = assignSourceRoles([{ id: insertedSource.id, tier: sourceTier, ingested_at: insertedSource.ingested_at }]);
  const primaryRole = roles[0]; // unica fuente -> DISCOVERY_SOURCE == PRIMARY_EVIDENCE_SOURCE por default de assignSourceRoles
  if (primaryRole.role !== insertedSource.source_role) {
    await supabase.from("event_sources").update({ source_role: primaryRole.role }).eq("id", insertedSource.id);
  }

  const confidence = computeConfidenceBreakdown({
    primaryEvidenceTier: sourceTier,
    knownFactKeys: normalized.known_fact_count,
    expectedFactKeys: normalized.expected_fact_keys,
    freshnessStatus: freshness.status,
    sources: [{ provider, attributed_wire: normalized.attributed_wire }],
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

// Wrapper P3.1A.2 preservado tal cual (mismo comportamiento exacto que
// antes de la generalizacion) -- solo delega a ingestNormalizedEvent.
async function ingestOneArticle(article, assetId, ticker, now) {
  const normalized = normalizeFinnhubNews(article, { asset_id: assetId, ticker });
  return ingestNormalizedEvent(normalized, assetId, ticker, now, FINNHUB_TIER, "finnhub");
}

// Sprint P3.1B.1. Mismo pipeline real, para un registro de
// /stock/earnings ya normalizado por normalizeFinnhubEarnings.
async function ingestEarningsRecord(record, assetId, ticker, now) {
  const normalized = normalizeFinnhubEarnings(record, { asset_id: assetId, ticker });
  return ingestNormalizedEvent(normalized, assetId, ticker, now, FINNHUB_TIER, "finnhub");
}

// ================== Sprint P3.1B.1: scoring real ==================
// Datos REALES de positions/thesis (nunca hardcodeados) -- misma forma
// que computeStrategicRelevance()/classifyPortfolioRelevance() esperan.
async function fetchPositionContext(ticker) {
  const { data: posRows, error: posErr } = await supabase
    .from("positions")
    .select("ticker, tema, sector, strategic_role")
    .eq("ticker", ticker);
  if (posErr) throw posErr;
  const isActivePosition = (posRows || []).length > 0;
  const pos = (posRows && posRows[0]) || {};

  let conviction = null;
  if (isActivePosition) {
    const { data: thesisRows, error: thErr } = await supabase
      .from("thesis")
      .select("ticker, conviction")
      .eq("ticker", ticker);
    if (thErr) throw thErr;
    conviction = (thesisRows && thesisRows[0] && typeof thesisRows[0].conviction === "number") ? thesisRows[0].conviction : null;
  }

  return {
    isActivePosition,
    tema: pos.tema || null,
    sector: pos.sector || null,
    strategic_role: pos.strategic_role || null,
    conviction,
  };
}

// Corre los 4 componentes deterministicos + el score final SIN AI --
// puramente el pipeline de lib/materialityEngine.js/materialityFormula.js
// contra un material_events row REAL. Nunca decide el nivel de
// materialidad por su cuenta -- deriveMaterialityLevel() es la unica
// fuente de esa regla, ya versionada.
function computeDeterministicForEvent(eventRow, positionContext, primaryEvidenceTier) {
  const financial = computeFinancialScale(eventRow.event_type, eventRow.facts, {});
  const strategic = computeStrategicRelevance(eventRow.facts, positionContext);
  const timeline = computeTimelineUrgency(eventRow.facts, new Date().toISOString());
  const source = computeSourceStrength(primaryEvidenceTier);
  const det = computeDeterministicScore({
    FINANCIAL_SCALE: financial, STRATEGIC_RELEVANCE: strategic,
    TIMELINE_URGENCY: timeline, SOURCE_STRENGTH: source,
  });
  const portfolioRelevance = classifyPortfolioRelevance({
    isActivePosition: positionContext.isActivePosition, conviction: positionContext.conviction,
  });
  return { financial, strategic, timeline, source, det, portfolioRelevance };
}

// Prompt real para el ajuste de AI (Regla 10) -- acotado explicitamente
// a -15..+15, con reason obligatorio si != 0. El AI NUNCA ve una
// instruccion de "calcular" un numero financiero -- solo interpreta lo
// que el score deterministico ya resolvio y puede matizarlo, acotado.
function buildAiAdjustmentPrompt(eventRow, deterministicResult) {
  const { financial, strategic, timeline, source, det } = deterministicResult;
  return [
    "Eres el modulo de ajuste de materialidad de Moni Intelligence. NUNCA calculas un score desde cero -- solo puedes proponer un AJUSTE ACOTADO entre -15 y +15 sobre un score deterministico que ya existe.",
    "",
    `Ticker: ${eventRow.ticker}`,
    `Tipo de evento: ${eventRow.event_type}`,
    `Headline: ${eventRow.headline}`,
    `Facts (JSON, nunca los modifiques): ${JSON.stringify(eventRow.facts)}`,
    "",
    "Componentes deterministicos ya calculados:",
    `- FINANCIAL_SCALE: ${JSON.stringify(financial)}`,
    `- STRATEGIC_RELEVANCE: ${JSON.stringify(strategic)}`,
    `- TIMELINE_URGENCY: ${JSON.stringify(timeline)}`,
    `- SOURCE_STRENGTH: ${JSON.stringify(source)}`,
    `- Score deterministico final: ${det.status === "SCORED" ? det.score : "DATA_UNAVAILABLE"}`,
    "",
    "Responde EXCLUSIVAMENTE un objeto JSON con esta forma exacta, sin texto fuera del JSON:",
    '{"adjustment": <numero entero entre -15 y 15>, "reason": "<obligatorio si adjustment != 0, explica en 1-2 frases que matiz cualitativo justifica el ajuste>", "interpretation": "<1-2 frases explicando tu lectura del evento>", "confidence": <0-100>}',
    "Si el score deterministico ya te parece razonable, usa adjustment: 0.",
  ].join("\n");
}

async function persistScore(eventRow, deterministicResult, aiResult, evidenceRefs) {
  const { financial, strategic, timeline, source, det, portfolioRelevance } = deterministicResult;
  const finalScore = det.status === "SCORED"
    ? computeFinalMateriality(det.score, aiResult.adjustment)
    : null;
  const { data, error } = await supabase
    .from("materiality_scores")
    .insert([{
      material_event_id: eventRow.id,
      deterministic_status: det.status,
      deterministic_score: det.status === "SCORED" ? det.score : null,
      deterministic_components: {
        FINANCIAL_SCALE: financial, STRATEGIC_RELEVANCE: strategic,
        TIMELINE_URGENCY: timeline, SOURCE_STRENGTH: source,
        weights_used: det.weights_used, components_known: det.components_known, components_total: det.components_total,
      },
      ai_status: aiResult.ai_status,
      ai_adjustment: aiResult.adjustment,
      ai_adjustment_reason: aiResult.reason,
      ai_interpretation: aiResult.interpretation,
      final_materiality_score: finalScore,
      materiality_level: finalScore != null ? deriveMaterialityLevel(finalScore) : null,
      source_confidence: eventRow.source_confidence,
      data_completeness: eventRow.data_completeness,
      freshness_confidence: eventRow.freshness_confidence,
      corroboration_confidence: eventRow.corroboration_confidence,
      overall_confidence: eventRow.overall_confidence,
      confidence_policy_version: eventRow.confidence_policy_version,
      portfolio_relevance_level: portfolioRelevance.level,
      portfolio_relevance_reason: portfolioRelevance.reason,
      evidence_refs: evidenceRefs,
      engine_version: MATERIALITY_ENGINE_VERSION,
      scoring_policy_version: SCORING_POLICY_VERSION,
      model_provider: aiResult.model_provider || null,
      model_name: aiResult.model_name || null,
    }])
    .select()
    .single();
  if (error) throw error;
  return data;
}

export const config = { maxDuration: 60 };

// Sprint P3.1B.1. Trae el material_events row COMPLETO + el tier real
// de su primary_source_id + evidence_refs (todas las fuentes reales del
// cluster) -- todo lo que scoreEvent()/persistScore() necesitan, leido
// fresco desde la base (nunca desde memoria de la corrida de ingestion,
// que para ATTACH_TO_CLUSTER no trae el row completo).
async function fetchEventForScoring(eventId) {
  const { data: eventRow, error: evErr } = await supabase
    .from("material_events").select("*").eq("id", eventId).single();
  if (evErr) throw evErr;

  let primaryTier = null;
  if (eventRow.primary_source_id) {
    const { data: srcRow, error: srcErr } = await supabase
      .from("event_sources").select("source_tier").eq("id", eventRow.primary_source_id).single();
    if (srcErr) throw srcErr;
    primaryTier = srcRow?.source_tier ?? null;
  }

  const { data: sourceRows, error: srcListErr } = await supabase
    .from("event_sources")
    .select("id, provider, source_url, source_role, source_tier")
    .eq("cluster_id", eventRow.cluster_id);
  if (srcListErr) throw srcListErr;
  const evidenceRefs = (sourceRows || []).map((s) => ({
    source_id: s.id, provider: s.provider, source_url: s.source_url, source_role: s.source_role, source_tier: s.source_tier,
  }));

  return { eventRow, primaryTier, evidenceRefs };
}

export default async function handler(req, res) {
  const {
    pin, tickers, ingest, earnings_tickers, score, ai_test, max_ingest, max_earnings_ingest,
  } = req.query || {};
  if (!pin || pin !== process.env.MONI_PIN) {
    return res.status(401).json({ error: "invalid_pin" });
  }

  const FINNHUB_KEY = process.env.FINNHUB_API_KEY;
  if (!FINNHUB_KEY) {
    return res.status(200).json({ blocked: true, reason: "FINNHUB_NOT_CONFIGURED" });
  }

  const tickerList = tickers ? tickers.split(",").map((t) => t.trim().toUpperCase()).filter(Boolean) : ["QCOM"];
  // Sprint P3.1B.1: diversidad real de tickers/event_types (Regla 2) --
  // opcional, vacio por default (backward-compatible con P3.1A.2: sin
  // este param el comportamiento es identico al benchmark original).
  const earningsTickerList = earnings_tickers
    ? earnings_tickers.split(",").map((t) => t.trim().toUpperCase()).filter(Boolean)
    : [];
  const shouldIngest = ingest === "true";
  const shouldScore = score === "true";
  const shouldAiTest = ai_test === "true";
  // Default 3, igual que P3.1A.2 -- overridable para el sprint de
  // validacion (Regla 2 pide una muestra de 8-12 eventos reales), nunca
  // mas de 8/6 en una sola corrida (protege cuota real del proveedor).
  const MAX_REAL_INGESTIONS = Math.max(1, Math.min(parseInt(max_ingest, 10) || 3, 8));
  const MAX_EARNINGS_INGESTIONS = Math.max(1, Math.min(parseInt(max_earnings_ingest, 10) || 3, 6));
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

    // Sprint P3.1B.1 (Regla 6 -- FINANCIAL_SCALE real): /stock/earnings
    // por ticker, solo si earnings_tickers fue pasado explicitamente.
    const earningsResults = {};
    for (const t of earningsTickerList) {
      earningsResults[t] = await testEarnings(FINNHUB_KEY, t);
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
    const earningsIngestion = { attempted: shouldIngest && earningsTickerList.length > 0, results: [] };
    // Resuelve asset_id real por ticker (nunca hardcodeado) -- union de
    // ambas listas para que earnings_tickers no requiera repetir el
    // ticker en `tickers` tambien.
    const allTickersForAssets = [...new Set([...tickerList, ...earningsTickerList])];
    let assetByTicker = {};
    if (shouldIngest || shouldScore) {
      const { data: assetRows, error: assetErr } = await supabase
        .from("assets").select("asset_id, ticker").in("ticker", allTickersForAssets);
      if (assetErr) throw assetErr;
      assetByTicker = Object.fromEntries((assetRows || []).map((a) => [a.ticker, a.asset_id]));
    }
    if (shouldIngest) {
      // Tope global de articulos reales ingeridos EN TOTAL (pedido del
      // sprint), pudiendo venir de distintos tickers -- nunca por
      // ticker. Se corta apenas se alcanza el total, sin importar de
      // que ticker vino cada uno.
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

      // Sprint P3.1B.1 (Regla 6): ingestion real de earnings, solo
      // registros con actual Y estimate reales (financial_scale_computable).
      // Mismo tope global, independiente del de noticias.
      outerEarningsLoop:
      for (const t of earningsTickerList) {
        const er = earningsResults[t];
        if (er.classification !== "AVAILABLE" || !er.raw?.length) continue;
        const assetId = assetByTicker[t];
        if (!assetId) {
          earningsIngestion.results.push({ ticker: t, skipped: true, reason: "no_asset_id_found" });
          continue;
        }
        const usableRecords = er.raw.filter((rec) => typeof rec.actual === "number" && typeof rec.estimate === "number");
        for (const rec of usableRecords) {
          const ingestedSoFar = earningsIngestion.results.filter((r) => !r.skipped).length;
          if (ingestedSoFar >= MAX_EARNINGS_INGESTIONS) break outerEarningsLoop;
          const result = await ingestEarningsRecord(rec, assetId, t, now);
          earningsIngestion.results.push({ ticker: t, period: rec.period, actual: rec.actual, estimate: rec.estimate, ...result });
        }
      }
    }

    // Sprint P3.1B.1 (Reglas 4, 6, 7, 8, 9, 10): scoring real de
    // materialidad SIN CAMBIAR pesos/umbrales (Regla 1) sobre todo
    // evento tocado en ESTA corrida -- tanto NEW_CLUSTER como
    // ATTACH_TO_CLUSTER, porque un ATTACH tambien amerita un re-score
    // real (el cluster gano una fuente/tier nuevos). Nunca reescribe
    // materiality_scores existentes -- cada llamada es una fila nueva
    // (tabla append-only).
    const scoring = { attempted: shouldScore, ai_test_attempted: shouldAiTest, results: [] };
    if (shouldScore) {
      const touchedEventIds = [...new Set([
        ...ingestion.results.filter((r) => r.event_id).map((r) => r.event_id),
        ...earningsIngestion.results.filter((r) => r.event_id).map((r) => r.event_id),
      ])];

      const positionContextCache = {};
      const scoredForAi = [];
      for (const eventId of touchedEventIds) {
        const { eventRow, primaryTier, evidenceRefs } = await fetchEventForScoring(eventId);
        if (!positionContextCache[eventRow.ticker]) {
          positionContextCache[eventRow.ticker] = await fetchPositionContext(eventRow.ticker);
        }
        const deterministicResult = computeDeterministicForEvent(eventRow, positionContextCache[eventRow.ticker], primaryTier);
        scoredForAi.push({ eventId, eventRow, deterministicResult, evidenceRefs });
      }

      // Regla 10: hasta 3 candidatos reales para AI live -- uno LOW, uno
      // MEDIUM, uno HIGH SI EXISTE (nunca fabricado si no hay un HIGH
      // real en esta muestra).
      const aiCandidateIds = new Set();
      if (shouldAiTest) {
        for (const level of ["LOW", "MEDIUM", "HIGH"]) {
          const match = scoredForAi.find((s) =>
            s.deterministicResult.det.status === "SCORED" &&
            deriveMaterialityLevel(s.deterministicResult.det.score) === level &&
            !aiCandidateIds.has(s.eventId)
          );
          if (match) aiCandidateIds.add(match.eventId);
        }
      }

      for (const item of scoredForAi) {
        const runAi = shouldAiTest && aiCandidateIds.has(item.eventId);
        let aiResult = { ...AI_NOT_ATTEMPTED };
        let modelProvider = null;
        let modelName = null;
        if (runAi) {
          const capture = {};
          const callModelFn = async (promptContext) => {
            const result = await callModel({
              system: "Respondes UNICAMENTE con un objeto JSON valido, sin texto adicional, sin backticks de markdown.",
              messages: [{ role: "user", content: promptContext }],
              authContext: { authenticated: true },
              maxTokens: 400,
            });
            capture.provider = result.usage?.provider || null;
            capture.model = result.usage?.model || null;
            return result.content || null;
          };
          const promptText = buildAiAdjustmentPrompt(item.eventRow, item.deterministicResult);
          aiResult = await requestAiAdjustment(callModelFn, promptText);
          modelProvider = capture.provider;
          modelName = capture.model;
        }
        const persisted = await persistScore(
          item.eventRow, item.deterministicResult,
          { ...aiResult, model_provider: modelProvider, model_name: modelName },
          item.evidenceRefs
        );
        scoring.results.push({
          materiality_score_id: persisted.id,
          event_id: item.eventId,
          ticker: item.eventRow.ticker,
          event_type: item.eventRow.event_type,
          headline: item.eventRow.headline,
          facts: item.eventRow.facts,
          ai_test_attempted_for_this_event: runAi,
          deterministic_status: item.deterministicResult.det.status,
          deterministic_score: item.deterministicResult.det.status === "SCORED" ? item.deterministicResult.det.score : null,
          deterministic_components: {
            FINANCIAL_SCALE: item.deterministicResult.financial,
            STRATEGIC_RELEVANCE: item.deterministicResult.strategic,
            TIMELINE_URGENCY: item.deterministicResult.timeline,
            SOURCE_STRENGTH: item.deterministicResult.source,
          },
          portfolio_relevance: item.deterministicResult.portfolioRelevance,
          ai_status: aiResult.ai_status,
          ai_adjustment: aiResult.adjustment,
          ai_adjustment_reason: aiResult.reason,
          ai_interpretation: aiResult.interpretation,
          ai_model_provider: modelProvider,
          ai_model_name: modelName,
          final_materiality_score: persisted.final_materiality_score,
          materiality_level: persisted.materiality_level,
          overall_confidence: persisted.overall_confidence,
        });
      }
    }

    return res.status(200).json({
      ok: true,
      finnhub_configured: true,
      window: { from: fromDate, to: toDate },
      control_test: controlTest,
      news_results: Object.fromEntries(Object.entries(newsResults).map(([t, r]) => [t, { ...r, raw: undefined }])),
      earnings_results: Object.fromEntries(Object.entries(earningsResults).map(([t, r]) => [t, { ...r, raw: undefined }])),
      failure_probe: failureProbe,
      ingestion,
      earnings_ingestion: earningsIngestion,
      scoring,
    });
  } catch (err) {
    return res.status(500).json({ error: "finnhub_benchmark_failed", detail: String(err.message || err) });
  }
}
