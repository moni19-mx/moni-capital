// tests/internalOpportunities.test.js
// Sprint Internal Opportunities V1. Tests A-Q pedidos explicitamente --
// SIN red/Supabase (funciones puras de lib/internalOpportunities.js).
// P/Q (golden cases QCOM/AMD) usan los numeros REALES capturados via
// Supabase MCP durante el diseño de este sprint (conviction_history,
// market_cache, sec_financials_normalized reales), nunca inventados.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  resolveConvictionValue, computeConvictionWeightMismatch, computeManualVsEngineDivergence,
  computeConcentrationSignals, computeValuationSignal, deriveOverallReviewPriority,
  computeDataCoverage, buildTickerOpportunity,
  CONVICTION_WEIGHT_THRESHOLDS, CONCENTRATION_THRESHOLDS, DIVERGENCE_THRESHOLD,
} from "../lib/internalOpportunities.js";

// ================== A-C: Signal A bands ==================
test("A - conviction alta (4.5) + peso bajo (0.5%) -> HIGH_CONVICTION_LOW_WEIGHT", () => {
  const s = computeConvictionWeightMismatch({ ticker: "X", convictionValue: 4.5, convictionSource: "engine_accepted", weightPct: 0.5, evidenceRefs: [] });
  assert.equal(s.signal_type, "CONVICTION_WEIGHT_MISMATCH");
  assert.equal(s.direction, "HIGH_CONVICTION_LOW_WEIGHT");
  assert.equal(s.review_required, true);
  assert.equal(s.recommendation, "REVIEW_SIZING");
});

test("B - conviction baja (2.5) + peso alto (10%) -> LOW_CONVICTION_HIGH_WEIGHT", () => {
  const s = computeConvictionWeightMismatch({ ticker: "X", convictionValue: 2.5, convictionSource: "manual_thesis_unreviewed", weightPct: 10, evidenceRefs: [] });
  assert.equal(s.direction, "LOW_CONVICTION_HIGH_WEIGHT");
  assert.equal(s.recommendation, "REVIEW_SIZING");
});

test("C - conviction MEDIUM (3.5) + peso bajo (0.5%) -> sin mismatch (null)", () => {
  const s = computeConvictionWeightMismatch({ ticker: "X", convictionValue: 3.5, convictionSource: "engine_proposed_pending_review", weightPct: 0.5, evidenceRefs: [] });
  assert.equal(s, null, "REGRESION: 3.5 no cruza CONVICTION_HIGH(4.0) ni CONVICTION_LOW(3.0) -- combinacion intermedia, nunca señal");
});

// ================== D-F: Conviction source precedence ==================
test("D - accepted_conviction gana sobre proposed/manual", () => {
  const r = resolveConvictionValue({ acceptedConviction: 4.5, proposedConviction: 2.0, deterministicStatus: "SCORED", manualConviction: 5 });
  assert.deepEqual(r, { value: 4.5, source: "engine_accepted" });
});

test("E - proposed (SCORED) gana sobre manual cuando no hay accepted", () => {
  const r = resolveConvictionValue({ acceptedConviction: null, proposedConviction: 3.5, deterministicStatus: "SCORED", manualConviction: 5 });
  assert.deepEqual(r, { value: 3.5, source: "engine_proposed_pending_review" });
});

test("F - manual fallback cuando no hay engine (sin accepted, sin SCORED)", () => {
  const r = resolveConvictionValue({ acceptedConviction: null, proposedConviction: null, deterministicStatus: null, manualConviction: 4 });
  assert.deepEqual(r, { value: 4, source: "manual_thesis_unreviewed" });
});

// ================== G-H: MANUAL_VS_ENGINE_DIVERGENCE ==================
test("G - divergencia >=1.0 (manual=5, engine=3.5, delta=-1.5) -> señal", () => {
  const s = computeManualVsEngineDivergence({
    ticker: "X", manualConviction: 5, engineValue: 3.5, engineSource: "engine_proposed_pending_review",
    engineDeterministicStatus: "SCORED", engineConfidence: 84, engineCoverage: 0.619, evidenceRefs: [],
  });
  assert.equal(s.signal_type, "MANUAL_VS_ENGINE_DIVERGENCE");
  assert.equal(s.delta, -1.5);
  assert.equal(s.direction, "ENGINE_BELOW_MANUAL");
  assert.equal(s.review_required, true);
  assert.equal(s.recommendation, "REVIEW_CONVICTION");
});

