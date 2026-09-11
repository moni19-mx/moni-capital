import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeFmpEarnings, normalizeFmpPriceTarget, normalizeNewsArticle, normalizeSecFiling,
  normalizeFinnhubNews, normalizeFinnhubEarnings, classifyByKeywords, EVENT_TYPE, CLASSIFICATION_METHOD,
} from "../lib/materialEventNormalize.js";

// A. source válido → event normalizado
test("A - FMP earnings valido se normaliza con event_type EARNINGS y classification_method structured_field", () => {
  const raw = { symbol: "QCOM", date: "2026-08-01", epsActual: 2.62, epsEstimated: 2.51, revenueActual: 10371000000, revenueEstimated: 10100000000, fiscalDateEnding: "2026-06-30" };
  const r = normalizeFmpEarnings(raw, { asset_id: 42, ticker: "QCOM" });
  assert.equal(r.event_type, EVENT_TYPE.EARNINGS);
  assert.equal(r.classification_method, CLASSIFICATION_METHOD.STRUCTURED_FIELD);
  assert.equal(r.facts.eps_actual, 2.62);
  assert.equal(r.facts.revenue_actual, 10371000000);
  assert.equal(r.occurred_at, "2026-08-01");
});

test("A - news article con keyword de M&A se clasifica correctamente", () => {
  const raw = { title: "Company X to acquire Company Y for $2B", publishedDate: "2026-08-01T10:00:00Z", url: "https://example.com/a" };
  const r = normalizeNewsArticle(raw, { asset_id: 1, ticker: "XYZ", provider: "fmp" });
  assert.equal(r.event_type, EVENT_TYPE.M_AND_A);
  assert.equal(r.classification_method, CLASSIFICATION_METHOD.RULE_BASED_KEYWORD);
  assert.equal(r.requires_review, false);
});

// B. unknown field → null/UNKNOWN, nunca inventado
test("B - FMP earnings con epsActual faltante queda UNKNOWN, nunca inventado como 0", () => {
  const raw = { symbol: "QCOM", date: "2026-08-01", epsEstimated: 2.51, revenueEstimated: 10100000000 };
  const r = normalizeFmpEarnings(raw, { asset_id: 42, ticker: "QCOM" });
  assert.equal(r.facts.eps_actual, "UNKNOWN");
  assert.equal(r.facts.revenue_actual, "UNKNOWN");
  assert.notEqual(r.facts.eps_actual, 0);
});

test("B - noticia de texto libre nunca inventa deal_value/counterparty desde prosa", () => {
  const raw = { title: "Company X signs agreement with Amazon for AI data centers", publishedDate: "2026-08-01T10:00:00Z", url: "https://example.com/b" };
  const r = normalizeNewsArticle(raw, { asset_id: 1, ticker: "QCOM", provider: "fmp" });
  assert.equal(r.event_type, EVENT_TYPE.MAJOR_CONTRACT);
  assert.ok(!("deal_value" in r.facts), "no debe inventar deal_value desde texto libre");
  assert.ok(!("counterparty" in r.facts), "no debe inventar counterparty desde texto libre");
});

test("B - SEC filing sin item code queda OTHER + requires_review, nunca adivinado", () => {
  const raw = { form: "8-K", filingDate: "2026-08-01", accessionNumber: "0000804328-26-000123" };
  const r = normalizeSecFiling(raw, { asset_id: 42, ticker: "QCOM" });
  assert.equal(r.event_type, EVENT_TYPE.OTHER);
  assert.equal(r.classification_method, CLASSIFICATION_METHOD.UNCLASSIFIED);
  assert.equal(r.requires_review, true);
  assert.equal(r.facts.form, "8-K");
});

test("B - clasificacion por keywords sin match cae en OTHER + unclassified, nunca un tipo forzado", () => {
  const r = classifyByKeywords("Company X reports quarterly community newsletter update");
  assert.equal(r.event_type, EVENT_TYPE.OTHER);
  assert.equal(r.classification_method, CLASSIFICATION_METHOD.UNCLASSIFIED);
});

test("price target consensus: previous target siempre UNKNOWN (el endpoint no lo trae) -- nunca inferido", () => {
  const raw = { symbol: "QCOM", targetConsensus: 195.5 };
  const r = normalizeFmpPriceTarget(raw, { asset_id: 42, ticker: "QCOM" });
  assert.equal(r.facts.price_target_new, 195.5);
  assert.equal(r.facts.price_target_previous, "UNKNOWN");
  assert.equal(r.event_type, EVENT_TYPE.ANALYST);
});

// M. fallo parcial provider → no corrupción
test("M - payload de proveedor con campos numericos corruptos (string en vez de number) nunca se cuela como valor financiero -- queda UNKNOWN", () => {
  const raw = { symbol: "QCOM", date: "2026-08-01", epsActual: "N/A", revenueActual: null };
  const r = normalizeFmpEarnings(raw, { asset_id: 29, ticker: "QCOM" });
  assert.equal(r.facts.eps_actual, "UNKNOWN");
  assert.equal(r.facts.revenue_actual, "UNKNOWN");
});

test("M - payload completamente vacio ({}) nunca se normaliza como un evento con datos falsos -- todo UNKNOWN, cero facts inventados", () => {
  const r = normalizeFmpEarnings({}, { asset_id: 29, ticker: "QCOM" });
  assert.equal(r.facts.eps_actual, "UNKNOWN");
  assert.equal(r.facts.revenue_actual, "UNKNOWN");
  assert.equal(r.facts.eps_estimated, "UNKNOWN");
  assert.equal(r.occurred_at, null);
  assert.equal(r.known_fact_count, 0);
});

