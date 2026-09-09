// lib/materialityEngine.js
// Sprint P3.1B (Materiality Engine), corregido en P3.1B.2 (Materiality
// Calibration Fix) con evidencia real de P3.1B.1. Componentes
// deterministicos -- CERO LLM, CERO red, CERO Supabase. Cada funcion
// recibe datos ya resueltos (facts del evento, contexto de
// negocio/portfolio) y devuelve {value: 0-100 | "UNKNOWN", method,
// ...detalle}. Nunca inventa un monto desde lenguaje
// ("major"/"huge"/"significant") -- solo desde campos numericos reales.
//
// Los multiplicadores usados para mapear un ratio real (ej.
// deal_value/revenue) a una escala 0-100 son deliberadamente simples y
// declarados como tuneables -- no son una calibracion empirica, son un
// punto de partida razonable y explicable, igual que los pesos de
// DETERMINISTIC_WEIGHTS (scoring_policy_version los versiona a todos
// juntos).

import { tierScore } from "./materialEventSources.js";
import { DETERMINISTIC_WEIGHTS } from "./materialEventVersioning.js";
import { tagsFromFields } from "./canonicalThemeTags.js";

export const UNKNOWN = "UNKNOWN";

function isNum(v) {
  return typeof v === "number" && !Number.isNaN(v);
}
function clamp0to100(v) {
  return Math.max(0, Math.min(100, Math.round(v)));
}
function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ================== FINANCIAL_SCALE (event-type-aware) ==================
export function computeFinancialScale(eventType, facts, context) {
  facts = facts || {};
  context = context || {};

  switch (eventType) {
    case "MAJOR_CONTRACT":
    case "CUSTOMER_LOSS": {
      const dealValue = isNum(facts.deal_value) ? facts.deal_value : null;
      const revenue = isNum(context.trailing_annual_revenue) ? context.trailing_annual_revenue : null;
      if (dealValue == null || revenue == null || revenue <= 0) {
        return { value: UNKNOWN, method: "contract_value_to_revenue", inputs_missing: [dealValue == null ? "deal_value" : null, revenue == null ? "trailing_annual_revenue" : null].filter(Boolean) };
      }
      return { value: clamp0to100((dealValue / revenue) * 500), method: "contract_value_to_revenue", ratio: dealValue / revenue };
    }
    case "CAPITAL_ALLOCATION": {
      const dilution = isNum(facts.dilution_pct) ? facts.dilution_pct : null;
      const capex = isNum(facts.capex_value) ? facts.capex_value : null;
      const marketCap = isNum(context.market_cap) ? context.market_cap : null;
      if (dilution != null) return { value: clamp0to100(dilution * 1000), method: "dilution_pct" };
      if (capex != null && marketCap != null && marketCap > 0) return { value: clamp0to100((capex / marketCap) * 500), method: "capex_to_market_cap" };
      return { value: UNKNOWN, method: "capital_allocation_scale", inputs_missing: ["dilution_pct_or_(capex_value_and_market_cap)"] };
    }
    case "EARNINGS": {
      const actual = isNum(facts.eps_actual) ? facts.eps_actual : null;
      const estimated = isNum(facts.eps_estimated) ? facts.eps_estimated : null;
      if (actual == null || estimated == null || estimated === 0) {
        return { value: UNKNOWN, method: "earnings_surprise_pct", inputs_missing: [actual == null ? "eps_actual" : null, estimated == null ? "eps_estimated" : null].filter(Boolean) };
      }
      const surprisePct = Math.abs((actual - estimated) / Math.abs(estimated));
      return { value: clamp0to100(surprisePct * 400), method: "earnings_surprise_pct", surprisePct };
    }
    case "GUIDANCE": {
      const prev = isNum(facts.guidance_previous) ? facts.guidance_previous : null;
      const next = isNum(facts.guidance_new) ? facts.guidance_new : null;
      if (prev == null || next == null || prev === 0) {
        return { value: UNKNOWN, method: "guidance_delta_pct", inputs_missing: [prev == null ? "guidance_previous" : null, next == null ? "guidance_new" : null].filter(Boolean) };
      }
      const deltaPct = Math.abs((next - prev) / Math.abs(prev));
      return { value: clamp0to100(deltaPct * 500), method: "guidance_delta_pct", deltaPct };
    }
    case "M_AND_A": {
      const txValue = isNum(facts.deal_value) ? facts.deal_value : null;
      const marketCap = isNum(context.market_cap) ? context.market_cap : null;
      if (txValue == null || marketCap == null || marketCap <= 0) {
        return { value: UNKNOWN, method: "transaction_value_to_market_cap", inputs_missing: [txValue == null ? "deal_value" : null, marketCap == null ? "market_cap" : null].filter(Boolean) };
      }
      return { value: clamp0to100((txValue / marketCap) * 300), method: "transaction_value_to_market_cap" };
    }
    default:
      // OTHER, ANALYST, INSIDER_MANAGEMENT,
      // SUPPLY_CHAIN, MACRO, REGULATORY_LEGAL, PRODUCT_LAUNCH: sin formula
      // deterministica de escala financiera definida todavia -- UNKNOWN
      // honesto, nunca 0.
      return { value: UNKNOWN, method: "no_deterministic_formula_for_event_type", inputs_missing: ["event_type_specific_facts"] };
  }
}