test("H - divergencia <1.0 (manual=4, engine=3.5, delta=-0.5) -> sin señal", () => {
  const s = computeManualVsEngineDivergence({
    ticker: "X", manualConviction: 4, engineValue: 3.5, engineSource: "engine_proposed_pending_review",
    engineDeterministicStatus: "SCORED", engineConfidence: 80, engineCoverage: 0.5, evidenceRefs: [],
  });
  assert.equal(s, null);
});

test("H2 - fuente manual (engine nunca corrio) -> nunca se compara consigo misma", () => {
  const s = computeManualVsEngineDivergence({
    ticker: "X", manualConviction: 4, engineValue: 4, engineSource: "manual_thesis_unreviewed",
    engineDeterministicStatus: null, engineConfidence: null, engineCoverage: null, evidenceRefs: [],
  });
  assert.equal(s, null, "REGRESION: nunca debe compararse el manual contra si mismo");
});

// ================== I-K: CONCENTRATION_SIGNAL ==================
function fakeConcentration({ top1Pct, top5Pct, top10Pct }) {
  return {
    status: "COMPLETE",
    top1_pct: top1Pct, top5_pct: top5Pct, top10_pct: top10Pct,
    top5: [{ ticker: "T1", portfolio_weight_pct: top1Pct }, { ticker: "T2" }, { ticker: "T3" }, { ticker: "T4" }, { ticker: "T5" }],
    top10: [{ ticker: "T1" }, { ticker: "T2" }, { ticker: "T3" }, { ticker: "T4" }, { ticker: "T5" }, { ticker: "T6" }, { ticker: "T7" }, { ticker: "T8" }, { ticker: "T9" }, { ticker: "T10" }],
  };
}

test("I - single-position concentration (top1=44.5%, real BTC) -> HIGH sobre T1", () => {
  const r = computeConcentrationSignals(fakeConcentration({ top1Pct: 44.513, top5Pct: 10, top10Pct: 10 }));
  const s = r.signals_by_ticker.T1.find((x) => x.scope === "SINGLE_POSITION");
  assert.equal(s.strength, "HIGH");
  assert.equal(s.threshold_pct, CONCENTRATION_THRESHOLDS.SINGLE_HIGH_PCT);
  assert.equal(s.recommendation, "REVIEW_SIZING");
});

test("J - top5 concentration (65%) -> HIGH aplicado a los 5 miembros", () => {
  const r = computeConcentrationSignals(fakeConcentration({ top1Pct: 15, top5Pct: 65, top10Pct: 70 }));
  ["T1", "T2", "T3", "T4", "T5"].forEach((t) => {
    const s = r.signals_by_ticker[t].find((x) => x.scope === "TOP5");
    assert.equal(s.strength, "HIGH");
  });
  assert.equal(r.signals_by_ticker.T6, undefined, "T6 no es miembro de top5, no debe recibir la señal TOP5");
});

test("K - top10 concentration (85%) -> HIGH aplicado a los 10 miembros", () => {
  const r = computeConcentrationSignals(fakeConcentration({ top1Pct: 15, top5Pct: 50, top10Pct: 85 }));
  const s = r.signals_by_ticker.T10.find((x) => x.scope === "TOP10");
  assert.equal(s.strength, "HIGH");
  assert.equal(s.threshold_pct, CONCENTRATION_THRESHOLDS.TOP10_HIGH_PCT);
});

test("K2 - top10 real (76.4%, bajo el umbral 80) -> NO dispara (dato real de las 39 posiciones)", () => {
  const r = computeConcentrationSignals(fakeConcentration({ top1Pct: 44.513, top5Pct: 65.357, top10Pct: 76.371 }));
  const hasTop10Signal = Object.values(r.signals_by_ticker).some((sigs) => sigs.some((s) => s.scope === "TOP10"));
  assert.equal(hasTop10Signal, false, "REGRESION: 76.4% real no debe inventar un HIGH que no cruza el umbral");
});

