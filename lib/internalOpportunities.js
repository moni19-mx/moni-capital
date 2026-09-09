// lib/internalOpportunities.js
// Sprint Internal Opportunities V1 (Moni Intelligence). Funciones PURAS
// -- cero red, cero Supabase, cero React. El llamador real
// (api/conviction-benchmark-temp.js, modo ?opportunities=true) resuelve
// las filas reales de conviction_history/thesis/market_cache y llama
// computePortfolioWeights()/computeConcentration() de
// lib/financialSnapshot.js (CERO reimplementacion de esas formulas) --
// este archivo solo decide, a partir de esos datos YA resueltos, que
// señales emitir.
//
// Principio central (aprobado explicitamente): cada señal separa
// FACT (dato real, con fact_refs) / INTERPRETATION (regla
// deterministica, versionada, method nombrado) / RECOMMENDATION (nunca
// una orden -- solo REVIEW_SIZING o REVIEW_CONVICTION, nunca BUY/SELL,
// nunca ejecutada automaticamente). Ningun signal ni el objeto por
// ticker exponen un campo "score" -- ver computeDataCoverage/
// buildTickerOpportunity, deliberadamente sin numero compuesto.

export const INTERNAL_OPPORTUNITIES_POLICY_VERSION = "internal-opportunities-v1.0.0";

// Bandas de Signal A -- nuevas, sin precedente exacto en el codebase
// (distinto del top1Pct de get_strategy_status, que es especifico de
// concentracion de UNA posicion top, no de "peso individual generico").
// Tuneables, no una calibracion empirica -- mismo principio ya usado en
// DETERMINISTIC_WEIGHTS/FINANCIAL_SCALE de materialityEngine.js.
export const CONVICTION_WEIGHT_THRESHOLDS = Object.freeze({
  CONVICTION_HIGH: 4.0, CONVICTION_LOW: 3.0, WEIGHT_LOW_PCT: 1.5, WEIGHT_HIGH_PCT: 8.0,
});

// Bandas de Signal B -- SINGLE_POSITION reusa el unico precedente real
// (get_strategy_status, lib/aiTools.js: top1Pct>35/>20). TOP5/TOP10 no
// tienen precedente -- nuevos, tuneables, declarados aqui.
export const CONCENTRATION_THRESHOLDS = Object.freeze({
  SINGLE_HIGH_PCT: 35, SINGLE_MEDIUM_PCT: 20, TOP5_HIGH_PCT: 60, TOP10_HIGH_PCT: 80,
});

// Umbral de la señal auxiliar MANUAL_VS_ENGINE_DIVERGENCE.
export const DIVERGENCE_THRESHOLD = 1.0;

function isNum(v) {
  return typeof v === "number" && !Number.isNaN(v);
}
function round(v, decimals) {
  const f = 10 ** decimals;
  return Math.round(v * f) / f;
}

// ================== CONVICTION SOURCE CONTRACT ==================
// Precedencia fija: accepted_conviction (revisado/aprobado por el
// usuario) > proposed_conviction cuando deterministic_status='SCORED'
// (el engine corrio, evidencia real, todavia sin revisar) >
// thesis.conviction manual (nunca pasado por el engine). Nunca se
// devuelve un valor sin declarar explicitamente de donde salio.
export function resolveConvictionValue({ acceptedConviction, proposedConviction, deterministicStatus, manualConviction }) {
  if (isNum(acceptedConviction)) {
    return { value: acceptedConviction, source: "engine_accepted" };
  }
  if (deterministicStatus === "SCORED" && isNum(proposedConviction)) {
    return { value: proposedConviction, source: "engine_proposed_pending_review" };
  }
  if (isNum(manualConviction)) {
    return { value: manualConviction, source: "manual_thesis_unreviewed" };
  }
  return { value: null, source: "manual_thesis_unreviewed" };
}