// ================== STRATEGIC_RELEVANCE (COMPANY, no portfolio) ==================
// Sprint P3.1B.2: corrige la contaminacion real encontrada en P3.1B.1
// (Regla 11 del reporte) -- `isActivePosition`/`conviction` (¿YO tengo
// esta posicion?) sumaban puntos aqui, mezclando company materiality
// con portfolio relevance. Esas dos dimensiones ya existian separadas
// por diseño (classifyPortfolioRelevance() abajo), pero esta funcion
// las estaba recontaminando por dentro. Ahora SOLO usa clasificacion de
// NEGOCIO (tema/sector/strategic_role -- de que trata la empresa) y
// contenido real del evento (overlap de tags canonicos con el
// headline) -- nunca si el usuario la posee o cuanta conviction tiene.
export function computeStrategicRelevance(facts, companyContext) {
  facts = facts || {};
  companyContext = companyContext || {};
  const { tema, sector, strategic_role: strategicRole } = companyContext;

  if (!tema && !sector && !strategicRole) {
    return { value: UNKNOWN, method: "no_company_classification", inputs_missing: ["company_classification"] };
  }

  let value = 0;
  const evidence = [];
  const classification = tema || sector || strategicRole;
  if (classification && classification !== "Sin clasificar") { value += 40; evidence.push(`classified_as(${classification})`); }

  // Bug de idioma corregido en P3.1B.1: ambos lados se normalizan
  // PRIMERO a tags canonicos independientes de idioma
  // (lib/canonicalThemeTags.js) y se comparan como sets, nunca como
  // texto -- nunca traduccion automatica.
  const companyTags = tagsFromFields(tema, sector, strategicRole);
  const eventTags = tagsFromFields(facts.headline_raw);
  const overlapTags = companyTags.filter((t) => eventTags.includes(t));
  if (overlapTags.length > 0) { value += 60; evidence.push(`canonical_tag_overlap(${overlapTags.join(",")})`); }

  return {
    value: clamp0to100(value), method: "company_classification_and_headline_canonical_tag_overlap", evidence,
    company_tags: companyTags, event_tags: eventTags,
  };
}

