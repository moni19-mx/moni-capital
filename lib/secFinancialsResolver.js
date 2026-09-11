// lib/secFinancialsResolver.js
//
// Logica PURA (cero red, cero Supabase) de resolucion de conceptos
// financieros SEC XBRL -- extraida de api/sec-benchmark-temp.js (que
// sigue siendo el unico llamador real: fetch + throttle + persistencia)
// para que sea testeable sin red, mismo patron que
// lib/priceTruthProbeState.js / lib/marketDataOrchestrator.js en este
// repo. CERO cambio de comportamiento respecto a la logica original de
// REVENUE/NET_INCOME/OPERATING_INCOME/OPERATING_CASH_FLOW/CAPEX -- solo
// se movio de archivo. La unica logica nueva es EPS_DILUTED (anual) y
// la extraccion/TTM trimestral (nunca antes existente en este repo).
//
// Sprint P2A (Valuation Facts Layer): agrega EPS_DILUTED como septimo
// concepto anual (misma maquinaria de tag-selection/ambiguedad/
// confidence, sin logica nueva) y una capa TRIMESTRAL separada, solo
// para TTM EPS -- nunca reusada para los otros 6 conceptos anuales.
//
// REGLA EXPLICITA (aprobada, nunca relajar sin instruccion directa):
// TTM EPS exige 4 trimestres REPORTADOS validos y consecutivos. NUNCA
// se deriva un trimestre sintetico (ej. Q4 = FY10-K - Q1-Q2-Q3 de los
// 10-Q) -- eso NO es lo mismo que FREE_CASH_FLOW = OCF - CAPEX (ahi se
// resta un concepto DE OTRO concepto del MISMO periodo ya reportado;
// aqui se prohibe inventar un PERIODO que la compañia nunca reporto
// como tal). Si faltan datos: INSUFFICIENT_DATA, nunca un TTM parcial
// presentado como completo.

// ================== Conceptos anuales (sin cambios de logica) ==================

export const CANDIDATE_TAGS = {
  REVENUE: [
    "RevenueFromContractWithCustomerExcludingAssessedTax",
    "RevenueFromContractWithCustomerIncludingAssessedTax",
    "Revenues",
    "SalesRevenueNet",
  ],
  NET_INCOME: ["NetIncomeLoss", "ProfitLoss"],
  OPERATING_INCOME: ["OperatingIncomeLoss"],
  OPERATING_CASH_FLOW: [
    "NetCashProvidedByUsedInOperatingActivities",
    "NetCashProvidedByUsedInOperatingActivitiesContinuingOperations",
  ],
  CAPEX: [
    "PaymentsToAcquirePropertyPlantAndEquipment",
    "PaymentsForCapitalImprovements",
    "PaymentsToAcquireProductiveAssets",
  ],
  // Sprint P2A: septimo concepto, misma maquinaria de resolucion que los
  // 6 anteriores. EarningsPerShareBasicAndDiluted es el fallback real
  // que usan algunos emisores cuando basic==diluted (estructura de
  // capital simple, sin dilucion) y no reportan un tag "Diluted"
  // separado -- nunca se inventa, es un tag XBRL real y valido.
  EPS_DILUTED: ["EarningsPerShareDiluted", "EarningsPerShareBasicAndDiluted"],
};

export const CANONICAL_CONCEPTS = Object.keys(CANDIDATE_TAGS);

// FREE_CASH_FLOW no tiene tags candidatos -- se calcula siempre como
// OPERATING_CASH_FLOW - CAPEX (logica sin cambios, vive en el llamador).

// BUGFIX real (Sprint P2A, caso BE): `Object.keys(units)[0]` NUNCA es una
// forma valida de elegir la unidad -- el orden de las keys de un objeto
// JSON no es un contrato de SEC, es un accidente de implementacion. Se
// confirmo con evidencia real: BE tiene multiples unidades en su
// companyconcept de EarningsPerShareDiluted, "USD/shares" NO es la
// primera key ahi (aunque SI lo es en companyfacts, una superficie de
// API distinta) -- tomar la primera key silenciosamente devolvia un
// array vacio (o, en el caso trimestral, crasheaba con
// "(entries || []).filter is not a function" porque la primera key
// resultaba ser una unidad cuyo valor no es un array). Cada concepto
// canonico ahora declara EXPLICITAMENTE que unidad(es) son compatibles
// -- nunca se acepta ninguna otra, sin importar el orden en que SEC las
// devuelva. Si la unidad esperada no existe: DATA_UNAVAILABLE, nunca se
// usa otra unidad en su lugar.
export const CONCEPT_UNITS = {
  REVENUE: ["USD"],
  NET_INCOME: ["USD"],
  OPERATING_INCOME: ["USD"],
  OPERATING_CASH_FLOW: ["USD"],
  CAPEX: ["USD"],
  EPS_DILUTED: ["USD/shares"],
};

