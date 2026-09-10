// tests/secFinancialsResolver.test.js
// Sprint P2A (Valuation Facts Layer) -- tests de la logica PURA de
// resolucion SEC XBRL (lib/secFinancialsResolver.js). Cero red.
//
// Grupo 1 (A-F): regresion de la logica anual EXISTENTE (movida desde
// api/sec-benchmark-temp.js, sin cambios de comportamiento) -- confirma
// que el refactor no rompio nada de REVENUE/NET_INCOME/etc.
// Grupo 2 (G-J): EPS_DILUTED como septimo concepto (misma maquinaria).
// Grupo 3 (K-R): capa trimestral + TTM EPS, nueva en este sprint --
// incluye el caso explicito "nunca sintetizar un trimestre faltante".

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CANDIDATE_TAGS, CANONICAL_CONCEPTS, CONCEPT_UNITS, selectCompatibleUnit,
  extractAnnualPoints, scoreCandidate, computeConfidence, confidenceRank,
  pickWinnerAndDetectAmbiguity, extractQuarterlyPoints, computeTtmEps,
} from "../lib/secFinancialsResolver.js";

const USD = ["USD"];
const USD_PER_SHARE = ["USD/shares"];

function annualEntry({ end, start, val, form = "10-K", filed, fy }) {
  return { start, end, val, form, filed: filed || end, fy };
}

// ================== Grupo 1: regresion anual (sin cambios) ==================

test("A - extractAnnualPoints: filtra por forma confiable (10-K) y duracion ~365 dias", () => {
  const conceptJson = {
    units: {
      USD: [
        annualEntry({ start: "2023-01-01", end: "2023-12-31", val: 1000, fy: 2023 }),
        annualEntry({ start: "2023-10-01", end: "2023-12-31", val: 300, form: "10-Q" }), // trimestral -- nunca cuenta como anual
        annualEntry({ start: "2022-01-01", end: "2022-12-31", val: 900, form: "DEF 14A", fy: 2022 }), // forma no confiable, nunca participa
      ],
    },
  };
  const points = extractAnnualPoints(conceptJson, USD);
  assert.equal(points.length, 1);
  assert.equal(points[0].value, 1000);
});

test("B - extractAnnualPoints: 10-K/A mas reciente gana sobre el 10-K original del mismo periodo", () => {
  const conceptJson = {
    units: {
      USD: [
        annualEntry({ start: "2023-01-01", end: "2023-12-31", val: 1000, filed: "2024-02-01" }),
        annualEntry({ start: "2023-01-01", end: "2023-12-31", val: 1050, form: "10-K/A", filed: "2024-06-01" }),
      ],
    },
  };
  const points = extractAnnualPoints(conceptJson, USD);
  assert.equal(points.length, 1);
  assert.equal(points[0].value, 1050);
  assert.equal(points[0].form, "10-K/A");
});

test("C - scoreCandidate: continuidad se corta en el primer hueco > 400 dias", () => {
  const points = [
    { period_end: "2025-12-31" }, { period_end: "2024-12-31" },
    { period_end: "2021-12-31" }, // hueco grande -- rompe continuidad aqui
    { period_end: "2020-12-31" },
  ].map((p) => ({ ...p, form: "10-K" }));
  const score = scoreCandidate(points);
  assert.equal(score.continuity, 2);
  assert.equal(score.coverage, 4);
});

test("D - computeConfidence: HIGH requiere recencia+cobertura+continuidad+forma confiable, todo junto", () => {
  const recent = new Date().toISOString().slice(0, 10);
  const highScore = { recencyDays: 100, coverage: 3, continuity: 3, form10K: 3 };
  assert.equal(computeConfidence(highScore), "HIGH");
  const mediumScore = { recencyDays: 600, coverage: 2, continuity: 2, form10K: 2 };
  assert.equal(computeConfidence(mediumScore), "MEDIUM");
  const lowScore = { recencyDays: 900, coverage: 1, continuity: 1, form10K: 1 };
  assert.equal(computeConfidence(lowScore), "LOW");
});