// ================== TIMELINE_URGENCY (rediseñado en P3.1B.2) ==================
// Distinto de freshness (que es sobre cuando se DESCUBRIO/PUBLICO el
// hecho -- lib/materialEventTemporal.js) -- esto es sobre que tan
// inmediato es el impacto/decision relacionado con la fecha relevante
// del evento, evaluado AHORA.
//
// Bug real corregido (P3.1B.1, Regla 7/9 del reporte de validacion):
// el bucket "ya ocurrio o esta vigente" devolvia 100 sin importar
// cuanto tiempo habia pasado -- un earnings de ayer y uno de hace 250
// dias recibian exactamente la misma urgencia maxima. Confirmado con
// datos reales: 3 eventos EARNINGS (71/162/252 dias en el pasado)
// puntuaban los 3 con TIMELINE_URGENCY=100.
//
// Dos formas, elegidas por event_type -- no una ontologia grande, solo
// las dos formas que la evidencia real exige distinguir:
//
// - "disclosure decay" (EARNINGS, GUIDANCE): el hecho relevante YA
//   ocurrio por definicion (es una publicacion, no una fecha futura
//   pendiente) -- la urgencia PARA UNA DECISION AHORA decae con los
//   dias transcurridos desde la publicacion/vigencia. Una fecha en el
//   futuro para estos tipos (ej. earnings ya calendarizados pero aun
//   no reportados) se trata como "por venir", moderadamente urgente.
//
// - "deadline proximity" (MAJOR_CONTRACT, CUSTOMER_LOSS,
//   CAPITAL_ALLOCATION, REGULATORY_LEGAL, y default para el resto de
//   tipos): la urgencia es maxima cerca de la fecha (por venir o recien
//   cruzada) y decae SIMETRICAMENTE en ambas direcciones -- un
//   contrato que arranca en 18 meses y uno que vencio hace 18 meses
//   son, por igual, poco urgentes para una decision hoy.
const DISCLOSURE_DECAY_TYPES = new Set(["EARNINGS", "GUIDANCE"]);

function relevantDateFromFacts(facts) {
  return facts.effective_date || facts.contract_start || facts.earnings_date || facts.regulatory_deadline || null;
}

function urgencyFromDisclosureDecay(daysSincePublished) {
  if (daysSincePublished < 0) return { value: 70, bucket: "UPCOMING_DISCLOSURE" };
  if (daysSincePublished <= 7) return { value: 90, bucket: "RECENT_DISCLOSURE" };
  if (daysSincePublished <= 30) return { value: 60, bucket: "NEAR_TERM_DISCLOSURE" };
  if (daysSincePublished <= 90) return { value: 30, bucket: "MEDIUM_TERM_DISCLOSURE" };
  return { value: 15, bucket: "STALE_DISCLOSURE" };
}

function urgencyFromDeadlineProximity(daysUntil) {
  const abs = Math.abs(daysUntil);
  if (abs <= 7) return { value: 95, bucket: daysUntil >= 0 ? "IMMINENT" : "JUST_CROSSED" };
  if (abs <= 30) return { value: 75, bucket: daysUntil >= 0 ? "NEAR_TERM" : "RECENT_PAST" };
  if (abs <= 180) return { value: 45, bucket: daysUntil >= 0 ? "MEDIUM_TERM" : "PAST_RECENT" };
  return { value: 20, bucket: daysUntil >= 0 ? "DISTANT_FUTURE" : "PAST_OLD" };
}

export function computeTimelineUrgency(eventType, facts, now) {
  facts = facts || {};
  const relevantDate = relevantDateFromFacts(facts);
  if (!relevantDate) {
    return { value: UNKNOWN, method: "no_relevant_date_in_facts", inputs_missing: ["effective_date_or_equivalent"] };
  }
  const daysUntil = (new Date(relevantDate).getTime() - new Date(now).getTime()) / 86400000;

  if (DISCLOSURE_DECAY_TYPES.has(eventType)) {
    const daysSincePublished = -daysUntil;
    const { value, bucket } = urgencyFromDisclosureDecay(daysSincePublished);
    return { value, method: "disclosure_decay", bucket, days_since_published: Math.round(daysSincePublished) };
  }

  const { value, bucket } = urgencyFromDeadlineProximity(daysUntil);
  return { value, method: "deadline_proximity", bucket, days_until: Math.round(daysUntil) };
}

// ================== SOURCE_STRENGTH ==================
// Reusa tierScore() de lib/materialEventSources.js -- una sola tabla
// tier->score, nunca duplicada.
export function computeSourceStrength(primaryEvidenceTier) {
  if (primaryEvidenceTier == null) return { value: UNKNOWN, method: "no_primary_source" };
  return { value: tierScore(primaryEvidenceTier), method: "primary_evidence_tier", tier: primaryEvidenceTier };
}

