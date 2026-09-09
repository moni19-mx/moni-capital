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
import { extractDimensionsFromThesis } from "../lib/thesisDimensions.js";
import {
  computeOverallConviction, computeConvictionConfidence, applyComponentDeltas,
} from "../lib/convictionEngine.js";
import { classifyReviewRequirement } from "../lib/convictionReview.js";
import { requestThesisImpact, AI_NOT_ATTEMPTED } from "../lib/thesisImpactAi.js";
import { callModel } from "../lib/aiGateway.js";
import { tierScore } from "../lib/materialEventSources.js";
import {
  CONVICTION_ENGINE_VERSION, CONVICTION_SCORING_POLICY_VERSION, CONVICTION_CONFIDENCE_POLICY_VERSION,
  CONVICTION_WEIGHTS,
} from "../lib/thesisConvictionVersioning.js";

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

export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  const { pin, migrate_tickers, score_tickers, ai_test, max_events } = req.query || {};
  if (!pin || pin !== process.env.MONI_PIN) {
    return res.status(401).json({ error: "invalid_pin" });
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
      const allSourceTiers = [];
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
        if (effectRows.length === 0 && (aiResult.ai_status === "APPLIED" || aiResult.ai_status === "NEUTRAL")) {
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
        if (event.primary_source_id) {
          const { data: srcRow } = await supabase.from("event_sources").select("source_tier").eq("id", event.primary_source_id).single();
          if (srcRow?.source_tier != null) allSourceTiers.push(tierScore(srcRow.source_tier));
        }

        eventResults.push({
          event_id: event.id, headline: event.headline, event_type: event.event_type,
          materiality: event.latest_materiality, ai_status: aiResult.ai_status,
          affected_dimensions: aiResult.affected_dimensions, component_deltas: aiResult.component_deltas,
        });
      }

      const newComponents = applyComponentDeltas(previousComponents, allComponentDeltas);
      const overall = computeOverallConviction(newComponents);

      const riskChanged = allComponentDeltas.some((d) => d.component === "RISK");
      const thesisConfirmationChanged = allComponentDeltas.some((d) => d.component === "THESIS_CONFIRMATION");

      const oldestDimensionUpdate = dimensions.reduce((oldest, d) => {
        const days = (Date.now() - new Date(d.updated_at).getTime()) / 86400000;
        return oldest == null ? days : Math.max(oldest, days);
      }, null);
      const invalidatedCount = dimensions.filter((d) => d.status === "INVALIDATED").length;
      const confidence = computeConvictionConfidence({
        sourceTierScores: allSourceTiers, coverage: overall.coverage,
        oldestUpdatedAtDaysAgo: oldestDimensionUpdate, invalidatedDimensionsReferenced: invalidatedCount,
      });

      const review = classifyReviewRequirement({
        previousConviction, proposedConviction: overall.proposed_conviction, overallConfidence: confidence.overall_confidence,
        triggeringEventMateriality: maxTriggeringMateriality, riskComponentChanged: riskChanged,
        thesisConfirmationComponentChanged: thesisConfirmationChanged, anyDimensionNewlyInvalidated: anyInvalidated,
        isPeriodicReview: false,
      });

      let decisionId = null;
      if (events.length > 0 && review.requires_user_review && overall.status === "SCORED" && overall.proposed_conviction !== previousConviction) {
        const title = `Revisión de convicción: ${ticker} ${previousConviction ?? "?"} → ${overall.proposed_conviction}`;
        const { data: openDecisions } = await supabase.from("decisions").select("id, title").eq("status", "abierta").eq("type", "conviction_review").eq("ticker", ticker);
        const alreadyOpen = (openDecisions || []).find((d) => d.title === title);
        if (alreadyOpen) {
          decisionId = alreadyOpen.id;
        } else {
          const { data: decisionRow, error: decErr } = await supabase.from("decisions").insert([{
            type: "conviction_review", ticker, priority: review.reasons.some((r) => r.includes("materiality_high")) ? "alta" : "media",
            title, detail: `Razones: ${review.reasons.join(", ")}. Confidence: ${confidence.overall_confidence}%.`,
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
        source: "ENGINE_PROPOSAL",
        engine_version: CONVICTION_ENGINE_VERSION,
        scoring_policy_version: CONVICTION_SCORING_POLICY_VERSION,
        confidence_policy_version: CONVICTION_CONFIDENCE_POLICY_VERSION,
        model_provider: shouldAiTest ? "anthropic" : null,
        model_name: shouldAiTest ? "claude-sonnet-5" : null,
        status: "PENDING",
      }]).select().single();
      if (histErr) throw histErr;

      scoring.results.push({
        ticker, conviction_history_id: historyRow.id, dimensions_count: dimensions.length,
        events_processed: events.length, any_ai_failed: anyFailedAi,
        previous_conviction: previousConviction, proposed_conviction: overall.proposed_conviction,
        deterministic_status: overall.status, known_score: overall.known_score, coverage: overall.coverage,
        component_scores: newComponents, overall_confidence: confidence.overall_confidence, confidence_breakdown: confidence,
        requires_user_review: review.requires_user_review, review_reasons: review.reasons, decision_id: decisionId,
        event_results: eventResults,
      });
    }

    return res.status(200).json({ ok: true, migration, scoring });
  } catch (err) {
    return res.status(500).json({ error: "conviction_benchmark_failed", detail: String(err.message || err) });
  }
}