test("M - noticia sin title/headline nunca se clasifica con falsa confianza -- headline vacio cae en OTHER/unclassified", () => {
  const r = normalizeNewsArticle({ publishedDate: "2026-08-01T10:00:00Z" }, { asset_id: 29, ticker: "QCOM", provider: "fmp" });
  assert.equal(r.event_type, EVENT_TYPE.OTHER);
  assert.equal(r.requires_review, true);
});

// Sprint P3.1A.2 -- normalizeFinnhubNews, forma real confirmada de
// Finnhub /company-news (datetime en SEGUNDOS unix, no ms, no ISO)
test("Finnhub: datetime en segundos unix se convierte correctamente a ISO, nunca cae en 1970", () => {
  const raw = { headline: "Company X launches new product line", datetime: 1735689600, source: "Reuters", url: "https://example.com/n1", id: 999, category: "company" };
  const r = normalizeFinnhubNews(raw, { asset_id: 29, ticker: "QCOM" });
  assert.equal(r.published_at, "2025-01-01T00:00:00.000Z");
  assert.notEqual(new Date(r.published_at).getFullYear(), 1970);
});

test("Finnhub: publisher se captura en facts, attributed_wire NUNCA se infiere del publisher", () => {
  const raw = { headline: "Company X signs agreement with a customer", datetime: 1735689600, source: "Yahoo", url: "https://example.com/n2" };
  const r = normalizeFinnhubNews(raw, { asset_id: 29, ticker: "QCOM" });
  assert.equal(r.facts.publisher, "Yahoo");
  assert.equal(r.attributed_wire, null);
});

test("Finnhub: datetime ausente o no numerico -> published_at null, nunca inventado", () => {
  const r1 = normalizeFinnhubNews({ headline: "x", source: "Yahoo" }, { asset_id: 29, ticker: "QCOM" });
  assert.equal(r1.published_at, null);
  const r2 = normalizeFinnhubNews({ headline: "x", datetime: "not-a-number", source: "Yahoo" }, { asset_id: 29, ticker: "QCOM" });
  assert.equal(r2.published_at, null);
});

test("Finnhub: provider siempre 'finnhub', nunca heredado de otro lado", () => {
  const r = normalizeFinnhubNews({ headline: "x", datetime: 1735689600 }, { asset_id: 29, ticker: "QCOM" });
  assert.equal(r.provider, "finnhub");
});

test("Finnhub: clasificacion por keywords funciona igual que para FMP (misma funcion compartida)", () => {
  const r = normalizeFinnhubNews({ headline: "Qualcomm announces partnership with Amazon for AI data centers", datetime: 1735689600 }, { asset_id: 29, ticker: "QCOM" });
  assert.equal(r.event_type, EVENT_TYPE.MAJOR_CONTRACT);
  assert.equal(r.classification_method, CLASSIFICATION_METHOD.RULE_BASED_KEYWORD);
});

// P3.1B.1 -- Finnhub /stock/earnings (estructurado, EARNINGS real via
// endpoint dedicado, no FMP que ya se confirmo PLAN_BLOCKED en P3.1A.1).
test("Finnhub earnings valido se normaliza con event_type EARNINGS, classification_method structured_field, eps real", () => {
  const raw = { symbol: "QCOM", period: "2026-06-30", year: 2026, quarter: 3, actual: 2.62, estimate: 2.51, surprise: 0.11, surprisePercent: 4.38 };
  const r = normalizeFinnhubEarnings(raw, { asset_id: 29, ticker: "QCOM" });
  assert.equal(r.event_type, EVENT_TYPE.EARNINGS);
  assert.equal(r.classification_method, CLASSIFICATION_METHOD.STRUCTURED_FIELD);
  assert.equal(r.facts.eps_actual, 2.62);
  assert.equal(r.facts.eps_estimated, 2.51);
  assert.equal(r.facts.earnings_date, "2026-06-30");
  assert.equal(r.occurred_at, "2026-06-30");
});

test("Finnhub earnings: revenue_actual/estimated SIEMPRE UNKNOWN (el endpoint no los trae) -- nunca inventados", () => {
  const raw = { symbol: "QCOM", period: "2026-06-30", year: 2026, quarter: 3, actual: 2.62, estimate: 2.51 };
  const r = normalizeFinnhubEarnings(raw, { asset_id: 29, ticker: "QCOM" });
  assert.equal(r.facts.revenue_actual, "UNKNOWN");
  assert.equal(r.facts.revenue_estimated, "UNKNOWN");
});

test("Finnhub earnings: actual/estimate ausentes o no numericos -> UNKNOWN, nunca 0 ni null silencioso", () => {
  const raw = { symbol: "QCOM", period: "2026-06-30", year: 2026, quarter: 3, actual: null, estimate: null };
  const r = normalizeFinnhubEarnings(raw, { asset_id: 29, ticker: "QCOM" });
  assert.equal(r.facts.eps_actual, "UNKNOWN");
  assert.equal(r.facts.eps_estimated, "UNKNOWN");
});

test("todos los 13 tipos de la taxonomia aprobada existen y ninguno adicional se coló", () => {
  const approved = [
    "EARNINGS", "GUIDANCE", "MAJOR_CONTRACT", "CUSTOMER_LOSS", "PRODUCT_LAUNCH", "M_AND_A",
    "REGULATORY_LEGAL", "CAPITAL_ALLOCATION", "INSIDER_MANAGEMENT", "SUPPLY_CHAIN", "MACRO", "ANALYST", "OTHER",
  ];
  assert.deepEqual(Object.keys(EVENT_TYPE).sort(), approved.sort());
});
