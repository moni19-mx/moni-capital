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
  CANDIDATE_TAGS, CANONICAL_CONCEPTS,
  extractAnnualPoints, scoreCandidate, computeConfidence, confidenceRank,
  pickWinnerAndDetectAmbiguity, extractQuarterlyPoints, computeTtmEps,
} from "../lib/secFinancialsResolver.js";

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
  const points = extractAnnualPoints(conceptJson);
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
  const points = extractAnnualPoints(conceptJson);
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
  const points = extractAnnualPoints(conceptJson);
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
  const pointsDiluted = extractAnnualPoints(dilutedJson);
  const pointsBasicDiluted = extractAnnualPoints(basicAndDilutedJson);
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
  const points = extractQuarterlyPoints(conceptJson);
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
  const annual = extractAnnualPoints(conceptJson);
  const quarterly = extractQuarterlyPoints(conceptJson);
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