// ================== L-M: VALUATION_SIGNAL ==================
test("L - VALUATION conocido (componente real QCOM, PEG=1.4) -> status KNOWN, expone evidencia", () => {
  const s = computeValuationSignal({
    ticker: "QCOM",
    valuationComponent: { value: 4, method: "peg_like_current_pe_over_observed_revenue_growth", peg_proxy: 1.4, current_pe: 19.1399, observed_growth_pct_used: 13.7 },
    overallConfidence: 83, coverage: 0.524, evidenceRefs: [{ conviction_history_id: 1 }],
  });
  assert.equal(s.status, "KNOWN");
  assert.equal(s.value, 4);
  assert.equal(s.peg_proxy, 1.4);
  assert.equal(s.review_required, false, "VALUATION nunca se auto-marca como accionable por si sola");
});

test("M - VALUATION UNKNOWN (sin cobertura SEC) -> status UNKNOWN, nunca inventa un nivel", () => {
  const s = computeValuationSignal({ ticker: "AAOI", valuationComponent: null, overallConfidence: null, coverage: null, evidenceRefs: [] });
  assert.equal(s.status, "UNKNOWN");
  assert.equal(s.value, undefined);
});

// ================== N: nunca BUY/SELL ==================
test("N - ningun string de recommendation/explanation contiene BUY/SELL/comprar/vender", () => {
  const forbidden = /\b(buy|sell|comprar|vender)\b/i;
  const samples = [
    computeConvictionWeightMismatch({ ticker: "X", convictionValue: 4.5, convictionSource: "engine_accepted", weightPct: 0.3, evidenceRefs: [] }),
    computeConvictionWeightMismatch({ ticker: "Y", convictionValue: 2.0, convictionSource: "manual_thesis_unreviewed", weightPct: 25, evidenceRefs: [] }),
    computeManualVsEngineDivergence({ ticker: "Z", manualConviction: 5, engineValue: 3, engineSource: "engine_proposed_pending_review", engineDeterministicStatus: "SCORED", engineConfidence: 80, engineCoverage: 0.5, evidenceRefs: [] }),
    computeValuationSignal({ ticker: "Q", valuationComponent: { value: 5, method: "peg_like_current_pe_over_observed_revenue_growth", peg_proxy: 0.8 }, overallConfidence: 90, coverage: 0.8, evidenceRefs: [] }),
    computeValuationSignal({ ticker: "R", valuationComponent: null, overallConfidence: null, coverage: null, evidenceRefs: [] }),
    ...Object.values(computeConcentrationSignals(fakeConcentration({ top1Pct: 44.5, top5Pct: 65, top10Pct: 85 })).signals_by_ticker).flat(),
  ].filter(Boolean);
  for (const s of samples) {
    assert.equal(forbidden.test(s.explanation || ""), false, `explanation con BUY/SELL: ${s.explanation}`);
    assert.equal(forbidden.test(s.recommendation || ""), false, `recommendation con BUY/SELL: ${s.recommendation}`);
    assert.ok(["REVIEW_SIZING", "REVIEW_CONVICTION", null].includes(s.recommendation), `recommendation fuera del vocabulario permitido: ${s.recommendation}`);
  }
});

// ================== O: nunca un score compuesto ==================
test("O - ningun signal ni el objeto por ticker exponen un campo 'score'/'opportunity_score'", () => {
  const signalA = computeConvictionWeightMismatch({ ticker: "X", convictionValue: 4.5, convictionSource: "engine_accepted", weightPct: 0.3, evidenceRefs: [] });
  const divergence = computeManualVsEngineDivergence({ ticker: "X", manualConviction: 5, engineValue: 3, engineSource: "engine_proposed_pending_review", engineDeterministicStatus: "SCORED", engineConfidence: 80, engineCoverage: 0.5, evidenceRefs: [] });
  const valuation = computeValuationSignal({ ticker: "X", valuationComponent: { value: 3, method: "m" }, overallConfidence: 50, coverage: 0.3, evidenceRefs: [] });
  const ticker = buildTickerOpportunity({ ticker: "X", signals: [signalA, divergence, valuation], dataCoverage: computeDataCoverage({ convictionKnown: true, weightKnown: true, valuationKnown: true }) });
  for (const obj of [signalA, divergence, valuation, ticker]) {
    assert.equal(Object.keys(obj).includes("score"), false);
    assert.equal(Object.keys(obj).includes("opportunity_score"), false);
  }
});

