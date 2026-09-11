// api/conviction-benchmark-temp.js
//
// DIAGNOSTICO TEMPORAL -- mismo patron que finnhub-benchmark-temp.js,
// fmp-benchmark-temp.js, sec-benchmark-temp.js. No forma parte del
// flujo de produccion. Se borra de este repo una vez que el workflow
// real de revision (seccion 19/20 del sprint) tenga UI dedicada.
//
// Sprint P3.2 (Thesis / Conviction Engine 2.0). Objetivo: ejercitar el
// pipeline real (migracion de thesis -> thesis_dimensions, interpretacion
// de material_events reales contra esas dimensiones via AI acotada,
// calculo deterministico de conviction con coverage, reglas de
// USER_REVIEW) contra datos reales de Supabase -- nunca fixtures.
//
// Uso:
//   GET /api/conviction-benchmark-temp?pin=X&migrate_tickers=QCOM,AMD
//     Migra thesis -> thesis_dimensions (idempotente -- no duplica si
//     ya existen dimensiones MIGRATED_FROM_THESIS_TEXT para el ticker).
//   GET /api/conviction-benchmark-temp?pin=X&score_tickers=QCOM,AMD&ai_test=true
//     Para cada ticker: busca material_events reales AUN NO procesados
//     por este engine (sin fila en thesis_dimension_effects), interpreta
//     cada uno contra las dimensiones reales (AI acotada si ai_test=true,
//     si no simplemente no propone nada), aplica los component_deltas
//     resultantes sobre el ultimo conviction_history conocido (o
//     arranca desde thesis.conviction real la primera vez), calcula
//     conviction_history nuevo, aplica las reglas de USER_REVIEW, y si
//     corresponde crea una fila en `decisions` (reutilizando el mismo
//     patron de review queue ya existente).
//
// Nunca escribe automaticamente en thesis.conviction ni en
// materiality_scores/material_events -- solo lee de ahi.

import { createClient } from "@supabase/supabase-js";
import { checkAdminAuth } from "../lib/adminAuth.js";
import { extractDimensionsFromThesis } from "../lib/thesisDimensions.js";
import {
  computeOverallConviction, computeConvictionConfidence, applyComponentDeltas,
} from "../lib/convictionEngine.js";
import { classifyReviewRequirement, shouldCreateReviewDecision } from "../lib/convictionReview.js";
import { requestThesisImpact, AI_NOT_ATTEMPTED, shouldInsertNeutralMarker } from "../lib/thesisImpactAi.js";
import { callModel } from "../lib/aiGateway.js";
import { tierScore } from "../lib/materialEventSources.js";
import {
  CONVICTION_ENGINE_VERSION, CONVICTION_SCORING_POLICY_VERSION, CONVICTION_CONFIDENCE_POLICY_VERSION,
  CONVICTION_WEIGHTS, FUNDAMENTAL_CONVICTION_POLICY_VERSION, LOW_COVERAGE_GUARD_POLICY_VERSION,
} from "../lib/thesisConvictionVersioning.js";
import {
  UNKNOWN as FUND_UNKNOWN, seriesForConcept, classifyFactFreshness,
  computeBusinessQuality, computeObservedGrowth, computeExecutionFromEarnings,
  computeFinancialStrength, computeValuationFromPeg, classifyEvidenceSufficiency,
} from "../lib/fundamentalConviction.js";
// Sprint Internal Opportunities V1. CERO reimplementacion de pesos --
// enrichPositions/computePortfolioWeights/computeConcentration son
// EXACTAMENTE las mismas funciones puras que usa src/App.jsx.
import { enrichPositions, computePortfolioWeights, computeConcentration } from "../lib/financialSnapshot.js";
import {
  resolveConvictionValue, computeConvictionWeightMismatch, computeManualVsEngineDivergence,
  computeConcentrationSignals, computeValuationSignal, computeDataCoverage, buildTickerOpportunity,
  INTERNAL_OPPORTUNITIES_POLICY_VERSION, CONVICTION_WEIGHT_THRESHOLDS, CONCENTRATION_THRESHOLDS, DIVERGENCE_THRESHOLD,
} from "../lib/internalOpportunities.js";

// SEC EDGAR (10-K/10-Q) y el snapshot de mercado en market_cache son
// evidencia real de mayor jerarquia posible (filing regulatorio /
// precio de mercado real, no interpretacion) -- mismo tier numerico
// que un Tier 1 real en material_event_sources (ver tierScore()).
const FUNDAMENTAL_SOURCE_TIER_SCORE = 100;