// ================== SIGNAL A: CONVICTION_WEIGHT_MISMATCH ==================
// Nunca se emite para combinaciones intermedias (conviction MEDIUM, o
// conviction/weight sin cruzar ninguna banda) -- devuelve null, el
// llamador simplemente no agrega nada a signals[].
export function computeConvictionWeightMismatch({ ticker, convictionValue, convictionSource, weightPct, evidenceRefs }) {
  if (!isNum(convictionValue) || !isNum(weightPct)) return null;

  let direction = null;
  if (convictionValue >= CONVICTION_WEIGHT_THRESHOLDS.CONVICTION_HIGH && weightPct < CONVICTION_WEIGHT_THRESHOLDS.WEIGHT_LOW_PCT) {
    direction = "HIGH_CONVICTION_LOW_WEIGHT";
  } else if (convictionValue <= CONVICTION_WEIGHT_THRESHOLDS.CONVICTION_LOW && weightPct > CONVICTION_WEIGHT_THRESHOLDS.WEIGHT_HIGH_PCT) {
    direction = "LOW_CONVICTION_HIGH_WEIGHT";
  }
  if (!direction) return null;

  const strength = direction === "HIGH_CONVICTION_LOW_WEIGHT"
    ? (weightPct < 0.5 ? "HIGH" : "MEDIUM")
    : (weightPct > 20 || convictionValue <= 2.0 ? "HIGH" : "MEDIUM");

  return {
    signal_type: "CONVICTION_WEIGHT_MISMATCH",
    direction,
    ticker,
    conviction_value: convictionValue,
    conviction_source: convictionSource,
    portfolio_weight_pct: round(weightPct, 3),
    strength,
    fact_refs: evidenceRefs || [],
    interpretation_method: "conviction_source_precedence_vs_portfolio_weight_bands",
    policy_version: INTERNAL_OPPORTUNITIES_POLICY_VERSION,
    confidence: null,
    review_required: true,
    recommendation: "REVIEW_SIZING",
    explanation: direction === "HIGH_CONVICTION_LOW_WEIGHT"
      ? `Conviction ${convictionValue} (${convictionSource}) es alta pero el peso en portafolio es ${weightPct.toFixed(2)}% -- posible sizing insuficiente frente a la convicción real.`
      : `Conviction ${convictionValue} (${convictionSource}) es baja o neutral pero el peso en portafolio es ${weightPct.toFixed(2)}% -- riesgo de concentración en una tesis sin convicción alta.`,
  };
}

// ================== SIGNAL AUXILIAR: MANUAL_VS_ENGINE_DIVERGENCE ==================
// Solo aplica cuando el engine REALMENTE corrio (source != manual) --
// nunca compara el manual contra si mismo. Nunca cambia thesis.conviction
// ni acepta el valor del engine automaticamente -- solo detecta y marca
// para revision humana.
export function computeManualVsEngineDivergence({
  ticker, manualConviction, engineValue, engineSource, engineDeterministicStatus, engineConfidence, engineCoverage, evidenceRefs,
}) {
  const engineActuallyRan = engineSource === "engine_accepted" || engineSource === "engine_proposed_pending_review";
  if (!engineActuallyRan || !isNum(manualConviction) || !isNum(engineValue)) return null;

  const delta = round(engineValue - manualConviction, 2);
  if (Math.abs(delta) < DIVERGENCE_THRESHOLD) return null;

  return {
    signal_type: "MANUAL_VS_ENGINE_DIVERGENCE",
    direction: delta < 0 ? "ENGINE_BELOW_MANUAL" : "ENGINE_ABOVE_MANUAL",
    ticker,
    manual_conviction: manualConviction,
    engine_conviction: engineValue,
    delta,
    engine_status: engineDeterministicStatus ?? null,
    engine_confidence: engineConfidence ?? null,
    coverage: engineCoverage ?? null,
    strength: Math.abs(delta) >= 2.0 ? "HIGH" : "MEDIUM",
    fact_refs: evidenceRefs || [],
    interpretation_method: "engine_conviction_minus_manual_conviction",
    policy_version: INTERNAL_OPPORTUNITIES_POLICY_VERSION,
    review_required: true,
    recommendation: "REVIEW_CONVICTION",
    explanation: `La convicción manual (${manualConviction}) y la del engine (${engineValue}, ${engineSource}) difieren en ${delta} puntos -- ninguna se aplica automáticamente, requiere revisión humana.`,
  };
}

