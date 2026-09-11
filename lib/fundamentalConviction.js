// lib/fundamentalConviction.js
// Micro-sprint P3.2.1 (Fundamental Conviction Coverage). Componentes
// DETERMINISTICOS a partir de facts reales (SEC XBRL normalizado +
// market_cache) -- CERO LLM, CERO red, CERO Supabase (el llamador
// resuelve las filas reales y se las pasa aqui). "Mas evidencia, no
// mas opinion": cada funcion devuelve UNKNOWN honesto si falta el
// insumo real, nunca inventa un fallback.
//
// Datos reales disponibles hoy en sec_financials_normalized (V2,
// api/sec-benchmark-temp.js, ya existente -- reusado, no reconstruido):
// REVENUE, NET_INCOME, OPERATING_INCOME, OPERATING_CASH_FLOW,
// FREE_CASH_FLOW, CAPEX. NINGUN concepto de balance (cash/debt) existe
// todavia -- FINANCIAL_STRENGTH se basa solo en generacion de caja
// (OCF/FCF), nunca en leverage/liquidity inventados.

export const UNKNOWN = "UNKNOWN";

function isNum(v) {
  return typeof v === "number" && !Number.isNaN(v);
}
function clampToConvictionScale(v) {
  const stepped = Math.round(v / 0.5) * 0.5;
  return Math.max(1.0, Math.min(5.0, Math.round(stepped * 100) / 100));
}

// ================== Fact layer: latest-per-concept (freshness/supersession) ==================
// rows: array real de sec_financials_normalized para UN ticker (todas
// las filas, todos los conceptos, todos los periodos). Para cada
// canonical_concept, la fila CURRENT es la de mayor period_end -- las
// demas son historia real, preservada, nunca borrada, simplemente no
// "vigente" para el calculo del componente actual. Determinista: nunca
// requiere un campo de status mutable, se deriva en cada lectura.
export function selectLatestPerConcept(rows) {
  const byConcept = {};
  for (const r of rows || []) {
    const existing = byConcept[r.canonical_concept];
    if (!existing || new Date(r.period_end) > new Date(existing.period_end)) {
      byConcept[r.canonical_concept] = r;
    }
  }
  return byConcept;
}

// Serie completa (todos los periodos reales) de un concepto, ordenada
// mas reciente primero -- para calculos de TREND que necesitan >=2 puntos.
export function seriesForConcept(rows, concept) {
  return (rows || [])
    .filter((r) => r.canonical_concept === concept)
    .sort((a, b) => new Date(b.period_end) - new Date(a.period_end));
}

export function classifyFactFreshness(periodEnd, now) {
  if (!periodEnd) return UNKNOWN;
  const daysAgo = (new Date(now).getTime() - new Date(periodEnd).getTime()) / 86400000;
  if (daysAgo <= 550) return "CURRENT"; // ~18 meses, cubre el rezago normal 10-K
  if (daysAgo <= 730) return "STALE";
  return "STALE";
}

// ================== BUSINESS_QUALITY ==================
// Margen operativo real (OPERATING_INCOME/REVENUE) + tendencia YoY
// real -- nunca inventa "calidad" desde adjetivos. Requiere >=1 periodo
// para el nivel, >=2 para la tendencia (la tendencia es un ajuste, no
// un requisito).
export function computeBusinessQuality(revenueSeries, operatingIncomeSeries) {
  if (!revenueSeries?.length || !operatingIncomeSeries?.length) {
    return { value: UNKNOWN, method: "no_revenue_or_operating_income_data" };
  }
  const latestRev = revenueSeries[0];
  const latestOI = operatingIncomeSeries.find((o) => o.period_end === latestRev.period_end);
  if (!latestOI || !isNum(Number(latestRev.value)) || Number(latestRev.value) === 0) {
    return { value: UNKNOWN, method: "no_matching_period_for_revenue_and_operating_income" };
  }
  const margin = Number(latestOI.value) / Number(latestRev.value);
  let base;
  if (margin >= 0.30) base = 5;
  else if (margin >= 0.20) base = 4;
  else if (margin >= 0.10) base = 3;
  else if (margin >= 0) base = 2;
  else base = 1;

  let trendAdj = 0;
  let trendNote = "no_prior_period_for_trend";
  const priorRev = revenueSeries[1];
  const priorOI = priorRev ? operatingIncomeSeries.find((o) => o.period_end === priorRev.period_end) : null;
  if (priorRev && priorOI && Number(priorRev.value) !== 0) {
    const priorMargin = Number(priorOI.value) / Number(priorRev.value);
    const deltaPp = (margin - priorMargin) * 100;
    if (deltaPp >= 2) { trendAdj = 0.5; trendNote = `margin_improved(+${deltaPp.toFixed(1)}pp)`; }
    else if (deltaPp <= -2) { trendAdj = -0.5; trendNote = `margin_declined(${deltaPp.toFixed(1)}pp)`; }
    else { trendNote = `margin_stable(${deltaPp.toFixed(1)}pp)`; }
  }

  return {
    value: clampToConvictionScale(base + trendAdj),
    method: "operating_margin_level_and_yoy_trend",
    operating_margin_pct: Math.round(margin * 1000) / 10,
    trend: trendNote,
    period_end: latestRev.period_end,
    source: "sec_edgar",
  };
}