const supabase = createClient(
  process.env.VITE_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const COMPONENT_KEYS = Object.keys(CONVICTION_WEIGHTS);

async function migrateTicker(ticker) {
  const { data: assetRows, error: assetErr } = await supabase.from("assets").select("asset_id, ticker").eq("ticker", ticker);
  if (assetErr) throw assetErr;
  if (!assetRows?.length) return { ticker, skipped: true, reason: "no_asset_id_found" };
  const assetId = assetRows[0].asset_id;

  const { data: thesisRows, error: thErr } = await supabase.from("thesis").select("*").eq("ticker", ticker);
  if (thErr) throw thErr;
  if (!thesisRows?.length) return { ticker, skipped: true, reason: "no_thesis_row_found" };
  const thesisRow = { ...thesisRows[0], asset_id: assetId };

  const { data: existing, error: existErr } = await supabase
    .from("thesis_dimensions").select("dimension_type").eq("ticker", ticker).eq("source", "MIGRATED_FROM_THESIS_TEXT");
  if (existErr) throw existErr;
  const existingTypes = new Set((existing || []).map((d) => d.dimension_type));

  const { dimensions, skipped_reason } = extractDimensionsFromThesis(thesisRow);
  if (skipped_reason) return { ticker, skipped: true, reason: skipped_reason };

  const toInsert = dimensions.filter((d) => !existingTypes.has(d.dimension_type));
  if (toInsert.length === 0) {
    return { ticker, migrated: 0, already_migrated: dimensions.length, dimension_types: dimensions.map((d) => d.dimension_type) };
  }
  const { data: inserted, error: insErr } = await supabase.from("thesis_dimensions").insert(toInsert).select();
  if (insErr) throw insErr;
  return {
    ticker, migrated: inserted.length, already_migrated: existingTypes.size,
    dimension_types: inserted.map((d) => d.dimension_type), ids: inserted.map((d) => d.id),
  };
}

async function fetchDimensionsForTicker(ticker) {
  const { data, error } = await supabase.from("thesis_dimensions").select("*").eq("ticker", ticker);
  if (error) throw error;
  return data || [];
}

// Eventos reales del ticker que este engine AUN NO interpreto -- sin
// ninguna fila en thesis_dimension_effects. Nunca reprocesa un evento
// ya interpretado en una corrida anterior (evita "un evento reescribe
// la tesis" repetidamente).
async function fetchUnprocessedEvents(assetId, maxEvents) {
  const { data: events, error: evErr } = await supabase
    .from("material_events").select("*").eq("asset_id", assetId).eq("is_current", true).order("id");
  if (evErr) throw evErr;
  if (!events?.length) return [];

  const { data: processed, error: procErr } = await supabase
    .from("thesis_dimension_effects").select("material_event_id").in("material_event_id", events.map((e) => e.id));
  if (procErr) throw procErr;
  const processedIds = new Set((processed || []).map((p) => p.material_event_id));

  const unprocessed = events.filter((e) => !processedIds.has(e.id));
  const withScores = [];
  for (const e of unprocessed.slice(0, maxEvents)) {
    const { data: scores } = await supabase
      .from("materiality_scores").select("final_materiality_score, materiality_level, overall_confidence")
      .eq("material_event_id", e.id).order("scored_at", { ascending: false }).limit(1);
    withScores.push({ ...e, latest_materiality: scores?.[0] || null });
  }
  return withScores;
}

async function fetchLatestConvictionHistory(assetId) {
  const { data, error } = await supabase
    .from("conviction_history").select("*").eq("asset_id", assetId).order("created_at", { ascending: false }).limit(1);
  if (error) throw error;
  return data?.[0] || null;
}

// Micro-sprint P3.2.1 (Fundamental Conviction Coverage), items 1-9.
// Componentes DETERMINISTICOS a partir de facts reales ya existentes
// (sec_financials_normalized via api/sec-benchmark-temp.js, market_cache)
// -- ningun provider nuevo, ningun fallback fabricado. Devuelve
// {components, freshness} -- freshness clasifica cada componente
// conocido como CURRENT/STALE segun el period_end/fecha real que lo
// respalda (item 11/12), UNKNOWN si el componente mismo es UNKNOWN.
async function computeFundamentalComponents(ticker) {
  const nowIso = new Date().toISOString();

  const { data: secRows, error: secErr } = await supabase
    .from("sec_financials_normalized").select("canonical_concept, value, period_end, source").eq("ticker", ticker);
  if (secErr) throw secErr;

  const revenueSeries = seriesForConcept(secRows, "REVENUE");
  const operatingIncomeSeries = seriesForConcept(secRows, "OPERATING_INCOME");
  const fcfSeries = seriesForConcept(secRows, "FREE_CASH_FLOW");

  const businessQuality = computeBusinessQuality(revenueSeries, operatingIncomeSeries);
  const growth = computeObservedGrowth(revenueSeries);
  const financialStrength = computeFinancialStrength(revenueSeries, fcfSeries);

  const { data: cacheRow } = await supabase.from("market_cache").select("pe_ratio, updated_at").eq("ticker", ticker).maybeSingle();
  const peRatio = cacheRow?.pe_ratio != null ? Number(cacheRow.pe_ratio) : FUND_UNKNOWN;
  const growthFractionForPeg = growth.value !== FUND_UNKNOWN ? growth.observed_growth_pct / 100 : FUND_UNKNOWN;
  const valuation = computeValuationFromPeg(peRatio, growthFractionForPeg);

  const { data: earningsEvents, error: earnErr } = await supabase
    .from("material_events").select("facts, occurred_at")
    .eq("ticker", ticker).eq("event_type", "EARNINGS").eq("is_current", true)
    .order("occurred_at", { ascending: false });
  if (earnErr) throw earnErr;
  const surprises = (earningsEvents || [])
    .map((e) => {
      const actual = e.facts?.eps_actual;
      const estimated = e.facts?.eps_estimated;
      if (typeof actual !== "number" || typeof estimated !== "number" || estimated === 0) return null;
      return { surprisePct: (actual - estimated) / Math.abs(estimated), period_end: e.occurred_at };
    })
    .filter(Boolean);
  const execution = computeExecutionFromEarnings(surprises);

  const components = {
    BUSINESS_QUALITY: businessQuality, GROWTH_TAM: growth, EXECUTION: execution,
    FINANCIAL_STRENGTH: financialStrength, VALUATION: valuation,
  };

  const freshness = {
    BUSINESS_QUALITY: businessQuality.period_end ? classifyFactFreshness(businessQuality.period_end, nowIso) : FUND_UNKNOWN,
    GROWTH_TAM: growth.latest_period ? classifyFactFreshness(growth.latest_period, nowIso) : FUND_UNKNOWN,
    FINANCIAL_STRENGTH: financialStrength.period_end ? classifyFactFreshness(financialStrength.period_end, nowIso) : FUND_UNKNOWN,
    // market_cache es un snapshot casi en vivo (TTL de horas, ver
    // lib/marketCache.js) -- CURRENT mientras el componente sea conocido.
    VALUATION: valuation.value !== FUND_UNKNOWN ? "CURRENT" : FUND_UNKNOWN,
    EXECUTION: surprises[0]?.period_end ? classifyFactFreshness(surprises[0].period_end, nowIso) : FUND_UNKNOWN,
  };

  return { components, freshness, market_cache_updated_at: cacheRow?.updated_at || null };
}

// Micro-sprint P3.2.1, item 10 (EVIDENCE STATE ACUMULATIVO). Corrige el
// hallazgo real de P3.2: computar source_confidence solo con los tiers
// de los eventos procesados EN ESTA CORRIDA hacia que confidence
// bajara (59%->44%) cuando una corrida no traia eventos nuevos, aunque
// la evidencia previa siguiera vigente. Aqui se relee TODA la
// evidencia real y vigente que hoy respalda la tesis del asset --
// reproducible en cada corrida, nunca acumulado en memoria entre
// llamadas.
async function fetchAccumulatedSourceTiers(assetId) {
  const { data: effects, error } = await supabase
    .from("thesis_dimension_effects").select("material_event_id")
    .eq("asset_id", assetId).not("dimension_id", "is", null);
  if (error) throw error;
  const eventIds = [...new Set((effects || []).map((e) => e.material_event_id))];
  if (eventIds.length === 0) return [];

  const { data: events, error: evErr } = await supabase
    .from("material_events").select("id, primary_source_id").in("id", eventIds);
  if (evErr) throw evErr;
  const sourceIds = [...new Set((events || []).map((e) => e.primary_source_id).filter(Boolean))];
  if (sourceIds.length === 0) return [];

  const { data: sources, error: srcErr } = await supabase
    .from("event_sources").select("id, source_tier").in("id", sourceIds);
  if (srcErr) throw srcErr;
  return (sources || []).map((s) => tierScore(s.source_tier));
}

function buildImpactPrompt(event, dimensions) {
  return [
    "Eres el modulo de interpretacion de impacto de tesis de Moni Intelligence. Analiza si este evento REAL afecta alguna de las dimensiones REALES de la tesis de inversion listadas abajo.",
    "REGLAS ESTRICTAS:",
    "- NUNCA inventes facts -- usa solo lo que esta en el evento.",
    "- Un evento de ruido/generico (sin informacion especifica sobre la empresa) debe devolver affected_dimensions: [] y component_deltas: [] (NEUTRAL) -- no fuerces un efecto donde no hay evidencia real.",
    "- Un solo evento NUNCA invalida toda la tesis -- evalua cada dimension por separado.",
    "- component_deltas: SOLO si tienes una razon concreta y acotada (entre -1.0 y +1.0) ligada a este evento especifico.",
    "",
    `Ticker: ${event.ticker}`,
    `Tipo de evento: ${event.event_type}`,
    `Headline: ${event.headline}`,
    `Facts (JSON): ${JSON.stringify(event.facts)}`,
    `Materialidad de este evento: ${event.latest_materiality ? `${event.latest_materiality.final_materiality_score} (${event.latest_materiality.materiality_level})` : "no evaluada aun"}`,
    "",
    "Dimensiones reales de la tesis (id real -- usa exactamente estos ids):",
    ...dimensions.map((d) => `- id=${d.id} [${d.dimension_type}] (status actual: ${d.status}): ${d.detail}`),
    "",
    `Componentes de conviction validos para component_deltas: ${COMPONENT_KEYS.join(", ")}`,
    "",
    "Responde EXCLUSIVAMENTE un objeto JSON con esta forma exacta, sin texto fuera del JSON:",
    '{"affected_dimensions": [{"dimension_id": <id real>, "effect": "CONFIRMS|WEAKENS|INVALIDATES|NEUTRAL", "confidence": <0-100>, "explanation": "<obligatoria si effect != NEUTRAL>"}], "component_deltas": [{"component": "<uno de los validos>", "delta": <-1.0 a 1.0>, "reason": "<obligatoria si delta != 0>"}], "requires_review": <boolean>}',
    "Si el evento es ruido sin relacion clara a la tesis, responde exactamente: {\"affected_dimensions\": [], \"component_deltas\": [], \"requires_review\": false}",
  ].join("\n");
}

// Conviction Coverage Orchestrator MVP (Priority 2 del sprint de
// automatizacion): estado persistente de runs/run_items en
// conviction_runs/conviction_run_items -- para que la idempotencia del
// resume no dependa solo de que un array remaining_tickers este bien
// formado en memoria de un runner de GitHub Actions que puede morir a
// mitad de camino. Solo CRUD de estado, nunca duplica logica del engine
// de scoring ni del fetch SEC -- eso lo sigue haciendo scripts/
// orchestrate-conviction.js llamando a los modos existentes de este
// mismo archivo y de sec-benchmark-temp.js.
async function handleRunAction(req, res, action) {
  if (action === "create_run") {
    const { mode, tickers } = req.body || {};
    if (!mode || !Array.isArray(tickers) || tickers.length === 0) {
      return res.status(400).json({ error: "missing_params", detail: "requiere {mode, tickers:[]} en el body" });
    }
    const { data: run, error: runErr } = await supabase.from("conviction_runs").insert([{
      status: "RUNNING", mode, requested_tickers: tickers, started_at: new Date().toISOString(),
      created_by: "github_actions", engine_version: CONVICTION_ENGINE_VERSION,
    }]).select().single();
    if (runErr) throw runErr;

    const itemRows = tickers.map((ticker) => ({ run_id: run.id, ticker, status: "PENDING" }));
    const { data: items, error: itemsErr } = await supabase.from("conviction_run_items").insert(itemRows).select();
    if (itemsErr) throw itemsErr;

    return res.status(200).json({ ok: true, run_id: run.id, items: items.map((i) => ({ id: i.id, ticker: i.ticker, status: i.status })) });
  }

  if (action === "get_run") {
    const runId = req.query?.run_id;
    if (!runId) return res.status(400).json({ error: "missing_params", detail: "requiere ?run_id=" });
    const [{ data: run, error: runErr }, { data: items, error: itemsErr }] = await Promise.all([
      supabase.from("conviction_runs").select("*").eq("id", runId).single(),
      supabase.from("conviction_run_items").select("*").eq("run_id", runId).order("id"),
    ]);
    if (runErr) throw runErr;
    if (itemsErr) throw itemsErr;
    return res.status(200).json({ ok: true, run, items });
  }

  if (action === "update_item") {
    const { run_id, ticker, fields } = req.body || {};
    if (!run_id || !ticker || typeof fields !== "object") {
      return res.status(400).json({ error: "missing_params", detail: "requiere {run_id, ticker, fields:{}} en el body" });
    }
    // Whitelist estricta -- nunca deja que el body sobreescriba id/run_id/ticker.
    const ALLOWED_FIELDS = new Set([
      "status", "current_step", "sec_status", "score_status", "blocker_reason", "last_error",
      "attempt_count", "sec_completed_at", "scoring_completed_at", "conviction_history_id", "decision_id",
      "started_at", "completed_at",
    ]);
    const updatePayload = { updated_at: new Date().toISOString() };
    for (const key of Object.keys(fields)) {
      if (ALLOWED_FIELDS.has(key)) updatePayload[key] = fields[key];
    }
    const { data: updated, error: updErr } = await supabase
      .from("conviction_run_items").update(updatePayload).eq("run_id", run_id).eq("ticker", ticker).select().single();
    if (updErr) throw updErr;
    return res.status(200).json({ ok: true, item: updated });
  }

  if (action === "sec_status") {
    const { tickers } = req.body || {};
    if (!Array.isArray(tickers) || tickers.length === 0) {
      return res.status(400).json({ error: "missing_params", detail: "requiere {tickers:[]} en el body" });
    }
    const { data: rows, error: secErr } = await supabase
      .from("sec_financials_normalized").select("ticker, canonical_concept, period_end").in("ticker", tickers);
    if (secErr) throw secErr;
    const byTicker = {};
    tickers.forEach((t) => { byTicker[t] = { concepts: new Set(), revenue_periods: 0 }; });
    (rows || []).forEach((r) => {
      if (!byTicker[r.ticker]) return;
      byTicker[r.ticker].concepts.add(r.canonical_concept);
      if (r.canonical_concept === "REVENUE" && r.period_end) byTicker[r.ticker].revenue_periods += 1;
    });
    const results = tickers.map((ticker) => {
      const info = byTicker[ticker];
      const concepts_present = info.concepts.size;
      // Mismo umbral usado en todas las verificaciones manuales de este
      // sprint: 6/6 conceptos y >=2 periodos de REVENUE (minimo real para
      // GROWTH_TAM, que compara los 2 mas recientes -- ver
      // computeObservedGrowth en lib/fundamentalConviction.js).
      const ready_to_score = concepts_present >= 6 && info.revenue_periods >= 2;
      return { ticker, sec_rows_found: info.concepts.size > 0, concepts_present, revenue_periods: info.revenue_periods, ready_to_score };
    });
    return res.status(200).json({ ok: true, results });
  }

  if (action === "verify_history") {
    const idsParam = req.query?.ids;
    if (!idsParam) return res.status(400).json({ error: "missing_params", detail: "requiere ?ids=1,2,3" });
    const ids = idsParam.split(",").map((s) => s.trim()).filter(Boolean);
    const { data: rows, error } = await supabase
      .from("conviction_history")
      .select("id, ticker, accepted_conviction, source, status, deterministic_status, proposed_conviction, previous_conviction")
      .in("id", ids);
    if (error) throw error;
    return res.status(200).json({ ok: true, rows });
  }

  if (action === "complete_run") {
    const { run_id, status, error_summary } = req.body || {};
    if (!run_id || !status) return res.status(400).json({ error: "missing_params", detail: "requiere {run_id, status} en el body" });
    const { data: run, error: runErr } = await supabase.from("conviction_runs")
      .update({ status, completed_at: new Date().toISOString(), error_summary: error_summary || null })
      .eq("id", run_id).select().single();
    if (runErr) throw runErr;
    return res.status(200).json({ ok: true, run });
  }

  return res.status(400).json({ error: "unknown_run_action", detail: `run_action="${action}" no reconocido` });
}

// Sprint Internal Opportunities V1: modo READ-ONLY, sin escritura
// alguna (ni decisions, ni conviction_history, ni ninguna tabla) --
// solo lee positions/thesis/market_cache/conviction_history reales y
// aplica las funciones puras de lib/internalOpportunities.js. Universo:
// las mismas 39 posiciones reales (TRADITIONAL_TYPES vía
// computePortfolioWeights, exactamente igual que el dashboard real).
async function runInternalOpportunitiesV1(req, res) {
  const [{ data: positions, error: posErr }, { data: thesisRows, error: thErr }] = await Promise.all([
    supabase.from("positions").select("*"),
    supabase.from("thesis").select("asset_id, ticker, conviction"),
  ]);
  if (posErr) throw posErr;
  if (thErr) throw thErr;

  const tickers = [...new Set((positions || []).filter((p) => p.type !== "cash").map((p) => p.ticker))];
  const { data: cacheRows, error: cacheErr } = await supabase
    .from("market_cache").select("ticker, ai_price").in("ticker", tickers);
  if (cacheErr) throw cacheErr;

  // marketData: MISMA forma que consume enrichPositions() en produccion
  // ({ticker: {price}}) -- se lee de market_cache tal cual esta hoy,
  // CERO llamada en vivo a Finnhub/CoinGecko (nunca toca Price Truth).
  const marketData = {};
  (cacheRows || []).forEach((r) => { if (r.ai_price != null) marketData[r.ticker] = { price: Number(r.ai_price) }; });

  const thesisByTicker = {};
  (thesisRows || []).forEach((t) => { thesisByTicker[t.ticker] = t; });

  const enriched = enrichPositions(positions, marketData, thesisByTicker);
  const weightsResult = computePortfolioWeights(enriched);
  const concentration = computeConcentration(weightsResult);
  const concentrationSignals = computeConcentrationSignals(concentration);

  const weightByTicker = {};
  (weightsResult.weights || []).forEach((w) => { weightByTicker[w.ticker] = w.portfolio_weight_pct; });

  const opportunities = [];
  for (const ticker of tickers) {
    const position = (positions || []).find((p) => p.ticker === ticker);
    if (!position) continue;
    const thesisRow = thesisByTicker[ticker] || null;
    const latestHistory = await fetchLatestConvictionHistory(position.asset_id);

    const resolved = resolveConvictionValue({
      acceptedConviction: latestHistory?.accepted_conviction != null ? Number(latestHistory.accepted_conviction) : null,
      proposedConviction: latestHistory?.proposed_conviction != null ? Number(latestHistory.proposed_conviction) : null,
      deterministicStatus: latestHistory?.deterministic_status ?? null,
      manualConviction: thesisRow?.conviction != null ? Number(thesisRow.conviction) : null,
    });
    const convictionEvidenceRefs = latestHistory
      ? [{ conviction_history_id: latestHistory.id, ticker }]
      : [{ thesis_asset_id: position.asset_id, ticker }];

    const weightPct = weightByTicker[ticker] ?? null;

    const signalA = computeConvictionWeightMismatch({
      ticker, convictionValue: resolved.value, convictionSource: resolved.source,
      weightPct, evidenceRefs: convictionEvidenceRefs,
    });

    const signalDivergence = computeManualVsEngineDivergence({
      ticker,
      manualConviction: thesisRow?.conviction != null ? Number(thesisRow.conviction) : null,
      engineValue: resolved.value, engineSource: resolved.source,
      engineDeterministicStatus: latestHistory?.deterministic_status ?? null,
      engineConfidence: latestHistory?.overall_confidence ?? null,
      engineCoverage: latestHistory?.coverage != null ? Number(latestHistory.coverage) : null,
      evidenceRefs: convictionEvidenceRefs,
    });

    const valuationComponent = latestHistory?.component_scores?.VALUATION ?? null;
    const signalValuation = computeValuationSignal({
      ticker, valuationComponent,
      overallConfidence: latestHistory?.overall_confidence ?? null,
      coverage: latestHistory?.coverage != null ? Number(latestHistory.coverage) : null,
      evidenceRefs: latestHistory ? [{ conviction_history_id: latestHistory.id, ticker }] : [],
    });

    const concSignalsForTicker = concentrationSignals.signals_by_ticker[ticker] || [];

    const dataCoverage = computeDataCoverage({
      convictionKnown: resolved.value != null,
      weightKnown: weightPct != null,
      valuationKnown: signalValuation.status === "KNOWN",
    });

    opportunities.push(buildTickerOpportunity({
      ticker,
      signals: [signalA, signalDivergence, ...concSignalsForTicker, signalValuation],
      dataCoverage,
    }));
  }

  const counts = {
    total_tickers: opportunities.length,
    with_conviction_weight_mismatch: opportunities.filter((o) => o.signals.some((s) => s.signal_type === "CONVICTION_WEIGHT_MISMATCH")).length,
    with_concentration_signal: opportunities.filter((o) => o.signals.some((s) => s.signal_type === "CONCENTRATION_SIGNAL")).length,
    with_manual_vs_engine_divergence: opportunities.filter((o) => o.signals.some((s) => s.signal_type === "MANUAL_VS_ENGINE_DIVERGENCE")).length,
    valuation_known: opportunities.filter((o) => o.signals.some((s) => s.signal_type === "VALUATION_SIGNAL" && s.status === "KNOWN")).length,
    valuation_unknown: opportunities.filter((o) => o.signals.some((s) => s.signal_type === "VALUATION_SIGNAL" && s.status === "UNKNOWN")).length,
    priority_distribution: {
      HIGH: opportunities.filter((o) => o.overall_review_priority === "HIGH").length,
      MEDIUM: opportunities.filter((o) => o.overall_review_priority === "MEDIUM").length,
      LOW: opportunities.filter((o) => o.overall_review_priority === "LOW").length,
    },
    tickers_with_any_unknown: opportunities.filter((o) => o.unknowns.length > 0).length,
  };

  return res.status(200).json({
    ok: true,
    mode: "INTERNAL_OPPORTUNITIES_V1",
    policy_version: INTERNAL_OPPORTUNITIES_POLICY_VERSION,
    thresholds: { CONVICTION_WEIGHT_THRESHOLDS, CONCENTRATION_THRESHOLDS, DIVERGENCE_THRESHOLD },
    concentration_status: concentrationSignals.status,
    portfolio_weight_status: weightsResult.status,
    counts,
    opportunities,
  });
}

export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  const auth = checkAdminAuth(
    { headers: req.headers, query: req.query },
    { MONI_ADMIN_SECRET: process.env.MONI_ADMIN_SECRET, MONI_PIN: process.env.MONI_PIN }
  );
  if (!auth.authorized) {
    return res.status(401).json({ error: "unauthorized" });
  }
  const { migrate_tickers, score_tickers, ai_test, max_events, opportunities, run_action } = req.query || {};

  if (run_action) {
    try {
      return await handleRunAction(req, res, run_action);
    } catch (err) {
      return res.status(500).json({ error: "run_action_failed", detail: String(err.message || err) });
    }
  }

  if (opportunities === "true") {
    try {
      return await runInternalOpportunitiesV1(req, res);
    } catch (err) {
      return res.status(500).json({ error: "internal_opportunities_failed", detail: String(err.message || err) });
    }
  }

  const migrateTickerList = migrate_tickers ? migrate_tickers.split(",").map((t) => t.trim().toUpperCase()).filter(Boolean) : [];
  const scoreTickerList = score_tickers ? score_tickers.split(",").map((t) => t.trim().toUpperCase()).filter(Boolean) : [];
  const shouldAiTest = ai_test === "true";
  const maxEvents = Math.max(1, Math.min(parseInt(max_events, 10) || 5, 10));

  try {
    const migration = { attempted: migrateTickerList.length > 0, results: [] };
    for (const t of migrateTickerList) {
      migration.results.push(await migrateTicker(t));
    }

    const scoring = { attempted: scoreTickerList.length > 0, ai_test_attempted: shouldAiTest, results: [] };
    for (const ticker of scoreTickerList) {
      const { data: assetRows, error: assetErr } = await supabase.from("assets").select("asset_id, ticker").eq("ticker", ticker);
      if (assetErr) throw assetErr;
      if (!assetRows?.length) { scoring.results.push({ ticker, skipped: true, reason: "no_asset_id_found" }); continue; }
      const assetId = assetRows[0].asset_id;

      const dimensions = await fetchDimensionsForTicker(ticker);
      if (dimensions.length === 0) {
        scoring.results.push({ ticker, skipped: true, reason: "no_thesis_dimensions_found_run_migrate_first" });
        continue;
      }

      const events = await fetchUnprocessedEvents(assetId, maxEvents);
      const latestHistory = await fetchLatestConvictionHistory(assetId);

      const { data: thesisRows } = await supabase.from("thesis").select("conviction").eq("ticker", ticker);
      const realThesisConviction = thesisRows?.[0]?.conviction ?? null;
      const previousConviction = latestHistory?.accepted_conviction ?? latestHistory?.proposed_conviction ?? realThesisConviction;
      const previousComponents = latestHistory?.component_scores || {};

      const eventResults = [];
      const allComponentDeltas = [];
      const allEvidenceRefs = [];
      let maxTriggeringMateriality = null;
      let anyInvalidated = false;
      let anyFailedAi = false;

      for (const event of events) {
        let aiResult = { ...AI_NOT_ATTEMPTED };
        if (shouldAiTest) {
          const callModelFn = async (promptContext) => {
            const result = await callModel({
              system: "Respondes UNICAMENTE con un objeto JSON valido, sin texto adicional, sin backticks de markdown.",
              messages: [{ role: "user", content: promptContext }],
              authContext: { authenticated: true },
              maxTokens: 500,
            });
            return result.content || null;
          };
          const promptText = buildImpactPrompt(event, dimensions);
          aiResult = await requestThesisImpact(callModelFn, promptText, {
            validDimensionIds: dimensions.map((d) => d.id), validComponentKeys: COMPONENT_KEYS,
          });
        }
        if (aiResult.ai_status === "FAILED") anyFailedAi = true;

        const effectRows = [];
        for (const eff of aiResult.affected_dimensions) {
          effectRows.push({
            material_event_id: event.id, dimension_id: eff.dimension_id, asset_id: assetId,
            effect: eff.effect, confidence: eff.confidence, evidence_refs: [{ material_event_id: event.id, headline: event.headline }],
            explanation: eff.explanation || null, requires_review: eff.effect === "INVALIDATES",
            engine_version: CONVICTION_ENGINE_VERSION,
          });
          if (eff.effect === "INVALIDATES") anyInvalidated = true;
        }
        // Bugfix real (encontrado en la corrida en vivo): un evento que
        // el AI evaluo con exito y encontro NEUTRAL (cero dimensiones
        // afectadas -- el resultado correcto para ruido) nunca dejaba
        // rastro aqui, asi que fetchUnprocessedEvents() lo reprocesaba
        // (y re-facturaba al AI) en cada corrida siguiente. Se inserta
        // SIEMPRE al menos una fila marcadora cuando el AI genuinamente
        // corrio (APPLIED o NEUTRAL) -- dimension_id=null significa
        // "evaluado contra toda la tesis, sin efecto en ninguna
        // dimension", distinto de "nunca evaluado" (FAILED/NOT_ATTEMPTED
        // nunca insertan marcador -- se reintentan en la proxima corrida).
        if (shouldInsertNeutralMarker({ effectRowsCount: effectRows.length, aiStatus: aiResult.ai_status })) {
          effectRows.push({
            material_event_id: event.id, dimension_id: null, asset_id: assetId,
            effect: "NEUTRAL", confidence: null, evidence_refs: [{ material_event_id: event.id, headline: event.headline }],
            explanation: "El AI evaluo el evento completo contra la tesis real y no encontro efecto en ninguna dimension.",
            requires_review: false, engine_version: CONVICTION_ENGINE_VERSION,
          });
        }
        if (effectRows.length > 0) {
          const { error: effErr } = await supabase.from("thesis_dimension_effects").insert(effectRows);
          if (effErr) throw effErr;
        }

        allComponentDeltas.push(...aiResult.component_deltas);
        if (event.latest_materiality?.final_materiality_score != null) {
          allEvidenceRefs.push({ material_event_id: event.id, final_materiality_score: event.latest_materiality.final_materiality_score });
          maxTriggeringMateriality = Math.max(maxTriggeringMateriality ?? 0, event.latest_materiality.final_materiality_score);
        }
        eventResults.push({
          event_id: event.id, headline: event.headline, event_type: event.event_type,
          materiality: event.latest_materiality, ai_status: aiResult.ai_status,
          affected_dimensions: aiResult.affected_dimensions, component_deltas: aiResult.component_deltas,
        });
      }

      const aiComponents = applyComponentDeltas(previousComponents, allComponentDeltas);

      // Micro-sprint P3.2.1 (items 1-9): "MAS EVIDENCIA, NO MAS OPINION".
      // Los 5 componentes fundamentales se recalculan SIEMPRE desde facts
      // reales vigentes (sec_financials_normalized + market_cache +
      // material_events reales) y, cuando son conocidos, SOBRESCRIBEN
      // cualquier valor previo (venga de un delta de AI anclado en el
      // neutral o de una corrida anterior) -- evidencia real determinista
      // pesa mas que una interpretacion de AI sin facts propios para ese
      // mismo componente. Si el fundamental sigue UNKNOWN (dato real no
      // disponible todavia, p.ej. AMD sin SEC data), el valor previo (AI o
      // UNKNOWN) se conserva tal cual -- nunca se borra evidencia real por
      // falta de una fuente nueva.
      const fundamentals = await computeFundamentalComponents(ticker);
      const newComponents = { ...aiComponents };
      const fundamentalsApplied = [];
      for (const key of Object.keys(fundamentals.components)) {
        const fc = fundamentals.components[key];
        if (fc.value !== FUND_UNKNOWN) {
          newComponents[key] = {
            ...fc, freshness: fundamentals.freshness[key], evidence_layer: "DETERMINISTIC_FUNDAMENTAL",
            policy_version: FUNDAMENTAL_CONVICTION_POLICY_VERSION,
          };
          fundamentalsApplied.push(key);
        }
      }

      const overall = computeOverallConviction(newComponents);

      const riskChanged = allComponentDeltas.some((d) => d.component === "RISK");
      const thesisConfirmationChanged = allComponentDeltas.some((d) => d.component === "THESIS_CONFIRMATION");

      const oldestDimensionUpdate = dimensions.reduce((oldest, d) => {
        const days = (Date.now() - new Date(d.updated_at).getTime()) / 86400000;
        return oldest == null ? days : Math.max(oldest, days);
      }, null);
      const invalidatedCount = dimensions.filter((d) => d.status === "INVALIDATED").length;

      // Item 10 (EVIDENCE STATE ACUMULATIVO): confidence se calcula sobre
      // TODA la evidencia real vigente (eventos ya interpretados en
      // cualquier corrida anterior + esta, mas los componentes
      // fundamentales conocidos), nunca solo sobre lo procesado en esta
      // llamada HTTP -- una corrida sin eventos nuevos ya no debe hacer
      // caer la confidence si la evidencia previa sigue vigente.
      const accumulatedEventTiers = await fetchAccumulatedSourceTiers(assetId);
      const fundamentalTiers = fundamentalsApplied.map(() => FUNDAMENTAL_SOURCE_TIER_SCORE);
      const confidence = computeConvictionConfidence({
        sourceTierScores: [...accumulatedEventTiers, ...fundamentalTiers], coverage: overall.coverage,
        oldestUpdatedAtDaysAgo: oldestDimensionUpdate, invalidatedDimensionsReferenced: invalidatedCount,
      });

      const review = classifyReviewRequirement({
        previousConviction, proposedConviction: overall.proposed_conviction, overallConfidence: confidence.overall_confidence,
        triggeringEventMateriality: maxTriggeringMateriality, riskComponentChanged: riskChanged,
        thesisConfirmationComponentChanged: thesisConfirmationChanged, anyDimensionNewlyInvalidated: anyInvalidated,
        isPeriodicReview: false,
      });

      // Item 14/21 (LOW COVERAGE GUARD): un delta numerico crudo con
      // coverage/componentes insuficientes NUNCA se presenta como
      // "Recommend X->Y" -- se marca explicitamente como evidencia
      // insuficiente para siquiera proponer el cambio, y NUNCA crea una
      // decision de revision (evita ensuciar la cola con recomendaciones
      // que en realidad dicen "no se suficiente", no "la tesis es debil").
      const evidenceSufficiency = classifyEvidenceSufficiency({
        coverage: overall.coverage, componentsKnown: overall.components_known,
      });
      const hasNominalDelta = overall.status === "SCORED" && overall.proposed_conviction !== previousConviction;
      let recommendationStatus;
      if (overall.status === "DATA_UNAVAILABLE") recommendationStatus = "DATA_UNAVAILABLE";
      else if (!hasNominalDelta) recommendationStatus = "NO_CHANGE";
      else if (!evidenceSufficiency.sufficient) recommendationStatus = "INSUFFICIENT_EVIDENCE_FOR_CHANGE";
      else recommendationStatus = "PROPOSED_CHANGE";

      // Bugfix real (encontrado en la corrida en vivo de P3.2.1): esta
      // condicion originalmente exigia events.length>0 -- asumia que
      // solo un evento nuevo podia disparar una revision. Con
      // fundamentales deterministicos (items 1-9), una corrida sin
      // eventos nuevos puede producir un delta real y justificado
      // (p.ej. QCOM 3->4 solo por evidencia fundamental, coverage 52%,
      // confidence 83%) que requires_user_review=true y
      // recommendation_status=PROPOSED_CHANGE ya marcan como legitimo --
      // exigir eventos nuevos ademas de eso enmascaraba silenciosamente
      // una recomendacion real (decision_id quedaba null pese a
      // ameritar revision). El trigger correcto es "hay evidencia nueva
      // de cualquier tipo" (evento interpretado O fundamental aplicado),
      // no "hubo un evento".
      const hasNewEvidenceThisRun = events.length > 0 || fundamentalsApplied.length > 0;
      let decisionId = null;
      if (shouldCreateReviewDecision({ hasNewEvidenceThisRun, requiresUserReview: review.requires_user_review, recommendationStatus })) {
        const title = `Revisión de convicción: ${ticker} ${previousConviction ?? "?"} → ${overall.proposed_conviction}`;
        const { data: openDecisions } = await supabase.from("decisions").select("id, title").eq("status", "abierta").eq("type", "conviction_review").eq("ticker", ticker);
        const alreadyOpen = (openDecisions || []).find((d) => d.title === title);
        if (alreadyOpen) {
          decisionId = alreadyOpen.id;
        } else {
          const { data: decisionRow, error: decErr } = await supabase.from("decisions").insert([{
            type: "conviction_review", ticker, priority: review.reasons.some((r) => r.includes("materiality_high")) ? "alta" : "media",
            title, detail: `Razones: ${review.reasons.join(", ")}. Confidence: ${confidence.overall_confidence}%. Coverage: ${Math.round(overall.coverage * 100)}% (${overall.components_known}/${overall.components_total} componentes).`,
            status: "abierta", created_at: new Date().toISOString(),
          }]).select().single();
          if (decErr) throw decErr;
          decisionId = decisionRow.id;
        }
      }

      const { data: historyRow, error: histErr } = await supabase.from("conviction_history").insert([{
        asset_id: assetId, ticker,
        previous_conviction: previousConviction,
        proposed_conviction: overall.status === "SCORED" ? overall.proposed_conviction : null,
        accepted_conviction: null,
        deterministic_status: overall.status,
        component_scores: newComponents,
        component_confidences: {},
        known_score: overall.known_score,
        coverage: overall.coverage,
        overall_confidence: confidence.overall_confidence,
        confidence_breakdown: confidence,
        reason: events.length > 0 ? `Procesados ${events.length} eventos reales (${eventResults.map((e) => e.ai_status).join(",")})` : "sin eventos nuevos que procesar",
        evidence_refs: allEvidenceRefs,
        triggered_by_event_id: events[0]?.id ?? null,
        requires_user_review: review.requires_user_review,
        review_reasons: review.reasons,
        decision_id: decisionId,
        recommendation_status: recommendationStatus,
        source: "ENGINE_PROPOSAL",
        engine_version: CONVICTION_ENGINE_VERSION,
        scoring_policy_version: CONVICTION_SCORING_POLICY_VERSION,
        confidence_policy_version: CONVICTION_CONFIDENCE_POLICY_VERSION,
        model_provider: shouldAiTest ? "anthropic" : null,
        model_name: shouldAiTest ? "claude-sonnet-5" : null,
        status: "PENDING",
      }]).select().single();
      if (histErr) throw histErr;

      const knownKeys = Object.keys(newComponents).filter((k) => newComponents[k]?.value !== FUND_UNKNOWN && newComponents[k]?.value !== undefined);
      const unknownKeys = Object.keys(CONVICTION_WEIGHTS).filter((k) => !knownKeys.includes(k));
      const staleKeys = knownKeys.filter((k) => newComponents[k]?.freshness === "STALE");

      scoring.results.push({
        ticker, conviction_history_id: historyRow.id, dimensions_count: dimensions.length,
        events_processed: events.length, any_ai_failed: anyFailedAi,
        previous_conviction: previousConviction, proposed_conviction: overall.proposed_conviction,
        deterministic_status: overall.status, known_score: overall.known_score, coverage: overall.coverage,
        component_scores: newComponents, overall_confidence: confidence.overall_confidence, confidence_breakdown: confidence,
        requires_user_review: review.requires_user_review, review_reasons: review.reasons, decision_id: decisionId,
        recommendation_status: recommendationStatus, evidence_sufficiency: evidenceSufficiency,
        low_coverage_guard_policy_version: LOW_COVERAGE_GUARD_POLICY_VERSION,
        fundamentals_applied_this_run: fundamentalsApplied,
        coverage_report: {
          known_components: knownKeys, known_count: knownKeys.length,
          unknown_components: unknownKeys, stale_components: staleKeys,
          weighted_coverage_pct: Math.round(overall.coverage * 1000) / 10,
          confidence_pct: confidence.overall_confidence,
        },
        event_results: eventResults,
      });
    }

    return res.status(200).json({ ok: true, migration, scoring });
  } catch (err) {
    return res.status(500).json({ error: "conviction_benchmark_failed", detail: String(err.message || err) });
  }
}