test("E - pickWinnerAndDetectAmbiguity: sin candidatos -> DATA_UNAVAILABLE", () => {
  const result = pickWinnerAndDetectAmbiguity([], ["TagA"]);
  assert.equal(result.status, "DATA_UNAVAILABLE");
});

test("F - pickWinnerAndDetectAmbiguity: dos tags con valores >5% distintos en el mismo periodo -> LOW + ambiguityNote, nunca elegido en silencio", () => {
  const candidates = [
    { tag: "TagA", points: [{ period_end: "2025-12-31", value: 1000 }], score: { recencyDays: 100, coverage: 1, continuity: 1, form10K: 1 } },
    { tag: "TagB", points: [{ period_end: "2025-12-31", value: 1200 }], score: { recencyDays: 100, coverage: 1, continuity: 1, form10K: 1 } },
  ];
  const result = pickWinnerAndDetectAmbiguity(candidates, ["TagA", "TagB"]);
  assert.equal(result.confidence, "LOW");
  assert.ok(result.ambiguityNote.includes("TagB"));
});

// ================== Grupo 2: EPS_DILUTED (septimo concepto) ==================

test("G - CANDIDATE_TAGS incluye EPS_DILUTED con EarningsPerShareDiluted como tag preferido", () => {
  assert.ok(CANDIDATE_TAGS.EPS_DILUTED.includes("EarningsPerShareDiluted"));
  assert.ok(CANONICAL_CONCEPTS.includes("EPS_DILUTED"));
});

test("H - EPS_DILUTED resuelve con la MISMA maquinaria anual que REVENUE (extractAnnualPoints + pickWinnerAndDetectAmbiguity), sin logica especial", () => {
  const conceptJson = {
    units: {
      "USD/shares": [
        annualEntry({ start: "2025-01-01", end: "2025-12-31", val: 5.12, fy: 2025 }),
        annualEntry({ start: "2024-01-01", end: "2024-12-31", val: 4.80, fy: 2024 }),
        annualEntry({ start: "2023-01-01", end: "2023-12-31", val: 4.10, fy: 2023 }),
      ],
    },
  };
  const points = extractAnnualPoints(conceptJson, USD_PER_SHARE);
  const candidates = [{ tag: "EarningsPerShareDiluted", points, score: scoreCandidate(points) }];
  const result = pickWinnerAndDetectAmbiguity(candidates, CANDIDATE_TAGS.EPS_DILUTED);
  assert.equal(result.status, "OK");
  assert.equal(result.points[0].value, 5.12);
  assert.equal(result.confidence, "HIGH");
});

test("I - EPS_DILUTED cae a EarningsPerShareBasicAndDiluted cuando el emisor no reporta un tag Diluted separado (estructura de capital simple)", () => {
  const dilutedJson = { units: {} }; // tag principal sin datos -- notFound simulado
  const basicAndDilutedJson = {
    units: { "USD/shares": [annualEntry({ start: "2025-01-01", end: "2025-12-31", val: 2.3, fy: 2025 })] },
  };
  const pointsDiluted = extractAnnualPoints(dilutedJson, USD_PER_SHARE);
  const pointsBasicDiluted = extractAnnualPoints(basicAndDilutedJson, USD_PER_SHARE);
  const candidates = [];
  if (pointsDiluted.length > 0) candidates.push({ tag: "EarningsPerShareDiluted", points: pointsDiluted, score: scoreCandidate(pointsDiluted) });
  if (pointsBasicDiluted.length > 0) candidates.push({ tag: "EarningsPerShareBasicAndDiluted", points: pointsBasicDiluted, score: scoreCandidate(pointsBasicDiluted) });
  const result = pickWinnerAndDetectAmbiguity(candidates, CANDIDATE_TAGS.EPS_DILUTED);
  assert.equal(result.status, "OK");
  assert.equal(result.tag, "EarningsPerShareBasicAndDiluted");
});

test("J - EPS_DILUTED sin ningun tag con datos -> DATA_UNAVAILABLE, igual que cualquier otro concepto anual", () => {
  const result = pickWinnerAndDetectAmbiguity([], CANDIDATE_TAGS.EPS_DILUTED);
  assert.equal(result.status, "DATA_UNAVAILABLE");
});

