// lib/materialEventNormalize.js
// Sprint P3.1A (Event Ingestion Foundation). Normalizacion DETERMINISTICA
// de payloads crudos de proveedor a `facts` -- CERO LLM (instruccion
// explicita del sprint: "P3.1A debe evitar LLM si es posible... No usar
// AI para rellenar facts").
//
// Principio central, honesto: solo se puede extraer un campo
// deterministicamente si viene en un CAMPO ESTRUCTURADO del proveedor
// (ej. FMP /earnings trae epsActual como numero real) o si una regla de
// palabras clave clasifica el event_type con confianza razonable desde
// un headline. Para cualquier otra cosa (ej. "deal_value" mencionado en
// prosa dentro de una noticia de texto libre), este modulo NUNCA infiere
// -- devuelve UNKNOWN. Extraer eso de texto libre sin LLM no es
// razonablemente posible con precision aceptable; fingir que si lo es
// seria peor que admitir la limitacion.
//
// `classification_method` en cada resultado declara COMO se clasifico el
// event_type, para que nunca quede ambiguo si un tipo vino de un campo
// duro o de una heuristica de texto:
//   "structured_field"  -- el proveedor ya distingue el tipo (ej.
//                           endpoint /earnings = siempre EARNINGS)
//   "rule_based_keyword" -- coincidencia de palabras clave en headline
//   "unclassified"       -- ninguna regla aplico -> event_type OTHER,
//                           requires_review true (regla dura de la
//                           taxonomy aprobada)

export const EVENT_TYPE = Object.freeze({
  EARNINGS: "EARNINGS",
  GUIDANCE: "GUIDANCE",
  MAJOR_CONTRACT: "MAJOR_CONTRACT",
  CUSTOMER_LOSS: "CUSTOMER_LOSS",
  PRODUCT_LAUNCH: "PRODUCT_LAUNCH",
  M_AND_A: "M_AND_A",
  REGULATORY_LEGAL: "REGULATORY_LEGAL",
  CAPITAL_ALLOCATION: "CAPITAL_ALLOCATION",
  INSIDER_MANAGEMENT: "INSIDER_MANAGEMENT",
  SUPPLY_CHAIN: "SUPPLY_CHAIN",
  MACRO: "MACRO",
  ANALYST: "ANALYST",
  OTHER: "OTHER",
});

export const CLASSIFICATION_METHOD = Object.freeze({
  STRUCTURED_FIELD: "structured_field",
  RULE_BASED_KEYWORD: "rule_based_keyword",
  UNCLASSIFIED: "unclassified",
});

// Facts esperados por event_type -- usado por
// lib/materialEventConfidence.js para DATA_COMPLETENESS (cuantos de
// estos realmente se conocen vs. cuantos deberian existir para este
// tipo). Deliberadamente corto: solo los campos que P3.1A puede llenar
// de verdad hoy, no una lista aspiracional.
export const EXPECTED_FACT_KEYS = Object.freeze({
  [EVENT_TYPE.EARNINGS]: ["revenue_actual", "eps_actual", "revenue_estimated", "eps_estimated"],
  [EVENT_TYPE.GUIDANCE]: ["guidance_previous", "guidance_new"],
  [EVENT_TYPE.MAJOR_CONTRACT]: ["counterparty", "deal_value", "effective_date"],
  [EVENT_TYPE.CUSTOMER_LOSS]: ["counterparty", "effective_date"],
  [EVENT_TYPE.CAPITAL_ALLOCATION]: ["capital_allocation_type", "capex_value", "dilution_pct"],
  [EVENT_TYPE.ANALYST]: ["analyst_firm", "price_target_new", "price_target_previous", "rating_new"],
  [EVENT_TYPE.OTHER]: [],
});

function expectedKeysFor(eventType) {
  return EXPECTED_FACT_KEYS[eventType] || ["headline"];
}

function countKnown(facts, expectedKeys) {
  return expectedKeys.filter((k) => facts[k] != null && facts[k] !== "UNKNOWN").length;
}