// Elige la PRIMERA unidad de `allowedUnits` (en orden de preferencia del
// llamador) que exista en `units` Y tenga al menos un punto real --
// nunca "la primera key que sea", nunca una unidad no declarada.
export function selectCompatibleUnit(units, allowedUnits) {
  if (!units || typeof units !== "object") return null;
  if (!Array.isArray(allowedUnits) || allowedUnits.length === 0) return null;
  for (const candidate of allowedUnits) {
    if (Array.isArray(units[candidate]) && units[candidate].length > 0) return candidate;
  }
  return null;
}

export function daysBetween(a, b) {
  if (!a || !b) return null;
  return Math.round((new Date(b) - new Date(a)) / 86400000);
}

const FRESH_DAYS_HIGH = 550;   // ~18 meses
const FRESH_DAYS_MEDIUM = 730; // ~24 meses
const AMBIGUITY_THRESHOLD_PCT = 5;

export const TRUSTED_ANNUAL_FORMS = ["10-K", "10-K/A", "10-KT", "10-KT/A"];

export function extractAnnualPoints(conceptJson, allowedUnits) {
  const units = conceptJson?.units || {};
  const unitKey = selectCompatibleUnit(units, allowedUnits);
  if (!unitKey) return [];
  const entries = units[unitKey];
  if (!Array.isArray(entries) || entries.length === 0) return [];

  const annual = entries.filter((e) => {
    if (!TRUSTED_ANNUAL_FORMS.includes(e.form)) return false;
    if (e.start && e.end) {
      const dur = daysBetween(e.start, e.end);
      return dur != null && dur >= 330 && dur <= 400;
    }
    return true;
  });
  if (annual.length === 0) return [];

  const byEnd = {};
  annual.forEach((e) => {
    const current = byEnd[e.end];
    if (!current || e.filed > current.filed) byEnd[e.end] = e;
  });

  return Object.values(byEnd)
    .sort((a, b) => (a.end < b.end ? 1 : -1))
    .map((e) => ({
      value: e.val, unit: unitKey, form: e.form, filed_date: e.filed,
      period_end: e.end, fiscal_year: e.fy, accession_number: e.accn || null,
    }));
}

export function scoreCandidate(points) {
  if (points.length === 0) return null;
  const mostRecent = points[0];
  const recencyDays = daysBetween(mostRecent.period_end, new Date().toISOString().slice(0, 10));
  let continuity = 1;
  for (let i = 0; i < points.length - 1; i++) {
    const gap = daysBetween(points[i + 1].period_end, points[i].period_end);
    if (gap != null && gap >= 330 && gap <= 400) continuity++;
    else break;
  }
  const trustedFormCount = points.filter((p) => TRUSTED_ANNUAL_FORMS.includes(p.form)).length;
  return { recencyDays, coverage: points.length, continuity, form10K: trustedFormCount, mostRecent };
}

export function computeConfidence(score) {
  if (!score) return null;
  if (score.recencyDays <= FRESH_DAYS_HIGH && score.coverage >= 3 && score.continuity >= 3 && score.form10K >= score.coverage - 1) {
    return "HIGH";
  }
  if (score.recencyDays <= FRESH_DAYS_MEDIUM && score.coverage >= 2) {
    return "MEDIUM";
  }
  return "LOW";
}

export function confidenceRank(c) {
  return { HIGH: 3, MEDIUM: 2, LOW: 1 }[c] || 0;
}

// Decision PURA de cual tag candidato gana + deteccion de ambiguedad --
// separada de resolveConceptLive (que hace los fetch reales) para que
// sea testeable con fixtures, sin red. `candidates`: [{tag, points,
// score}], ya calculados por el llamador via extractAnnualPoints +
// scoreCandidate para cada tag que si tuvo datos.
export function pickWinnerAndDetectAmbiguity(candidates, tags) {
  if (candidates.length === 0) {
    return { status: "DATA_UNAVAILABLE", reason: "no_candidate_tag_had_usable_annual_data" };
  }

  const sorted = [...candidates].sort((a, b) => {
    if (a.score.recencyDays !== b.score.recencyDays) return a.score.recencyDays - b.score.recencyDays;
    if (a.score.coverage !== b.score.coverage) return b.score.coverage - a.score.coverage;
    return tags.indexOf(a.tag) - tags.indexOf(b.tag);
  });

  const winner = sorted[0];
  const confidence = computeConfidence(winner.score);

  let ambiguityNote = null;
  const winnerLatest = winner.points[0];
  for (const other of sorted.slice(1)) {
    const match = other.points.find((p) => p.period_end === winnerLatest.period_end);
    if (match && winnerLatest.value) {
      const diffPct = Math.abs((match.value - winnerLatest.value) / winnerLatest.value) * 100;
      if (diffPct > AMBIGUITY_THRESHOLD_PCT) {
        ambiguityNote = `tag alterno "${other.tag}" reporta ${match.value} para el mismo periodo (${winnerLatest.period_end}) vs ${winnerLatest.value} del tag elegido -- diferencia ${diffPct.toFixed(1)}%`;
        break;
      }
    }
  }

  return {
    status: "OK", tag: winner.tag, points: winner.points,
    confidence: ambiguityNote ? "LOW" : confidence, ambiguityNote,
  };
}