// ================== Grupo 3: trimestral + TTM EPS ==================

function quarterlyEntry({ end, start, val, form = "10-Q", filed, fy, fp }) {
  return { start, end, val, form, filed: filed || end, fy, fp };
}

test("K - extractQuarterlyPoints: filtra por forma 10-Q y duracion ~90 dias, excluye acumulados YTD de 6/9 meses", () => {
  const conceptJson = {
    units: {
      "USD/shares": [
        quarterlyEntry({ start: "2025-07-01", end: "2025-09-30", val: 1.2 }),   // Q3 real, ~91 dias
        quarterlyEntry({ start: "2025-01-01", end: "2025-09-30", val: 3.5 }),   // acumulado 9 meses -- nunca cuenta como "un trimestre"
        quarterlyEntry({ start: "2025-01-01", end: "2025-12-31", val: 4.8, form: "10-K" }), // anual -- nunca participa aqui
      ],
    },
  };
  const points = extractQuarterlyPoints(conceptJson, USD_PER_SHARE);
  assert.equal(points.length, 1);
  assert.equal(points[0].value, 1.2);
});

test("L - extractQuarterlyPoints: reusa el MISMO JSON que extractAnnualPoints (companyconcept trae ambas duraciones en el mismo array) -- cero llamadas HTTP extra", () => {
  const conceptJson = {
    units: {
      "USD/shares": [
        annualEntry({ start: "2025-01-01", end: "2025-12-31", val: 4.8, fy: 2025 }),
        quarterlyEntry({ start: "2025-10-01", end: "2025-12-31", val: 1.3 }),
      ],
    },
  };
  const annual = extractAnnualPoints(conceptJson, USD_PER_SHARE);
  const quarterly = extractQuarterlyPoints(conceptJson, USD_PER_SHARE);
  assert.equal(annual.length, 1);
  assert.equal(quarterly.length, 1);
});

test("M - computeTtmEps: 4 trimestres reales, consecutivos y validos -> suma real, status OK", () => {
  const quarters = [
    { period_end: "2025-12-31", value: 1.3 },
    { period_end: "2025-09-30", value: 1.2 },
    { period_end: "2025-06-30", value: 1.1 },
    { period_end: "2025-03-31", value: 1.0 },
  ];
  const result = computeTtmEps(quarters);
  assert.equal(result.status, "OK");
  assert.ok(Math.abs(result.ttm_eps - 4.6) < 1e-9);
  assert.equal(result.is_positive, true);
  assert.equal(result.quarters_used.length, 4);
});

test("N - computeTtmEps: menos de 4 trimestres -> INSUFFICIENT_DATA, nunca un TTM parcial presentado como completo", () => {
  const quarters = [
    { period_end: "2025-12-31", value: 1.3 },
    { period_end: "2025-09-30", value: 1.2 },
    { period_end: "2025-06-30", value: 1.1 },
  ];
  const result = computeTtmEps(quarters);
  assert.equal(result.status, "INSUFFICIENT_DATA");
  assert.equal(result.quarters_used.length, 0);
});

test("O - computeTtmEps: hueco entre trimestres fuera de rango (falta un trimestre intermedio) -> INSUFFICIENT_DATA, NUNCA se rellena con un trimestre sintetico", () => {
  const quarters = [
    { period_end: "2025-12-31", value: 1.3 },
    { period_end: "2025-09-30", value: 1.2 },
    { period_end: "2025-03-31", value: 1.0 }, // falta Q2 2025 -- hueco de ~180 dias, no ~90
    { period_end: "2024-12-31", value: 0.9 },
  ];
  const result = computeTtmEps(quarters);
  assert.equal(result.status, "INSUFFICIENT_DATA");
  assert.match(result.reason, /hueco/);
});

test("P - computeTtmEps: TTM negativo (perdida) -> status OK igual, pero is_positive:false -- nunca se oculta una perdida real", () => {
  const quarters = [
    { period_end: "2025-12-31", value: -0.5 },
    { period_end: "2025-09-30", value: -0.3 },
    { period_end: "2025-06-30", value: 0.1 },
    { period_end: "2025-03-31", value: 0.2 },
  ];
  const result = computeTtmEps(quarters);
  assert.equal(result.status, "OK");
  assert.ok(result.ttm_eps < 0);
  assert.equal(result.is_positive, false);
});