// ================== GROWTH_TAM ==================
// OBSERVED_GROWTH es FACT (revenue YoY real). TAM_INTERPRETATION nunca
// se calcula aqui -- si existe, es texto de la tesis, marcado aparte,
// NUNCA sustituye el crecimiento observado real.
export function computeObservedGrowth(revenueSeries) {
  if (!revenueSeries || revenueSeries.length < 2) {
    return { value: UNKNOWN, method: "insufficient_revenue_history_need_2_periods", tam_interpretation: UNKNOWN };
  }
  const [latest, prior] = revenueSeries;
  if (!isNum(Number(prior.value)) || Number(prior.value) === 0) {
    return { value: UNKNOWN, method: "invalid_prior_period_revenue", tam_interpretation: UNKNOWN };
  }
  const growthPct = (Number(latest.value) - Number(prior.value)) / Number(prior.value);
  let value;
  if (growthPct >= 0.20) value = 5;
  else if (growthPct >= 0.10) value = 4;
  else if (growthPct >= 0) value = 3;
  else if (growthPct >= -0.10) value = 2;
  else value = 1;

  return {
    value: clampToConvictionScale(value),
    method: "observed_revenue_growth_yoy",
    observed_growth_pct: Math.round(growthPct * 1000) / 10,
    latest_period: latest.period_end,
    prior_period: prior.period_end,
    // TAM_INTERPRETATION deliberadamente separado y UNKNOWN aqui --
    // este modulo nunca lo calcula; si el llamador tiene un texto de
    // tesis relevante, lo adjunta como campo aparte, nunca mezclado.
    tam_interpretation: UNKNOWN,
    source: "sec_edgar",
  };
}

// ================== EXECUTION ==================
// Historial real de earnings vs estimados (>=2 trimestres reales
// exigidos -- "no convertir un solo beat en Execution=5 automaticamente").
// surprises: array de {surprisePct, period_end} reales (de
// computeFinancialScale("EARNINGS", ...) sobre material_events reales).
export function computeExecutionFromEarnings(surprises) {
  if (!surprises || surprises.length < 2) {
    return { value: UNKNOWN, method: "insufficient_earnings_history_need_2_quarters", quarters_available: surprises?.length || 0 };
  }
  const avg = surprises.reduce((a, s) => a + s.surprisePct, 0) / surprises.length;
  const beatCount = surprises.filter((s) => s.surprisePct > 0).length;
  const allBeat = beatCount === surprises.length;
  const allMiss = beatCount === 0;

  let base;
  if (avg >= 0.10) base = 5;
  else if (avg >= 0.05) base = 4;
  else if (avg >= 0) base = 3;
  else if (avg >= -0.05) base = 2;
  else base = 1;

  // Penalizacion de consistencia: resultados mixtos (ni todo beat ni
  // todo miss) restan confianza en que el nivel promedio sea repetible.
  const consistencyAdj = (!allBeat && !allMiss) ? -0.5 : 0;

  return {
    value: clampToConvictionScale(base + consistencyAdj),
    method: "average_earnings_surprise_with_consistency_check",
    avg_surprise_pct: Math.round(avg * 1000) / 10,
    quarters_used: surprises.length,
    beat_count: beatCount,
    consistency: allBeat ? "ALL_BEAT" : allMiss ? "ALL_MISS" : "MIXED",
  };
}