// ================== Trimestral (Sprint P2A, SOLO para TTM EPS) ==================
// Nunca reusado para los 6 conceptos anuales -- EPS_DILUTED es el UNICO
// concepto que se resuelve tambien a nivel trimestral, porque TTM es
// intrinsecamente una suma de 4 trimestres reales, no un dato anual.

export const TRUSTED_QUARTERLY_FORMS = ["10-Q", "10-Q/A"];

// Misma llamada HTTP/mismo JSON que ya trae extractAnnualPoints (el
// companyconcept de SEC devuelve TODAS las duraciones -- anuales Y
// trimestrales -- en el mismo array `units`) -- CERO llamadas HTTP
// adicionales para obtener los puntos trimestrales.
export function extractQuarterlyPoints(conceptJson, allowedUnits) {
  const units = conceptJson?.units || {};
  const unitKey = selectCompatibleUnit(units, allowedUnits);
  if (!unitKey) return [];
  const entries = units[unitKey];
  if (!Array.isArray(entries) || entries.length === 0) return [];

  const quarterly = entries.filter((e) => {
    if (!TRUSTED_QUARTERLY_FORMS.includes(e.form)) return false;
    if (!e.start || !e.end) return false; // EPS siempre es duration, nunca instant -- un punto sin start/end no es un trimestre valido
    const dur = daysBetween(e.start, e.end);
    return dur != null && dur >= 80 && dur <= 100; // ~1 trimestre fiscal real, nunca un acumulado YTD de 6/9 meses
  });
  if (quarterly.length === 0) return [];

  const byEnd = {};
  quarterly.forEach((e) => {
    const current = byEnd[e.end];
    if (!current || e.filed > current.filed) byEnd[e.end] = e; // 10-Q/A corrige al 10-Q original del mismo periodo
  });

  return Object.values(byEnd)
    .sort((a, b) => (a.end < b.end ? 1 : -1)) // mas reciente primero
    .map((e) => ({
      value: e.val, unit: unitKey, form: e.form, filed_date: e.filed,
      period_end: e.end, period_start: e.start, fiscal_year: e.fy, fiscal_period: e.fp || null,
      accession_number: e.accn || null,
    }));
}

const QUARTER_GAP_MIN_DAYS = 80;
const QUARTER_GAP_MAX_DAYS = 100;

// TTM EPS = suma de los 4 trimestres REPORTADOS mas recientes,
// consecutivos (sin huecos). NUNCA deriva un trimestre faltante --
// si no hay 4 puntos trimestrales reales y consecutivos, INSUFFICIENT_DATA.
export function computeTtmEps(quarterlyPoints) {
  if (!Array.isArray(quarterlyPoints) || quarterlyPoints.length < 4) {
    return {
      status: "INSUFFICIENT_DATA",
      reason: `solo ${quarterlyPoints?.length || 0} trimestre(s) reportado(s) disponible(s), se requieren 4`,
      quarters_used: [],
    };
  }

  const latestFour = quarterlyPoints.slice(0, 4);
  for (let i = 0; i < latestFour.length - 1; i++) {
    const gap = daysBetween(latestFour[i + 1].period_end, latestFour[i].period_end);
    if (gap == null || gap < QUARTER_GAP_MIN_DAYS || gap > QUARTER_GAP_MAX_DAYS) {
      return {
        status: "INSUFFICIENT_DATA",
        reason: `hueco entre trimestres consecutivos fuera de rango (${gap ?? "desconocido"} dias entre ${latestFour[i + 1].period_end} y ${latestFour[i].period_end}) -- nunca se rellena con un trimestre sintetico`,
        quarters_used: [],
      };
    }
  }

  const anyInvalid = latestFour.some((q) => typeof q.value !== "number" || !Number.isFinite(q.value));
  if (anyInvalid) {
    return { status: "INSUFFICIENT_DATA", reason: "al menos un trimestre tiene valor no numerico", quarters_used: [] };
  }

  const ttm = latestFour.reduce((sum, q) => sum + q.value, 0);
  return {
    status: "OK",
    ttm_eps: ttm,
    quarters_used: latestFour.map((q) => ({ period_end: q.period_end, value: q.value, form: q.form, accession_number: q.accession_number })),
    is_positive: ttm > 0,
  };
}