// ================== overall_review_priority policy ==================
test("priority - 0 señales review_required -> LOW", () => {
  assert.equal(deriveOverallReviewPriority([]), "LOW");
});
test("priority - 1 señal review_required -> MEDIUM", () => {
  assert.equal(deriveOverallReviewPriority([{ signal_type: "X", review_required: true }]), "MEDIUM");
});
test("priority - divergence presente -> HIGH aunque sea la unica señal", () => {
  assert.equal(deriveOverallReviewPriority([{ signal_type: "MANUAL_VS_ENGINE_DIVERGENCE", review_required: true }]), "HIGH");
});
test("priority - LOW_CONVICTION_HIGH_WEIGHT -> HIGH aunque sea la unica señal", () => {
  assert.equal(deriveOverallReviewPriority([{ signal_type: "CONVICTION_WEIGHT_MISMATCH", direction: "LOW_CONVICTION_HIGH_WEIGHT", review_required: true }]), "HIGH");
});
test("priority - 2 señales review_required sin divergence/LOW_CONV -> HIGH", () => {
  const signals = [
    { signal_type: "CONVICTION_WEIGHT_MISMATCH", direction: "HIGH_CONVICTION_LOW_WEIGHT", review_required: true },
    { signal_type: "CONCENTRATION_SIGNAL", review_required: true },
  ];
  assert.equal(deriveOverallReviewPriority(signals), "HIGH");
});

// ================== P: QCOM golden case (numeros reales) ==================
test("P - QCOM golden case: conviction engine 4.0, peso 0.228% -> HIGH_CONVICTION_LOW_WEIGHT, sin concentracion, VALUATION KNOWN, sin divergencia", () => {
  const resolved = resolveConvictionValue({ acceptedConviction: null, proposedConviction: 4.0, deterministicStatus: "SCORED", manualConviction: 4 });
  assert.deepEqual(resolved, { value: 4.0, source: "engine_proposed_pending_review" });

  const mismatch = computeConvictionWeightMismatch({
    ticker: "QCOM", convictionValue: resolved.value, convictionSource: resolved.source, weightPct: 0.228, evidenceRefs: [{ conviction_history_id: 999 }],
  });
  assert.equal(mismatch.direction, "HIGH_CONVICTION_LOW_WEIGHT");
  assert.equal(mismatch.strength, "HIGH", "0.228% esta muy por debajo de 0.5 -- strength HIGH");
  // Calibracion C+E: QCOM es engine-sourced (engine_proposed_pending_review)
  // -- debe seguir REVIEW_REQUIRED, nunca degradarse a INFORMATIONAL.
  assert.equal(mismatch.classification, "REVIEW_REQUIRED");
  assert.equal(mismatch.review_required, true);

  const divergence = computeManualVsEngineDivergence({
    ticker: "QCOM", manualConviction: 4, engineValue: resolved.value, engineSource: resolved.source,
    engineDeterministicStatus: "SCORED", engineConfidence: 83, engineCoverage: 0.524, evidenceRefs: [],
  });
  assert.equal(divergence, null, "manual(4.0) == engine(4.0) -- delta=0, nunca una divergencia real");

  const valuation = computeValuationSignal({
    ticker: "QCOM",
    valuationComponent: { value: 4, method: "peg_like_current_pe_over_observed_revenue_growth", peg_proxy: 1.4, current_pe: 19.1399, observed_growth_pct_used: 13.7 },
    overallConfidence: 83, coverage: 0.524, evidenceRefs: [],
  });
  assert.equal(valuation.status, "KNOWN");

  const concentration = computeConcentrationSignals(fakeConcentration({ top1Pct: 44.513, top5Pct: 65.357, top10Pct: 76.371 }));
  assert.equal(concentration.signals_by_ticker.QCOM, undefined, "QCOM (peso 0.228%) no es miembro de top1/top5/top10 reales");

  const ticker = buildTickerOpportunity({
    ticker: "QCOM", signals: [mismatch, divergence, valuation],
    dataCoverage: computeDataCoverage({ convictionKnown: true, weightKnown: true, valuationKnown: true }),
  });
  // Politica aprobada (item 6): HIGH exige divergence, o
  // LOW_CONVICTION_HIGH_WEIGHT especificamente, o >=2 señales
  // review_required -- un unico HIGH_CONVICTION_LOW_WEIGHT (este caso)
  // no esta en esa lista, queda MEDIUM (1 señal review_required).
  assert.equal(ticker.overall_review_priority, "MEDIUM");
  assert.equal(ticker.data_coverage, 100);
  assert.deepEqual(ticker.unknowns, []);
});