// ================== SIGNAL B: CONCENTRATION_SIGNAL ==================
// concentration: el objeto REAL que devuelve
// lib/financialSnapshot.js::computeConcentration() -- cero
// reimplementacion, esta funcion solo interpreta esos numeros ya
// calculados. Devuelve señales agrupadas POR TICKER (SINGLE_POSITION
// solo al top1; TOP5/TOP10 a cada uno de los miembros del grupo -- son
// ellos quienes contribuyen al riesgo de concentracion agregado).
export function computeConcentrationSignals(concentration) {
  const result = { status: concentration?.status || "DATA_UNAVAILABLE", signals_by_ticker: {} };
  if (!concentration || concentration.status !== "COMPLETE") return result;

  const push = (ticker, signal) => {
    if (!result.signals_by_ticker[ticker]) result.signals_by_ticker[ticker] = [];
    result.signals_by_ticker[ticker].push(signal);
  };

  const top1 = (concentration.top5 || [])[0];
  if (top1) {
    let strength = null;
    if (concentration.top1_pct > CONCENTRATION_THRESHOLDS.SINGLE_HIGH_PCT) strength = "HIGH";
    else if (concentration.top1_pct > CONCENTRATION_THRESHOLDS.SINGLE_MEDIUM_PCT) strength = "MEDIUM";
    if (strength) {
      push(top1.ticker, {
        signal_type: "CONCENTRATION_SIGNAL", scope: "SINGLE_POSITION", ticker: top1.ticker, strength,
        actual_pct: round(concentration.top1_pct, 3),
        threshold_pct: strength === "HIGH" ? CONCENTRATION_THRESHOLDS.SINGLE_HIGH_PCT : CONCENTRATION_THRESHOLDS.SINGLE_MEDIUM_PCT,
        interpretation_method: "single_position_weight_vs_fixed_band",
        policy_version: INTERNAL_OPPORTUNITIES_POLICY_VERSION,
        review_required: true, recommendation: "REVIEW_SIZING",
        explanation: `${top1.ticker} representa ${concentration.top1_pct.toFixed(1)}% del portafolio tradicional (single-position).`,
      });
    }
  }

  if (concentration.top5_pct > CONCENTRATION_THRESHOLDS.TOP5_HIGH_PCT) {
    (concentration.top5 || []).forEach((p) => push(p.ticker, {
      signal_type: "CONCENTRATION_SIGNAL", scope: "TOP5", ticker: p.ticker, strength: "HIGH",
      actual_pct: round(concentration.top5_pct, 3), threshold_pct: CONCENTRATION_THRESHOLDS.TOP5_HIGH_PCT,
      interpretation_method: "top5_weight_sum_vs_fixed_band",
      policy_version: INTERNAL_OPPORTUNITIES_POLICY_VERSION,
      review_required: true, recommendation: "REVIEW_SIZING",
      explanation: `Las 5 posiciones más grandes concentran ${concentration.top5_pct.toFixed(1)}% del portafolio tradicional.`,
    }));
  }

  if (concentration.top10_pct > CONCENTRATION_THRESHOLDS.TOP10_HIGH_PCT) {
    (concentration.top10 || []).forEach((p) => push(p.ticker, {
      signal_type: "CONCENTRATION_SIGNAL", scope: "TOP10", ticker: p.ticker, strength: "HIGH",
      actual_pct: round(concentration.top10_pct, 3), threshold_pct: CONCENTRATION_THRESHOLDS.TOP10_HIGH_PCT,
      interpretation_method: "top10_weight_sum_vs_fixed_band",
      policy_version: INTERNAL_OPPORTUNITIES_POLICY_VERSION,
      review_required: true, recommendation: "REVIEW_SIZING",
      explanation: `Las 10 posiciones más grandes concentran ${concentration.top10_pct.toFixed(1)}% del portafolio tradicional.`,
    }));
  }

  return result;
}