// ================== FMP: /earnings (estructurado) ==================
// Forma documentada por FMP (no verificada en vivo esta sesion -- ver
// Sprint P3.1A Provider Fact-Check en el reporte del sprint): { symbol,
// date, epsActual, epsEstimated, revenueActual, revenueEstimated,
// fiscalDateEnding }.
export function normalizeFmpEarnings(raw, { asset_id, ticker }) {
  const facts = {
    revenue_actual: typeof raw.revenueActual === "number" ? raw.revenueActual : "UNKNOWN",
    revenue_estimated: typeof raw.revenueEstimated === "number" ? raw.revenueEstimated : "UNKNOWN",
    eps_actual: typeof raw.epsActual === "number" ? raw.epsActual : "UNKNOWN",
    eps_estimated: typeof raw.epsEstimated === "number" ? raw.epsEstimated : "UNKNOWN",
    fiscal_date_ending: raw.fiscalDateEnding || "UNKNOWN",
  };
  return {
    asset_id, ticker,
    event_type: EVENT_TYPE.EARNINGS,
    classification_method: CLASSIFICATION_METHOD.STRUCTURED_FIELD,
    headline: `Earnings ${ticker}: EPS ${facts.eps_actual !== "UNKNOWN" ? facts.eps_actual : "?"} vs. est. ${facts.eps_estimated !== "UNKNOWN" ? facts.eps_estimated : "?"}`,
    occurred_at: raw.date || null,
    published_at: raw.date || null,
    facts,
    known_fact_count: countKnown(facts, expectedKeysFor(EVENT_TYPE.EARNINGS)),
    expected_fact_keys: expectedKeysFor(EVENT_TYPE.EARNINGS),
  };
}

// ================== FMP: /price-target-consensus (estructurado) ==================
export function normalizeFmpPriceTarget(raw, { asset_id, ticker }) {
  const facts = {
    analyst_firm: "consensus",
    price_target_new: typeof raw.targetConsensus === "number" ? raw.targetConsensus : "UNKNOWN",
    price_target_previous: "UNKNOWN", // el endpoint consensus no trae el valor anterior -- nunca inferido
    rating_new: "UNKNOWN",
  };
  return {
    asset_id, ticker,
    event_type: EVENT_TYPE.ANALYST,
    classification_method: CLASSIFICATION_METHOD.STRUCTURED_FIELD,
    headline: `Price target consensus ${ticker}: ${facts.price_target_new}`,
    occurred_at: null, // un consensus no tiene "occurred_at" real -- se resuelve via fallback (lib/materialEventTemporal.js)
    published_at: null,
    facts,
    known_fact_count: countKnown(facts, expectedKeysFor(EVENT_TYPE.ANALYST)),
    expected_fact_keys: expectedKeysFor(EVENT_TYPE.ANALYST),
  };
}

// ================== Clasificacion por palabras clave (texto libre) ==================
// Usado para noticias de texto libre (FMP news/stock, Finnhub
// company-news) donde el proveedor NO distingue el tipo de evento.
// Cada regla es una lista de substrings (case-insensitive) -- la PRIMERA
// que matchea gana. Deliberadamente conservador: ante duda, OTHER.
const KEYWORD_RULES = [
  { type: EVENT_TYPE.M_AND_A, keywords: ["acquire", "acquisition", "merger", "to be acquired", "buyout"] },
  { type: EVENT_TYPE.GUIDANCE, keywords: ["guidance", "raises outlook", "cuts outlook", "withdraws guidance", "forecast"] },
  { type: EVENT_TYPE.CUSTOMER_LOSS, keywords: ["loses contract", "contract termination", "non-renewal", "customer loss"] },
  { type: EVENT_TYPE.MAJOR_CONTRACT, keywords: ["signs agreement", "announces partnership", "new contract", "deal with", "strategic agreement"] },
  { type: EVENT_TYPE.PRODUCT_LAUNCH, keywords: ["launches", "unveils", "introduces new"] },
  { type: EVENT_TYPE.REGULATORY_LEGAL, keywords: ["lawsuit", "antitrust", "investigation", "regulatory approval", "sec charges", "sues"] },
  { type: EVENT_TYPE.CAPITAL_ALLOCATION, keywords: ["share buyback", "dividend", "secondary offering", "debt offering", "capex"] },
  { type: EVENT_TYPE.INSIDER_MANAGEMENT, keywords: ["ceo departure", "appoints ceo", "cfo resigns", "insider buying", "insider selling", "names new ceo"] },
  { type: EVENT_TYPE.SUPPLY_CHAIN, keywords: ["supply chain", "chip shortage", "supplier", "manufacturing disruption"] },
];

export function classifyByKeywords(headline) {
  const lower = (headline || "").toLowerCase();
  for (const rule of KEYWORD_RULES) {
    if (rule.keywords.some((kw) => lower.includes(kw))) {
      return { event_type: rule.type, classification_method: CLASSIFICATION_METHOD.RULE_BASED_KEYWORD };
    }
  }
  return { event_type: EVENT_TYPE.OTHER, classification_method: CLASSIFICATION_METHOD.UNCLASSIFIED };
}