// ================== Q: AMD golden case (numeros reales) ==================
test("Q - AMD golden case: manual=5, engine=3.5, peso 1.08% -> NO mismatch (fuente engine), SI divergence(-1.5), VALUATION KNOWN", () => {
  const resolved = resolveConvictionValue({ acceptedConviction: null, proposedConviction: 3.5, deterministicStatus: "SCORED", manualConviction: 5 });
  assert.deepEqual(resolved, { value: 3.5, source: "engine_proposed_pending_review" });

  const mismatch = computeConvictionWeightMismatch({
    ticker: "AMD", convictionValue: resolved.value, convictionSource: resolved.source, weightPct: 1.080, evidenceRefs: [],
  });
  assert.equal(mismatch, null, "REGRESION CRITICA: usando la fuente correcta (engine=3.5, MEDIUM) NUNCA debe dispararse HIGH_CONVICTION_LOW_WEIGHT -- solo lo haria con el manual(5) stale");

  const divergence = computeManualVsEngineDivergence({
    ticker: "AMD", manualConviction: 5, engineValue: resolved.value, engineSource: resolved.source,
    engineDeterministicStatus: "SCORED", engineConfidence: 84, engineCoverage: 0.619, evidenceRefs: [],
  });
  assert.ok(divergence);
  assert.equal(divergence.delta, -1.5);
  assert.equal(divergence.direction, "ENGINE_BELOW_MANUAL");
  assert.equal(divergence.review_required, true);

  const valuation = computeValuationSignal({
    ticker: "AMD",
    valuationComponent: { value: 2, method: "peg_like_current_pe_over_observed_revenue_growth", peg_proxy: 3.53, current_pe: 121.1721, observed_growth_pct_used: 34.3 },
    overallConfidence: 84, coverage: 0.619, evidenceRefs: [],
  });
  assert.equal(valuation.status, "KNOWN");
  assert.equal(valuation.value, 2);

  const concentration = computeConcentrationSignals(fakeConcentration({ top1Pct: 44.513, top5Pct: 65.357, top10Pct: 76.371 }));
  assert.equal(concentration.signals_by_ticker.AMD, undefined, "AMD (peso 1.08%) no es miembro de top1/top5/top10 reales");

  const ticker = buildTickerOpportunity({
    ticker: "AMD", signals: [mismatch, divergence, valuation],
    dataCoverage: computeDataCoverage({ convictionKnown: true, weightKnown: true, valuationKnown: true }),
  });
  assert.equal(ticker.overall_review_priority, "HIGH", "la divergencia por si sola ya eleva a HIGH, aunque no haya mismatch de sizing");
  assert.equal(ticker.signals.length, 2, "el mismatch null se filtra, quedan solo divergence + valuation");
});

// ================== resolve threshold constants sanity ==================
test("constants - umbrales expuestos coinciden con los aprobados", () => {
  assert.equal(CONVICTION_WEIGHT_THRESHOLDS.CONVICTION_HIGH, 4.0);
  assert.equal(CONVICTION_WEIGHT_THRESHOLDS.CONVICTION_LOW, 3.0);
  assert.equal(CONVICTION_WEIGHT_THRESHOLDS.WEIGHT_LOW_PCT, 1.5);
  assert.equal(CONVICTION_WEIGHT_THRESHOLDS.WEIGHT_HIGH_PCT, 8.0);
  assert.equal(CONCENTRATION_THRESHOLDS.SINGLE_HIGH_PCT, 35);
  assert.equal(CONCENTRATION_THRESHOLDS.SINGLE_MEDIUM_PCT, 20);
  assert.equal(CONCENTRATION_THRESHOLDS.TOP5_HIGH_PCT, 60);
  assert.equal(CONCENTRATION_THRESHOLDS.TOP10_HIGH_PCT, 80);
  assert.equal(DIVERGENCE_THRESHOLD, 1.0);
});