test("Q - computeTtmEps: menos de 4 elementos en el array (incluyendo 0/null) -> INSUFFICIENT_DATA sin crashear", () => {
  assert.equal(computeTtmEps([]).status, "INSUFFICIENT_DATA");
  assert.equal(computeTtmEps(null).status, "INSUFFICIENT_DATA");
  assert.equal(computeTtmEps(undefined).status, "INSUFFICIENT_DATA");
});

test("R - computeTtmEps: valor no numerico en alguno de los 4 trimestres -> INSUFFICIENT_DATA, nunca NaN propagado", () => {
  const quarters = [
    { period_end: "2025-12-31", value: 1.3 },
    { period_end: "2025-09-30", value: null },
    { period_end: "2025-06-30", value: 1.1 },
    { period_end: "2025-03-31", value: 1.0 },
  ];
  const result = computeTtmEps(quarters);
  assert.equal(result.status, "INSUFFICIENT_DATA");
});

test("S - confidenceRank: orden real HIGH > MEDIUM > LOW > desconocido, usado por FREE_CASH_FLOW para heredar la confidence mas debil", () => {
  assert.ok(confidenceRank("HIGH") > confidenceRank("MEDIUM"));
  assert.ok(confidenceRank("MEDIUM") > confidenceRank("LOW"));
  assert.equal(confidenceRank("DATA_UNAVAILABLE"), 0);
});

// ================== Grupo 4: bugfix de seleccion de unidad (caso real BE) ==================
// BUGFIX real: Object.keys(units)[0] tomaba la PRIMERA key del objeto
// JSON sin importar si era la unidad correcta -- el orden de keys de un
// objeto NUNCA es un contrato de SEC. Confirmado con evidencia real:
// BE tiene multiples unidades en su companyconcept de
// EarningsPerShareDiluted, "USD/shares" no es la primera -- esto hacia
// que el resolver cayera silenciosamente al tag de fallback
// (EarningsPerShareBasicAndDiluted, con un valor de 2020) en vez de ver
// el valor real de 2025 bajo el tag correcto.

test("T - selectCompatibleUnit: elige la unidad permitida aunque NO sea la primera key del objeto (caso real BE)", () => {
  // Shape real: "USD" (una unidad NO declarada para EPS_DILUTED) aparece
  // ANTES que "USD/shares" en el objeto -- exactamente el patron que
  // rompia Object.keys(units)[0].
  const units = {
    USD: [{ val: 999999 }], // unidad NO compatible con EPS_DILUTED, nunca debe elegirse
    "USD/shares": [{ val: 1.5 }],
  };
  const unitKey = selectCompatibleUnit(units, CONCEPT_UNITS.EPS_DILUTED);
  assert.equal(unitKey, "USD/shares");
});

test("U - selectCompatibleUnit: unidad esperada ausente -> null, NUNCA usa otra unidad en su lugar", () => {
  const units = { USD: [{ val: 1000 }], shares: [{ val: 500 }], pure: [{ val: 1 }] };
  const unitKey = selectCompatibleUnit(units, CONCEPT_UNITS.EPS_DILUTED); // pide "USD/shares", no existe
  assert.equal(unitKey, null);
});

test("V - selectCompatibleUnit: unidad presente pero vacia (array sin elementos) -> null, no se elige una unidad sin datos reales", () => {
  const units = { "USD/shares": [] };
  const unitKey = selectCompatibleUnit(units, CONCEPT_UNITS.EPS_DILUTED);
  assert.equal(unitKey, null);
});

test("W - selectCompatibleUnit: unidad presente pero con forma no-array (el crash real reproducido con BE) -> null, nunca truena", () => {
  const units = { "USD/shares": { unexpected: "shape" } };
  assert.doesNotThrow(() => selectCompatibleUnit(units, CONCEPT_UNITS.EPS_DILUTED));
  assert.equal(selectCompatibleUnit(units, CONCEPT_UNITS.EPS_DILUTED), null);
});