// ================== FMP/Finnhub: noticia de texto libre ==================
// Forma generica esperada (FMP news/stock documentado: { symbol, publishedDate,
// title, image, site, text, url }). Nunca extrae deal_value/counterparty
// de `text` -- eso requeriria NLP/LLM, fuera de alcance P3.1A. Solo
// clasifica event_type por palabras clave y preserva headline/url/fecha
// como facts minimos verificables.
export function normalizeNewsArticle(raw, { asset_id, ticker, provider }) {
  const headline = raw.title || raw.headline || "";
  const { event_type, classification_method } = classifyByKeywords(headline);
  const requiresReview = event_type === EVENT_TYPE.OTHER;

  const facts = { headline_raw: headline, source_url: raw.url || "UNKNOWN" };
  const expected = expectedKeysFor(event_type);

  return {
    asset_id, ticker,
    event_type,
    classification_method,
    headline,
    occurred_at: null, // texto libre rara vez declara occurred_at real distinto de published_at
    published_at: raw.publishedDate || raw.datetime || null,
    facts,
    known_fact_count: countKnown(facts, expected),
    expected_fact_keys: expected,
    requires_review: requiresReview,
    provider,
    source_url: raw.url || null,
  };
}

// ================== Finnhub: /company-news (texto libre) ==================
// Sprint P3.1A.2. Forma real de Finnhub /company-news (confirmada contra
// la API real, no solo documentacion -- ver
// docs/intelligence/P3.1A.2-FINNHUB-DISCOVERY-BENCHMARK.md):
// { category, datetime (unix SECONDS, no ms, no ISO), headline, id,
//   image, related, source, summary, url }.
//
// Distinta de normalizeNewsArticle() a proposito: esa funcion espera
// publishedDate/datetime como string/ISO (forma de FMP); Finnhub manda
// datetime como numero de segundos unix -- reusar la generica sin
// conversion habria producido un published_at corrupto (new
// Date(numero_pequeno) cae en 1970, no en la fecha real). Mismo
// principio de siempre: nunca inventar/forzar un campo a una forma que
// no tiene.
//
// `source` (Finnhub) es el nombre del OUTLET/publisher (ej. "Yahoo",
// "Reuters") -- se captura como `facts.publisher` para calidad de
// provenance, pero NUNCA se usa como attributed_wire: un publisher no
// es lo mismo que un servicio de wire syndication, y el sprint exige
// explicitamente no inferir attributed_wire sin evidencia real de que
// varios outlets republican la MISMA nota de un wire. attributed_wire
// queda null (UNKNOWN) para toda noticia de Finnhub hasta que exista
// una señal real de eso.
export function normalizeFinnhubNews(raw, { asset_id, ticker }) {
  const headline = raw.headline || "";
  const { event_type, classification_method } = classifyByKeywords(headline);
  const requiresReview = event_type === EVENT_TYPE.OTHER;

  const publishedAt = typeof raw.datetime === "number" && raw.datetime > 0
    ? new Date(raw.datetime * 1000).toISOString()
    : null;

  const facts = {
    headline_raw: headline,
    source_url: raw.url || "UNKNOWN",
    publisher: raw.source || "UNKNOWN",
    finnhub_id: typeof raw.id === "number" ? raw.id : "UNKNOWN",
  };
  const expected = expectedKeysFor(event_type);

  return {
    asset_id, ticker,
    event_type,
    classification_method,
    headline,
    occurred_at: null, // Finnhub no distingue occurred_at de published_at
    published_at: publishedAt,
    facts,
    known_fact_count: countKnown(facts, expected),
    expected_fact_keys: expected,
    requires_review: requiresReview,
    provider: "finnhub",
    source_url: raw.url || null,
    attributed_wire: null, // nunca inferido -- ver comentario arriba
  };
}

// ================== SEC EDGAR: filing (submissions feed) ==================
// La forma basica de data.sec.gov/submissions/CIK{cik}.json solo trae
// {form, filingDate, accessionNumber} -- SIN el numero de Item (1.01,
// 5.02, etc.). Sin el Item, un 8-K generico NO se puede clasificar de
// forma determinista y honesta en uno de los 13 tipos -- se declara
// OTHER + requires_review, nunca se adivina. Si en una fase futura se
// integra un feed que SI trae el Item (ej. SEC full-text search con
// metadata de item), este normalizador se extiende, no se reemplaza.
export function normalizeSecFiling(raw, { asset_id, ticker }) {
  const facts = { form: raw.form || "UNKNOWN", accession_number: raw.accessionNumber || "UNKNOWN" };
  return {
    asset_id, ticker,
    event_type: EVENT_TYPE.OTHER,
    classification_method: CLASSIFICATION_METHOD.UNCLASSIFIED,
    headline: `SEC filing ${raw.form || "?"} -- ${ticker}`,
    occurred_at: raw.filingDate || null,
    published_at: raw.filingDate || null,
    facts,
    known_fact_count: countKnown(facts, []),
    expected_fact_keys: [],
    requires_review: true,
    provider: "sec_edgar",
    source_url: raw.accessionNumber
      ? `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&accession_number=${raw.accessionNumber}`
      : null,
  };
}