// ================== SIGNAL E: VALUATION_SIGNAL ==================
// valuationComponent: EXACTAMENTE conviction_history.component_scores.VALUATION
// ya persistido (computeValuationFromPeg de lib/fundamentalConviction.js)
// -- nunca se recalcula una formula paralela aqui, solo se reexpone con
// su evidencia. Nunca traduce value alto/bajo a BUY/SELL.
export function computeValuationSignal({ ticker, valuationComponent, overallConfidence, coverage, evidenceRefs }) {
  const known = !!valuationComponent && valuationComponent.value !== "UNKNOWN" && isNum(valuationComponent.value);

  if (!known) {
    return {
      signal_type: "VALUATION_SIGNAL", ticker, status: "UNKNOWN",
      method: valuationComponent?.method || "no_valuation_component_available",
      fact_refs: evidenceRefs || [],
      policy_version: INTERNAL_OPPORTUNITIES_POLICY_VERSION,
      review_required: false, recommendation: null,
      explanation: "Sin cobertura SEC suficiente para calcular VALUATION -- nunca se usa P/E aislado como proxy de \"barato\"/\"caro\".",
    };
  }

  return {
    signal_type: "VALUATION_SIGNAL", ticker, status: "KNOWN",
    value: valuationComponent.value, method: valuationComponent.method,
    peg_proxy: valuationComponent.peg_proxy ?? null,
    current_pe: valuationComponent.current_pe ?? null,
    observed_growth_pct_used: valuationComponent.observed_growth_pct_used ?? null,
    confidence: overallConfidence ?? null, coverage: coverage ?? null,
    fact_refs: evidenceRefs || [],
    policy_version: INTERNAL_OPPORTUNITIES_POLICY_VERSION,
    review_required: false, recommendation: null,
    explanation: `VALUATION=${valuationComponent.value} (PEG-like${valuationComponent.peg_proxy != null ? ` ${valuationComponent.peg_proxy}` : ""}) -- interpretación de nivel, nunca una orden de compra/venta.`,
  };
}

// ================== OVERALL REVIEW PRIORITY (policy versionada, nunca un score) ==================
// HIGH: cualquier MANUAL_VS_ENGINE_DIVERGENCE presente, O cualquier
//   LOW_CONVICTION_HIGH_WEIGHT presente, O >=2 señales con
//   review_required=true.
// MEDIUM: exactamente 1 señal con review_required=true.
// LOW: ninguna.
export function deriveOverallReviewPriority(signals) {
  const list = signals || [];
  const hasDivergence = list.some((s) => s.signal_type === "MANUAL_VS_ENGINE_DIVERGENCE");
  const hasLowConvictionHighWeight = list.some((s) => s.signal_type === "CONVICTION_WEIGHT_MISMATCH" && s.direction === "LOW_CONVICTION_HIGH_WEIGHT");
  const reviewRequiredCount = list.filter((s) => s.review_required === true).length;

  if (hasDivergence || hasLowConvictionHighWeight || reviewRequiredCount >= 2) return "HIGH";
  if (reviewRequiredCount === 1) return "MEDIUM";
  return "LOW";
}

// ================== DATA COVERAGE (por ticker, 3 categorias de V1) ==================
export function computeDataCoverage({ convictionKnown, weightKnown, valuationKnown }) {
  const flags = [!!convictionKnown, !!weightKnown, !!valuationKnown];
  const known = flags.filter(Boolean).length;
  const unknowns = [];
  if (!convictionKnown) unknowns.push("CONVICTION");
  if (!weightKnown) unknowns.push("WEIGHT");
  if (!valuationKnown) unknowns.push("VALUATION");
  return { data_coverage: round((known / flags.length) * 100, 1), unknowns };
}

// ================== ENSAMBLE FINAL POR TICKER ==================
// Deliberadamente SIN ningun campo "score"/"opportunity_score" -- solo
// la lista de señales abiertas + una prioridad derivada por reglas
// explicitas (deriveOverallReviewPriority), nunca un numero compuesto.
export function buildTickerOpportunity({ ticker, signals, dataCoverage }) {
  const cleanSignals = (signals || []).filter(Boolean);
  return {
    ticker,
    signals: cleanSignals,
    overall_review_priority: deriveOverallReviewPriority(cleanSignals),
    data_coverage: dataCoverage.data_coverage,
    unknowns: dataCoverage.unknowns,
  };
}