// ================== CALIBRATION C+E (Internal Opportunities Calibration) ==================
// Auditoria real (sprint anterior): HIGH_CONVICTION_LOW_WEIGHT disparaba
// en 21/39 posiciones (54%) -- demasiado ancho para ser accionable, casi
// todo dominado por convicciones manuales nunca revisadas por el engine.
// Los thresholds (1.5%/8.0%) NO cambian -- se aprobo condicionar
// review_required/classification a la calidad de la evidencia detras
// del numero (conviction_source), nunca descartar el caso.

test("CAL-1 - manual_thesis_unreviewed + HIGH_CONVICTION_LOW_WEIGHT -> classification INFORMATIONAL, review_required=false", () => {
  const s = computeConvictionWeightMismatch({
    ticker: "X", convictionValue: 4, convictionSource: "manual_thesis_unreviewed", weightPct: 0.6, evidenceRefs: [],
  });
  assert.equal(s.direction, "HIGH_CONVICTION_LOW_WEIGHT");
  assert.equal(s.classification, "INFORMATIONAL");
  assert.equal(s.review_required, false, "REGRESION: una señal INFORMATIONAL nunca debe quedar review_required=true");
});

test("CAL-2 - engine_proposed_pending_review + HIGH_CONVICTION_LOW_WEIGHT -> classification REVIEW_REQUIRED", () => {
  const s = computeConvictionWeightMismatch({
    ticker: "X", convictionValue: 4, convictionSource: "engine_proposed_pending_review", weightPct: 0.6, evidenceRefs: [],
  });
  assert.equal(s.classification, "REVIEW_REQUIRED");
  assert.equal(s.review_required, true);
});

test("CAL-3 - engine_accepted + HIGH_CONVICTION_LOW_WEIGHT -> classification REVIEW_REQUIRED", () => {
  const s = computeConvictionWeightMismatch({
    ticker: "X", convictionValue: 4.5, convictionSource: "engine_accepted", weightPct: 0.3, evidenceRefs: [],
  });
  assert.equal(s.classification, "REVIEW_REQUIRED");
  assert.equal(s.review_required, true);
});

test("CAL-4 - una señal INFORMATIONAL en solitario NUNCA eleva overall_review_priority por encima de LOW", () => {
  const informational = computeConvictionWeightMismatch({
    ticker: "X", convictionValue: 4, convictionSource: "manual_thesis_unreviewed", weightPct: 0.6, evidenceRefs: [],
  });
  assert.equal(deriveOverallReviewPriority([informational]), "LOW", "REGRESION: INFORMATIONAL no debe participar en overall_review_priority");
});

test("CAL-4b - 20 señales INFORMATIONAL juntas SIGUEN sin elevar prioridad (nunca cuentan, sin importar cuantas)", () => {
  const many = Array.from({ length: 20 }, (_, i) => computeConvictionWeightMismatch({
    ticker: `X${i}`, convictionValue: 4, convictionSource: "manual_thesis_unreviewed", weightPct: 0.6, evidenceRefs: [],
  }));
  assert.equal(deriveOverallReviewPriority(many), "LOW");
});

test("CAL-5 - MANUAL_VS_ENGINE_DIVERGENCE sigue elevando a HIGH aunque coexista con un mismatch INFORMATIONAL", () => {
  const informational = computeConvictionWeightMismatch({
    ticker: "X", convictionValue: 4, convictionSource: "manual_thesis_unreviewed", weightPct: 0.6, evidenceRefs: [],
  });
  const divergence = computeManualVsEngineDivergence({
    ticker: "X", manualConviction: 5, engineValue: 3.5, engineSource: "engine_proposed_pending_review",
    engineDeterministicStatus: "SCORED", engineConfidence: 80, engineCoverage: 0.5, evidenceRefs: [],
  });
  assert.equal(deriveOverallReviewPriority([informational, divergence]), "HIGH");
});

test("CAL-6 - VALUATION_SIGNAL no cambio (regresion) -- sigue KNOWN/UNKNOWN, sin classification/review_required nuevo", () => {
  const known = computeValuationSignal({
    ticker: "QCOM", valuationComponent: { value: 4, method: "peg_like_current_pe_over_observed_revenue_growth", peg_proxy: 1.4 },
    overallConfidence: 83, coverage: 0.524, evidenceRefs: [],
  });
  assert.equal(known.status, "KNOWN");
  assert.equal(known.review_required, false);
  assert.equal(Object.keys(known).includes("classification"), false, "VALUATION_SIGNAL no participa de la calibracion C+E, queda sin cambios");
});