// ================== ENTITY_RELEVANCE (nuevo en P3.1B.2) ==================
// Defensa determinista contra ticker noise del proveedor -- hallazgo
// real de P3.1B.1: Finnhub etiqueto un articulo sobre Super Micro
// Computer con `related: "AMD"` aunque el texto no menciona a AMD en
// absoluto. Chequeo puro de texto (CERO AI, tal como pide el sprint):
// ¿aparece el ticker o el nombre real de la empresa en el headline?
// Eventos sin headline de texto libre (ej. EARNINGS estructurado, el
// ticker viene del propio endpoint del proveedor, no de una etiqueta
// de relacion) no tienen este riesgo -- HIGH por construccion.
const CORP_SUFFIXES = new Set(["inc", "incorporated", "corp", "corporation", "ltd", "llc", "co", "company", "holdings", "plc", "group"]);

// Frase completa del nombre (SIN el sufijo corporativo), nunca palabras
// individuales sueltas -- una palabra generica dentro del nombre legal
// (ej. "Micro" en "Advanced Micro Devices") aparece con frecuencia en
// nombres de OTRAS empresas ("Super Micro Computer") y produciria un
// falso match si se comparara palabra por palabra. La frase completa
// evita esa colision.
function stripCorpSuffix(name) {
  return String(name)
    .replace(/[.,]/g, "")
    .split(/\s+/)
    .filter((w) => !CORP_SUFFIXES.has(w.toLowerCase()))
    .join(" ")
    .trim();
}

function containsWholeWord(text, phrase) {
  return new RegExp(`\\b${escapeRegex(phrase)}\\b`, "i").test(text);
}

export function computeEntityRelevance(ticker, companyName, facts) {
  facts = facts || {};
  const headline = facts.headline_raw;
  if (!headline) {
    return { level: "HIGH", reason: "structured_source_no_headline_ambiguity" };
  }
  const strippedName = companyName ? stripCorpSuffix(companyName) : null;
  const tickerMatch = !!ticker && containsWholeWord(headline, ticker);
  const nameMatch = !!strippedName && strippedName.length >= 4 && containsWholeWord(headline, strippedName);
  if (tickerMatch || nameMatch) {
    return { level: "HIGH", reason: tickerMatch ? "ticker_found_in_headline" : "company_name_found_in_headline" };
  }
  return { level: "LOW_ENTITY_CONFIDENCE", reason: "neither_ticker_nor_company_name_found_in_headline", requires_review: true };
}

// ================== Score: KNOWN_SCORE + EVIDENCE COVERAGE (P3.1B.2) ==================
// components: { FINANCIAL_SCALE, STRATEGIC_RELEVANCE, TIMELINE_URGENCY,
//   SOURCE_STRENGTH } -- cada uno {value: number|"UNKNOWN", ...}.
//
// Bug real corregido (evidencia P3.1B.1): antes, cuando solo 2 de 4
// componentes eran conocidos, el peso restante se renormalizaba entre
// ellos para seguir sumando 100% -- eso permitia que 2 señales
// mediocres (ej. STRATEGIC=40, SOURCE=50) se "expandieran" a un score
// de 45/MEDIUM identico al de tener evidencia completa. En la muestra
// real, 8 de 9 noticias de puro ruido (sin FINANCIAL_SCALE ni
// TIMELINE_URGENCY conocidos) puntuaron MEDIUM por esto, sin importar
// el contenido real del headline.
//
// Fix: se separan dos conceptos, nunca mezclados en un solo numero sin
// explicar el porque --
//   KNOWN_SCORE = promedio ponderado SOLO entre los componentes
//     conocidos (renormalizado entre ellos -- exactamente el calculo
//     de antes, pero ahora es un paso intermedio, no el resultado
//     final).
//   COVERAGE = fraccion del peso TOTAL de la policy que esta
//     efectivamente conocida (suma de DETERMINISTIC_WEIGHTS de los
//     componentes conocidos, 0..1). Con 4/4 conocidos, coverage=1.
//   FINAL = KNOWN_SCORE × sqrt(COVERAGE) -- la raiz cuadrada amortigua
//     el score cuando falta evidencia SIN aplastarlo linealmente a
//     cero (mismo principio de "retornos decrecientes" que ya usa
//     lib/materialEventConfidence.js para corroboration_confidence,
//     no un exponente inventado para este caso). Coverage=1 -> FINAL
//     identico a KNOWN_SCORE (cero cambio de comportamiento con
//     evidencia completa). Coverage bajo -> FINAL cae, pero nunca a 0
//     salvo que KNOWN_SCORE tambien sea 0.
//
// ENTITY_RELEVANCE (ver arriba) participa como una degradacion
// ADICIONAL de la cobertura EFECTIVA, no como un quinto componente
// ponderado -- una señal de baja confianza en que el evento realmente
// trata de este ticker no es "evidencia faltante" en el mismo sentido
// que un FINANCIAL_SCALE UNKNOWN, es evidencia de que la poca cobertura
// que SI tenemos podria ni siquiera aplicar a esta empresa.
//
// UNKNOWN nunca se convierte en 0 -- el componente en si sigue
// declarado explicitamente como UNKNOWN (nunca coercionado). Si TODOS
// son UNKNOWN, el resultado es DATA_UNAVAILABLE, nunca un score de 0.
const ENTITY_RELEVANCE_COVERAGE_PENALTY = 0.5;

