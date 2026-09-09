// lib/thesisConvictionVersioning.js
// Sprint P3.2 (Thesis / Conviction Engine 2.0). Mismo patron que
// lib/materialEventVersioning.js -- versiones de policy separadas del
// codigo, para que un conviction_history historico siga siendo
// reproducible aunque los pesos, la formula de coverage, o los pesos de
// confidence cambien despues de forma independiente unos de otros.

// v1.1.0 (Micro-sprint P3.2.1): el engine ahora tambien mezcla
// componentes DETERMINISTICOS de facts reales (ver
// lib/fundamentalConviction.js) sobre los componentes previos --
// mismo formula/pesos de v1.0.0 (ver CALIBRATION RULE abajo), pero el
// conjunto de inputs que puede llenar cada componente cambio, por eso
// se versiona aparte para que un conviction_history v1.0.0 siga siendo
// reproducible con sus propios inputs originales.
export const CONVICTION_ENGINE_VERSION = "conviction-engine-v1.1.0";

// Micro-sprint P3.2.1 (Fundamental Conviction Coverage). Version de la
// policy de calculo DETERMINISTICO de componentes fundamentales (ver
// lib/fundamentalConviction.js) -- separada de CONVICTION_SCORING_POLICY_VERSION
// porque cubre COMO SE LLENAN los componentes con facts reales, no la
// formula que los combina (esa no cambio, ver CALIBRATION RULE en el
// reporte final de P3.2.1: "mejora INPUT COVERAGE, no tunea el resultado").
export const FUNDAMENTAL_CONVICTION_POLICY_VERSION = "fundamental-conviction-v1.0.0";

// Micro-sprint P3.2.1, item 14/21 (LOW COVERAGE GUARD). Version de la
// regla que decide si coverage/componentes conocidos alcanzan el
// minimo para siquiera PROPONER un cambio de conviction -- ver
// lib/fundamentalConviction.js::classifyEvidenceSufficiency.
export const LOW_COVERAGE_GUARD_POLICY_VERSION = "low-coverage-guard-v1.0.0";

// CONVICTION_WEIGHTS: derivados de los 10 componentes originales
// propuestos por el usuario (Business Quality 15, Growth/TAM 15,
// Competitive Position 10, Execution 10, Financial Strength 10,
// Valuation 15, Catalysts 10, Thesis Confirmation 10, Risk 10,
// Portfolio Fit 5). Dos correcciones documentadas ANTES de implementar
// (Sprint P3.2, seccion 4/5 del reporte):
//
// 1. Esos 10 pesos suman 110, no 100 -- error aritmetico real en la
//    lista original, detectado en el audit obligatorio.
// 2. PORTFOLIO_FIT se elimina del conviction (mismo principio que
//    STRATEGIC_RELEVANCE en P3.1B.2: "ya tengo demasiado semiconductor"
//    no debe bajar la calidad de QCOM como inversion -- eso es una
//    señal de PORTFOLIO, no de la empresa/tesis).
//
// Los 9 componentes restantes (suma original 105) se renormalizan
// proporcionalmente a 100: cada peso_original * (100/105). Los 3
// componentes de 15 quedan en 100/7 (~14.29), los 6 de 10 quedan en
// 200/21 (~9.52) -- no son numeros redondos a proposito: son la
// consecuencia exacta y documentada de la correccion, no un ajuste
// arbitrario.
const RAW_9 = Object.freeze({
  BUSINESS_QUALITY: 15, GROWTH_TAM: 15, VALUATION: 15,
  COMPETITIVE_POSITION: 10, EXECUTION: 10, FINANCIAL_STRENGTH: 10,
  CATALYSTS: 10, THESIS_CONFIRMATION: 10, RISK: 10,
});
const RAW_9_SUM = Object.values(RAW_9).reduce((a, b) => a + b, 0); // 105

export const CONVICTION_WEIGHTS = Object.freeze(
  Object.fromEntries(Object.entries(RAW_9).map(([k, v]) => [k, v / RAW_9_SUM]))
);

export const CONVICTION_SCALE_MIN = 1.0;
export const CONVICTION_SCALE_MAX = 5.0;
export const CONVICTION_SCALE_STEP = 0.5;
export const CONVICTION_SCALE_MIDPOINT = 3.0; // neutral -- ni tesis fuerte ni debil

export const CONVICTION_SCORING_POLICY_VERSION = "conviction-scoring-v1.0.0";

export const CONVICTION_CONFIDENCE_POLICY_VERSION = "conviction-confidence-v1.0.0";
export const CONVICTION_CONFIDENCE_WEIGHTS = Object.freeze({
  source: 0.30, completeness: 0.30, freshness: 0.20, consistency: 0.20,
});

// Umbrales de USER_REVIEW (seccion 12 del sprint) -- versionados junto
// con el resto de la policy, nunca numeros magicos sueltos en el punto
// de uso.
export const REVIEW_POLICY_VERSION = "conviction-review-v1.0.0";
export const REVIEW_THRESHOLDS = Object.freeze({
  deltaRequiresReview: 0.5, // |delta| > este valor -> USER_REVIEW
  triggeringEventMaterialityThreshold: 70, // un solo evento >= esto dispara review
  minConfidenceForAutoAccept: 70,
  maxDeltaForAutoAccept: 0.5, // solo revision periodica, delta pequeño
});