test("X - REGRESION BE: fixture real (USD aparece primero, USD/shares tiene el EPS 2025 real) -- EPS_DILUTED debe resolver el punto reciente, NUNCA caer al fallback de 2020 solo por orden de keys", () => {
  // EarningsPerShareDiluted: shape real de BE -- "USD" primero (no
  // compatible), "USD/shares" con el punto real reciente (FY2025).
  const dilutedJson = {
    units: {
      USD: [annualEntry({ start: "2020-01-01", end: "2020-12-31", val: -50000000, fy: 2020 })], // unidad incorrecta, nunca debe leerse como EPS
      "USD/shares": [annualEntry({ start: "2025-01-01", end: "2025-12-31", val: -0.37, filed: "2026-02-09", fy: 2025 })],
    },
  };
  // EarningsPerShareBasicAndDiluted: solo tiene el valor viejo de 2020.
  const basicAndDilutedJson = {
    units: {
      "USD/shares": [annualEntry({ start: "2020-01-01", end: "2020-12-31", val: -1.14, filed: "2021-02-26", fy: 2020 })],
    },
  };

  const tags = CANDIDATE_TAGS.EPS_DILUTED;
  const allowedUnits = CONCEPT_UNITS.EPS_DILUTED;
  const candidates = [];
  const dilutedPoints = extractAnnualPoints(dilutedJson, allowedUnits);
  if (dilutedPoints.length > 0) candidates.push({ tag: "EarningsPerShareDiluted", points: dilutedPoints, score: scoreCandidate(dilutedPoints) });
  const basicDilutedPoints = extractAnnualPoints(basicAndDilutedJson, allowedUnits);
  if (basicDilutedPoints.length > 0) candidates.push({ tag: "EarningsPerShareBasicAndDiluted", points: basicDilutedPoints, score: scoreCandidate(basicDilutedPoints) });

  const result = pickWinnerAndDetectAmbiguity(candidates, tags);
  assert.equal(result.status, "OK");
  assert.equal(result.tag, "EarningsPerShareDiluted"); // el tag preferido, no el fallback
  assert.equal(result.points[0].value, -0.37); // el punto REAL de 2025, no el de 2020
  assert.equal(result.points[0].fiscal_year, 2025);
});

// ================== Grupo 5: contrato explicito concepto -> unidad (cross-concept) ==================

test("Y - CONCEPT_UNITS declara exactamente una unidad monetaria (USD) para cada concepto contable, y USD/shares SOLO para EPS_DILUTED", () => {
  for (const concept of ["REVENUE", "NET_INCOME", "OPERATING_INCOME", "OPERATING_CASH_FLOW", "CAPEX"]) {
    assert.deepEqual(CONCEPT_UNITS[concept], ["USD"]);
  }
  assert.deepEqual(CONCEPT_UNITS.EPS_DILUTED, ["USD/shares"]);
});

test("Z - orden de keys de `units` nunca importa para NINGUN concepto anual existente (REVENUE ejemplo, unidad no-USD primero)", () => {
  const conceptJson = {
    units: {
      shares: [{ val: 12345 }], // unidad irrelevante que aparece primero -- nunca debe elegirse para REVENUE
      USD: [annualEntry({ start: "2025-01-01", end: "2025-12-31", val: 500000000, fy: 2025 })],
    },
  };
  const points = extractAnnualPoints(conceptJson, CONCEPT_UNITS.REVENUE);
  assert.equal(points.length, 1);
  assert.equal(points[0].value, 500000000);
  assert.equal(points[0].unit, "USD");
});

test("AA - concepto sin ninguna unidad compatible -> DATA_UNAVAILABLE explicito, nunca usa una unidad incompatible en su lugar", () => {
  const conceptJson = { units: { shares: [{ val: 1 }], pure: [{ val: 2 }] } }; // ninguna es "USD"
  const points = extractAnnualPoints(conceptJson, CONCEPT_UNITS.REVENUE);
  assert.equal(points.length, 0);
  const decision = pickWinnerAndDetectAmbiguity([], CANDIDATE_TAGS.REVENUE);
  assert.equal(decision.status, "DATA_UNAVAILABLE");
});