export function computeDeterministicScore(components, options) {
  components = components || {};
  options = options || {};
  const known = {};
  let knownWeight = 0;
  for (const key of Object.keys(DETERMINISTIC_WEIGHTS)) {
    const v = components[key]?.value;
    if (isNum(v)) {
      known[key] = v;
      knownWeight += DETERMINISTIC_WEIGHTS[key];
    }
  }
  const componentsKnown = Object.keys(known).length;
  const componentsTotal = Object.keys(DETERMINISTIC_WEIGHTS).length;

  if (componentsKnown === 0) {
    return {
      status: "DATA_UNAVAILABLE", score: null, known_score: null, coverage: 0, effective_coverage: 0,
      weights_used: {}, components_known: 0, components_total: componentsTotal,
      entity_relevance_penalty_applied: false,
    };
  }

  let knownScore = 0;
  const weightsUsed = {};
  for (const key of Object.keys(known)) {
    const renormalized = DETERMINISTIC_WEIGHTS[key] / knownWeight;
    weightsUsed[key] = Math.round(renormalized * 1000) / 1000;
    knownScore += known[key] * renormalized;
  }

  const coverage = knownWeight; // ya es 0..1, DETERMINISTIC_WEIGHTS suma 1.0
  const entityPenaltyApplied = options.entityRelevanceLevel === "LOW_ENTITY_CONFIDENCE";
  const effectiveCoverage = entityPenaltyApplied ? coverage * ENTITY_RELEVANCE_COVERAGE_PENALTY : coverage;
  const finalScore = clamp0to100(knownScore * Math.sqrt(effectiveCoverage));

  return {
    status: "SCORED",
    score: finalScore,
    known_score: clamp0to100(knownScore),
    coverage: Math.round(coverage * 1000) / 1000,
    effective_coverage: Math.round(effectiveCoverage * 1000) / 1000,
    weights_used: weightsUsed,
    components_known: componentsKnown,
    components_total: componentsTotal,
    entity_relevance_penalty_applied: entityPenaltyApplied,
  };
}

// ================== PORTFOLIO_RELEVANCE (dimension separada) ==================
// Seccion 12 del sprint P3.1B: NUNCA se mezcla silenciosamente con el
// score de materialidad del evento/empresa -- y desde P3.1B.2, esta es
// la UNICA funcion del engine que lee isActivePosition/conviction.
// Deterministico, basado en datos reales de thesis/positions -- nunca
// inventado por AI.
export function classifyPortfolioRelevance({ isActivePosition, conviction }) {
  if (!isActivePosition) return { level: "LOW", reason: "not_an_active_position" };
  if (isNum(conviction) && conviction >= 4) return { level: "HIGH", reason: `active_position_high_conviction(${conviction})` };
  if (isNum(conviction) && conviction >= 2) return { level: "MEDIUM", reason: `active_position_moderate_conviction(${conviction})` };
  return { level: "MEDIUM", reason: "active_position_conviction_unknown_or_low" };
}