// ================== FINANCIAL_STRENGTH ==================
// Solo generacion de caja real (FCF/Revenue) -- cash/debt/leverage
// declarados UNAVAILABLE explicitamente, nunca fabricados.
export function computeFinancialStrength(revenueSeries, fcfSeries) {
  if (!revenueSeries?.length || !fcfSeries?.length) {
    return { value: UNKNOWN, method: "no_revenue_or_fcf_data", balance_sheet_facts: "UNAVAILABLE(cash/debt/leverage no capturados por el normalizador actual)" };
  }
  const latestRev = revenueSeries[0];
  const latestFcf = fcfSeries.find((f) => f.period_end === latestRev.period_end);
  if (!latestFcf || Number(latestRev.value) === 0) {
    return { value: UNKNOWN, method: "no_matching_period_for_revenue_and_fcf", balance_sheet_facts: "UNAVAILABLE" };
  }
  const fcfMargin = Number(latestFcf.value) / Number(latestRev.value);
  let base;
  if (fcfMargin >= 0.25) base = 5;
  else if (fcfMargin >= 0.15) base = 4;
  else if (fcfMargin >= 0.05) base = 3;
  else if (fcfMargin >= 0) base = 2;
  else base = 1;

  return {
    value: clampToConvictionScale(base),
    method: "fcf_margin_cash_generation_only",
    fcf_margin_pct: Math.round(fcfMargin * 1000) / 10,
    period_end: latestRev.period_end,
    balance_sheet_facts: "UNAVAILABLE(cash/debt/leverage no capturados por el normalizador actual)",
    source: "sec_edgar",
  };
}

// ================== VALUATION (PEG-like, nunca analyst target) ==================
// Explicitamente NUNCA usa price target como medida -- combina 2 facts
// reales independientes (P/E actual de market_cache + crecimiento de
// revenue observado real) en un proxy tipo PEG. Multiplos historicos y
// analyst targets: UNAVAILABLE, declarados, nunca fabricados.
export function computeValuationFromPeg(peRatio, observedGrowthPct) {
  if (!isNum(peRatio) || peRatio <= 0 || !isNum(observedGrowthPct) || observedGrowthPct <= 0) {
    return {
      value: UNKNOWN, method: "insufficient_basis_peg_requires_positive_pe_and_growth",
      current_pe: isNum(peRatio) ? peRatio : UNKNOWN,
      historical_multiples: "UNAVAILABLE", analyst_targets: "UNAVAILABLE(nunca usado como medida unica por diseño)",
    };
  }
  const peg = peRatio / (observedGrowthPct * 100);
  let value;
  if (peg < 1.0) value = 5;
  else if (peg < 1.5) value = 4;
  else if (peg < 2.5) value = 3;
  else if (peg < 4.0) value = 2;
  else value = 1;

  return {
    value: clampToConvictionScale(value),
    method: "peg_like_current_pe_over_observed_revenue_growth",
    current_pe: peRatio,
    observed_growth_pct_used: Math.round(observedGrowthPct * 1000) / 10,
    peg_proxy: Math.round(peg * 100) / 100,
    historical_multiples: "UNAVAILABLE",
    analyst_targets: "UNAVAILABLE(nunca usado como medida unica por diseño)",
  };
}

// ================== LOW COVERAGE GUARD ==================
// Regla explicita, versionada aparte (ver
// lib/thesisConvictionVersioning.js) -- coverage/componentes
// insuficientes producen INSUFFICIENT_EVIDENCE_FOR_CHANGE en vez de
// una recomendacion de cambio, aunque el numero crudo ya este calculado.
export const MIN_COVERAGE_FOR_RECOMMENDATION = 0.30;
export const MIN_COMPONENTS_FOR_RECOMMENDATION = 3;

export function classifyEvidenceSufficiency({ coverage, componentsKnown }) {
  const sufficient = coverage >= MIN_COVERAGE_FOR_RECOMMENDATION && componentsKnown >= MIN_COMPONENTS_FOR_RECOMMENDATION;
  return {
    sufficient,
    reason: sufficient
      ? `coverage(${Math.round(coverage * 100)}%)_and_components(${componentsKnown})_meet_minimum`
      : `coverage(${Math.round(coverage * 100)}%)_or_components(${componentsKnown})_below_minimum(${Math.round(MIN_COVERAGE_FOR_RECOMMENDATION * 100)}%/${MIN_COMPONENTS_FOR_RECOMMENDATION})`,
  };
}