test("CAL-7 - ninguna explanation de señal INFORMATIONAL contiene BUY/SELL/comprar/vender", () => {
  const forbidden = /\b(buy|sell|comprar|vender)\b/i;
  const s = computeConvictionWeightMismatch({
    ticker: "X", convictionValue: 4, convictionSource: "manual_thesis_unreviewed", weightPct: 0.6, evidenceRefs: [],
  });
  assert.equal(forbidden.test(s.explanation), false);
  assert.ok(["REVIEW_SIZING", "REVIEW_CONVICTION", null].includes(s.recommendation));
});

test("CAL-8 - ningun campo 'score'/'opportunity_score' se agrego con la calibracion (classification es un enum, no un numero)", () => {
  const s = computeConvictionWeightMismatch({
    ticker: "X", convictionValue: 4, convictionSource: "manual_thesis_unreviewed", weightPct: 0.6, evidenceRefs: [],
  });
  assert.equal(Object.keys(s).includes("score"), false);
  assert.equal(typeof s.classification, "string");
});

// ================== CAL-9: QCOM golden case (post-calibracion) ==================
test("CAL-9 - QCOM golden case: sigue engine-sourced, classification=REVIEW_REQUIRED, review_required=true, overall_review_priority=MEDIUM", () => {
  const resolved = resolveConvictionValue({ acceptedConviction: null, proposedConviction: 4.0, deterministicStatus: "SCORED", manualConviction: 4 });
  const mismatch = computeConvictionWeightMismatch({
    ticker: "QCOM", convictionValue: resolved.value, convictionSource: resolved.source, weightPct: 0.228, evidenceRefs: [],
  });
  assert.equal(mismatch.classification, "REVIEW_REQUIRED");
  assert.equal(mismatch.review_required, true);
  const ticker = buildTickerOpportunity({
    ticker: "QCOM", signals: [mismatch],
    dataCoverage: computeDataCoverage({ convictionKnown: true, weightKnown: true, valuationKnown: true }),
  });
  assert.equal(ticker.overall_review_priority, "MEDIUM", "1 sola señal REVIEW_REQUIRED, sin divergence ni LOW_CONVICTION_HIGH_WEIGHT -> MEDIUM, sin cambio respecto a antes de la calibracion");
});

// ================== CAL-10: golden case manual real (AAOI) ==================
// AAOI real: thesis.conviction=4 (manual, nunca paso por conviction_history
// -- conviction_history no tiene ninguna fila para AAOI), portfolio_weight_pct=0.624%
// real (SQL directo, sprint Internal Opportunities V1). Antes de esta
// calibracion, disparaba HIGH_CONVICTION_LOW_WEIGHT con review_required=true
// como cualquier otro -- uno de los 21/39 que infló el ruido accionable.
test("CAL-10 - AAOI golden case (manual_thesis_unreviewed real, conviction=4, weight=0.624%): INFORMATIONAL, no eleva prioridad", () => {
  const resolved = resolveConvictionValue({ acceptedConviction: null, proposedConviction: null, deterministicStatus: null, manualConviction: 4 });
  assert.deepEqual(resolved, { value: 4, source: "manual_thesis_unreviewed" });

  const mismatch = computeConvictionWeightMismatch({
    ticker: "AAOI", convictionValue: resolved.value, convictionSource: resolved.source, weightPct: 0.624, evidenceRefs: [],
  });
  assert.equal(mismatch.direction, "HIGH_CONVICTION_LOW_WEIGHT");
  assert.equal(mismatch.classification, "INFORMATIONAL");
  assert.equal(mismatch.review_required, false);

  const ticker = buildTickerOpportunity({
    ticker: "AAOI", signals: [mismatch],
    dataCoverage: computeDataCoverage({ convictionKnown: true, weightKnown: true, valuationKnown: false }),
  });
  assert.equal(ticker.overall_review_priority, "LOW", "REGRESION: antes de la calibracion esto hubiera sido MEDIUM -- ahora INFORMATIONAL no cuenta");
  assert.equal(ticker.signals.length, 1, "la señal sigue calculandose y mostrandose, nunca se descarta");
});
