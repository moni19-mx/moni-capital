// lib/materialityEngine.js
// Sprint P3.1B (Materiality Engine). Componentes deterministicos --
// CERO LLM, CERO red, CERO Supabase. Cada funcion recibe datos ya
// resueltos (facts del evento, contexto de posicion/portfolio) y
// devuelve {value: 0-100 | "UNKNOWN", method, ...detalle}. Nunca
// inventa un monto desde lenguaje ("major"/"huge"/"significant") --
// solo desde campos numericos reales.
//
// Los multiplicadores usados para mapear un ratio real (ej.
// deal_value/revenue) a una escala 0-100 son deliberadamente simples y
// declarados como tuneables -- no son una calibracion empirica, son un
// punto de partida razonable y explicable, igual que los pesos de
// DETERMINISTIC_WEIGHTS (scoring_policy_version los versiona a todos
// juntos).

import { tierScore } from "./materialEventSources.js";
import { DETERMINISTIC_WEIGHTS } from "./materialEventVersioning.js";

export const UNKNOWN = "UNKNOWN";

function isNum(v) {
  return typeof v === "number" && !Number.isNaN(v);
}
function clamp0to100(v) {
  return Math.max(0, Math.min(100, Math.round(v)));
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

// ================== STRATEGIC_RELEVANCE ==================
// Deterministico: solo verifica HECHOS estructurados (esta posicion
// tiene una clasificacion tematica real, y el headline comparte
// palabras con esa clasificacion). Nunca decide "este evento importa
// para la estrategia" por si mismo -- eso es juicio, va en AI
// adjustment, acotado.
export function computeStrategicRelevance(facts, positionContext) {
  facts = facts || {};
  positionContext = positionContext || {};
  const { isActivePosition, tema, sector, strategic_role: strategicRole } = positionContext;

  if (!isActivePosition && !tema && !sector && !strategicRole) {
    return { value: UNKNOWN, method: "no_position_context", inputs_missing: ["position_context"] };
  }

  let value = 0;
  const evidence = [];
  if (isActivePosition) { value += 20; evidence.push("active_position"); }
  const classification = tema || strategicRole;
  if (classification && classification !== "Sin clasificar") { value += 20; evidence.push(`classified_as(${classification})`); }

  const headline = (facts.headline_raw || "").toLowerCase();
  const themeWords = [tema, sector, strategicRole].filter(Boolean).join(" ").toLowerCase()
    .split(/[^a-záéíóúñ]+/).filter((w) => w.length >= 4);
  const overlap = themeWords.some((w) => headline.includes(w));
  if (overlap) { value += 20; evidence.push("headline_keyword_overlap_with_theme"); }

  return { value: clamp0to100(value), method: "position_theme_and_headline_overlap", evidence };
}

// ================== TIMELINE_URGENCY ==================
// Distinto de freshness (que es sobre cuando se DESCUBRIO/OCURRIO el
// hecho) -- esto es sobre si hay una fecha futura relevante (vigencia,
// deadline regulatorio, earnings). Nunca "publicado hoy = urgencia 100".
export function computeTimelineUrgency(facts, now) {
  facts = facts || {};
  const relevantDate = facts.effective_date || facts.contract_start || facts.earnings_date || facts.regulatory_deadline || null;
  if (!relevantDate) {
    return { value: UNKNOWN, method: "no_relevant_date_in_facts", inputs_missing: ["effective_date_or_equivalent"] };
  }
  const daysUntil = (new Date(relevantDate).getTime() - new Date(now).getTime()) / 86400000;
  if (daysUntil <= 0) return { value: 100, method: "already_effective_or_past", days_until: Math.round(daysUntil) };
  if (daysUntil <= 30) return { value: 80, method: "within_30_days", days_until: Math.round(daysUntil) };
  if (daysUntil <= 180) return { value: 50, method: "within_180_days", days_until: Math.round(daysUntil) };
  return { value: 20, method: "beyond_180_days", days_until: Math.round(daysUntil) };
}

// ================== SOURCE_STRENGTH ==================
// Reusa tierScore() de lib/materialEventSources.js -- una sola tabla
// tier->score, nunca duplicada.
export function computeSourceStrength(primaryEvidenceTier) {
  if (primaryEvidenceTier == null) return { value: UNKNOWN, method: "no_primary_source" };
  return { value: tierScore(primaryEvidenceTier), method: "primary_evidence_tier", tier: primaryEvidenceTier };
}

// ================== Score ponderado con renormalizacion ==================
// components: { FINANCIAL_SCALE, STRATEGIC_RELEVANCE, TIMELINE_URGENCY,
//   SOURCE_STRENGTH } -- cada uno {value: number|"UNKNOWN", ...}.
//
// UNKNOWN nunca se convierte en 0 -- se EXCLUYE, y el peso restante se
// renormaliza entre los componentes SI conocidos para que sigan sumando
// 100%. Si TODOS son UNKNOWN, el resultado es DATA_UNAVAILABLE, nunca
// un score de 0 (0 significaria "definitivamente no material", que es
// una afirmacion distinta de "no tenemos suficiente informacion").
export function computeDeterministicScore(components) {
  components = components || {};
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
    return { status: "DATA_UNAVAILABLE", score: null, weights_used: {}, components_known: 0, components_total: componentsTotal };
  }

  let score = 0;
  const weightsUsed = {};
  for (const key of Object.keys(known)) {
    const renormalized = DETERMINISTIC_WEIGHTS[key] / knownWeight;
    weightsUsed[key] = Math.round(renormalized * 1000) / 1000;
    score += known[key] * renormalized;
  }

  return { status: "SCORED", score: clamp0to100(score), weights_used: weightsUsed, components_known: componentsKnown, components_total: componentsTotal };
}

// ================== PORTFOLIO_RELEVANCE (dimension separada) ==================
// Seccion 12 del sprint: NUNCA se mezcla silenciosamente con el score
// de materialidad del evento/empresa. Deterministico, basado en datos
// reales de thesis/positions -- nunca inventado por AI.
export function classifyPortfolioRelevance({ isActivePosition, conviction }) {
  if (!isActivePosition) return { level: "LOW", reason: "not_an_active_position" };
  if (isNum(conviction) && conviction >= 4) return { level: "HIGH", reason: `active_position_high_conviction(${conviction})` };
  if (isNum(conviction) && conviction >= 2) return { level: "MEDIUM", reason: `active_position_moderate_conviction(${conviction})` };
  return { level: "MEDIUM", reason: "active_position_conviction_unknown_or_low" };
}
