// api/sec-benchmark-temp.js
//
// DIAGNOSTICO TEMPORAL -- no forma parte del flujo de produccion de Moni
// Capital. No lo importa ningun otro archivo. Se borra de este repo
// cuando terminemos de decidir arquitectura de datos.
//
// V2: capa de normalizacion Raw XBRL Tag -> Canonical Financial Concept.
// NO hace keyword-matching libre sobre nombres de tags -- usa una lista
// priorizada y curada de tags XBRL conocidos y semanticamente validos
// por concepto. Cuando varios tags candidatos tienen datos, se elige
// por recencia + cobertura + continuidad (nunca por prioridad ciega),
// porque el problema real (confirmado en el benchmark V1) es que
// compañias distintas migran de tag con el tiempo -- el tag "preferido"
// en teoria puede estar obsoleto en la practica para un emisor dado.
//
// Si ningun candidato tiene datos utilizables: DATA_UNAVAILABLE. Si dos
// candidatos tienen datos recientes pero con valores materialmente
// distintos para el mismo periodo: se guarda con confidence LOW y se
// registra la ambiguedad explicitamente -- nunca se elige en silencio.

import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.VITE_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const SEC_HEADERS = {
  "User-Agent": "MoniCapital-Diagnostic contacto@moni-capital-diagnostic.local",
};

const REQUEST_DELAY_MS = 120;
const MAX_POINTS_STORED = 5;
const FRESH_DAYS_HIGH = 550;   // ~18 meses -- cubre el rezago normal entre fiscal year-end y 10-K
const FRESH_DAYS_MEDIUM = 730; // ~24 meses
const AMBIGUITY_THRESHOLD_PCT = 5; // % de diferencia entre tags candidatos en el mismo periodo

// Listas priorizadas de tags XBRL conocidos y semanticamente validos por
// concepto canonico. El orden es una preferencia inicial, NO una regla
// ciega -- el resolver puede elegir un tag de menor prioridad si tiene
// mejor recencia/cobertura real para ese emisor especifico.
const CANDIDATE_TAGS = {
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
};

// FREE_CASH_FLOW no tiene tags candidatos -- se calcula siempre como
// OPERATING_CASH_FLOW - CAPEX, nunca se busca un tag "FreeCashFlow".
const CANONICAL_CONCEPTS = Object.keys(CANDIDATE_TAGS);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function daysBetween(a, b) {
  if (!a || !b) return null;
  return Math.round((new Date(b) - new Date(a)) / 86400000);
}

async function getCikMap() {
  const resp = await fetch("https://www.sec.gov/files/company_tickers.json", { headers: SEC_HEADERS });
  if (!resp.ok) throw new Error(`cik_map_fetch_failed_${resp.status}`);
  const data = await resp.json();
  const map = {};
  Object.values(data).forEach((entry) => {
    map[entry.ticker.toUpperCase()] = String(entry.cik_str).padStart(10, "0");
  });
  return map;
}

async function fetchConcept(cikPadded, tag) {
  const url = `https://data.sec.gov/api/xbrl/companyconcept/CIK${cikPadded}/us-gaap/${tag}.json`;
  try {
    const resp = await fetch(url, { headers: SEC_HEADERS });
    if (resp.status === 404) return { notFound: true };
    if (!resp.ok) return { error: `http_${resp.status}` };
    const data = await resp.json();
    return { data };
  } catch (e) {
    return { error: String(e.message || e) };
  }
}

// Extrae la serie anual real de un tag (deteccion por duracion del
// periodo ~365 dias, no por el campo `fp` -- resulto no ser confiable
// entre distintos emisores en el benchmark V1). Devuelve TODOS los
// puntos anuales encontrados (no solo 5), para poder evaluar cobertura
// y continuidad reales antes de decidir si este tag es el ganador.
// Formas de filing confiables para datos anuales -- un 10-K/A (enmienda)
// se trata igual que un 10-K para efectos de confianza, nunca baja
// confidence solo por ser una enmienda. Cualquier otra forma (DEF 14A,
// 8-K, S-1, etc.) NUNCA participa en la deteccion de periodo anual,
// aunque su duracion coincida con ~365 dias -- este fue el mecanismo
// real detras del bug de NET_INCOME de ANET (un filing no-anual gano el
// desempate por "filed mas reciente" sobre el 10-K correcto).
const TRUSTED_ANNUAL_FORMS = ["10-K", "10-K/A", "10-KT", "10-KT/A"];

function formRank(form) {
  return TRUSTED_ANNUAL_FORMS.includes(form) ? 1 : 0;
}

function extractAnnualPoints(conceptJson) {
  const units = conceptJson?.units || {};
  const unitKey = Object.keys(units)[0];
  if (!unitKey) return [];
  const entries = units[unitKey];
  if (!Array.isArray(entries) || entries.length === 0) return [];

  const annual = entries.filter((e) => {
    if (!TRUSTED_ANNUAL_FORMS.includes(e.form)) return false;
    if (e.start && e.end) {
      const dur = daysBetween(e.start, e.end);
      return dur != null && dur >= 330 && dur <= 400;
    }
    return true; // valor instantaneo (sin start) en una forma ya confiable
  });
  if (annual.length === 0) return [];

  // Desempate: entre 10-K y 10-K/A del MISMO periodo, gana el mas
  // reciente filed (la enmienda corrige al original, como pediste en el
  // punto 4). Nunca hay riesgo de que una forma no confiable participe
  // porque ya se filtraron arriba.
  const byEnd = {};
  annual.forEach((e) => {
    const current = byEnd[e.end];
    if (!current || e.filed > current.filed) byEnd[e.end] = e;
  });

  return Object.values(byEnd)
    .sort((a, b) => (a.end < b.end ? 1 : -1))
    .map((e) => ({
      value: e.val,
      unit: unitKey,
      form: e.form,
      filed_date: e.filed,
      period_end: e.end,
      fiscal_year: e.fy,
      accession_number: e.accn || null,
    }));
}

// Evalua un candidato: recencia del punto mas reciente, cobertura
// (cuantos puntos anuales tiene), continuidad (cuantos de esos puntos
// son años consecutivos reales, no con huecos grandes).
function scoreCandidate(points) {
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

function computeConfidence(score) {
  if (!score) return null;
  if (score.recencyDays <= FRESH_DAYS_HIGH && score.coverage >= 3 && score.continuity >= 3 && score.form10K >= score.coverage - 1) {
    return "HIGH";
  }
  if (score.recencyDays <= FRESH_DAYS_MEDIUM && score.coverage >= 2) {
    return "MEDIUM";
  }
  return "LOW";
}

// Resuelve un concepto canonico para un ticker: prueba todos los tags
// candidatos, evalua cada uno, y selecciona por recencia+cobertura+
// continuidad -- nunca por prioridad ciega. Detecta ambiguedad cuando
// dos tags tienen valores materialmente distintos en el mismo periodo.
async function resolveConcept(cikPadded, canonicalConcept) {
  const tags = CANDIDATE_TAGS[canonicalConcept];
  const candidates = [];

  for (const tag of tags) {
    const result = await fetchConcept(cikPadded, tag);
    await sleep(REQUEST_DELAY_MS);
    if (result.data) {
      const points = extractAnnualPoints(result.data);
      if (points.length > 0) {
        candidates.push({ tag, points, score: scoreCandidate(points) });
      }
    }
  }

  if (candidates.length === 0) {
    return { status: "DATA_UNAVAILABLE", reason: "no_candidate_tag_had_usable_annual_data" };
  }

  // Ranking: recencia primero (freshest wins), luego cobertura, luego
  // el orden de la lista priorizada como desempate final.
  candidates.sort((a, b) => {
    if (a.score.recencyDays !== b.score.recencyDays) return a.score.recencyDays - b.score.recencyDays;
    if (a.score.coverage !== b.score.coverage) return b.score.coverage - a.score.coverage;
    return tags.indexOf(a.tag) - tags.indexOf(b.tag);
  });

  const winner = candidates[0];
  const confidence = computeConfidence(winner.score);

  // Deteccion de ambiguedad: algun otro candidato tiene un valor para
  // el MISMO period_end mas reciente, con diferencia material.
  let ambiguityNote = null;
  const winnerLatest = winner.points[0];
  for (const other of candidates.slice(1)) {
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
    status: "OK",
    tag: winner.tag,
    points: winner.points.slice(0, MAX_POINTS_STORED),
    confidence: ambiguityNote ? "LOW" : confidence,
    ambiguityNote,
  };
}

function confidenceRank(c) {
  return { HIGH: 3, MEDIUM: 2, LOW: 1 }[c] || 0;
}

async function processTicker(ticker, cikPadded) {
  const rows = [];
  const resolved = {}; // canonicalConcept -> resolveConcept result, para poder calcular FCF despues

  for (const concept of CANONICAL_CONCEPTS) {
    const result = await resolveConcept(cikPadded, concept);
    resolved[concept] = result;

    if (result.status === "DATA_UNAVAILABLE") {
      rows.push({
        ticker,
        cik: cikPadded,
        canonical_concept: concept,
        value: null,
        fiscal_year: null,
        period_end: null,
        form: null,
        filing_date: null,
        accession_number: null,
        raw_xbrl_tag: null,
        unit: null,
        source: "sec_edgar",
        normalization_method: "priority_list_recency_ranked",
        normalization_confidence: "DATA_UNAVAILABLE",
        ambiguity_note: result.reason,
      });
      continue;
    }

    result.points.forEach((point) => {
      rows.push({
        ticker,
        cik: cikPadded,
        canonical_concept: concept,
        value: point.value,
        fiscal_year: point.fiscal_year,
        period_end: point.period_end,
        form: point.form,
        filing_date: point.filed_date,
        accession_number: point.accession_number,
        raw_xbrl_tag: result.tag,
        unit: point.unit,
        source: "sec_edgar",
        normalization_method: "priority_list_recency_ranked",
        normalization_confidence: result.confidence,
        ambiguity_note: result.ambiguityNote,
      });
    });
  }

  // FREE_CASH_FLOW = OPERATING_CASH_FLOW - CAPEX, calculado de forma
  // deterministica solo para periodos donde AMBOS insumos se resolvieron
  // (no DATA_UNAVAILABLE). Confidence = la mas debil de las dos entradas.
  const ocf = resolved.OPERATING_CASH_FLOW;
  const capex = resolved.CAPEX;
  if (ocf.status === "OK" && capex.status === "OK") {
    ocf.points.forEach((ocfPoint) => {
      const capexPoint = capex.points.find((p) => p.period_end === ocfPoint.period_end);
      if (capexPoint) {
        const fcfConfidence =
          confidenceRank(ocf.confidence) <= confidenceRank(capex.confidence) ? ocf.confidence : capex.confidence;
        rows.push({
          ticker,
          cik: cikPadded,
          canonical_concept: "FREE_CASH_FLOW",
          value: ocfPoint.value - capexPoint.value,
          fiscal_year: ocfPoint.fiscal_year,
          period_end: ocfPoint.period_end,
          form: null,
          filing_date: null,
          accession_number: null,
          raw_xbrl_tag: `CALCULATED(${ocf.tag} - ${capex.tag})`,
          unit: ocfPoint.unit,
          source: "sec_edgar",
          normalization_method: "derived_subtraction",
          normalization_confidence: fcfConfidence,
          ambiguity_note: null,
        });
      }
    });
  } else {
    rows.push({
      ticker,
      cik: cikPadded,
      canonical_concept: "FREE_CASH_FLOW",
      value: null,
      fiscal_year: null,
      period_end: null,
      form: null,
      filing_date: null,
      accession_number: null,
      raw_xbrl_tag: null,
      unit: null,
      source: "sec_edgar",
      normalization_method: "derived_subtraction",
      normalization_confidence: "DATA_UNAVAILABLE",
      ambiguity_note: "requiere OPERATING_CASH_FLOW y CAPEX resueltos; al menos uno quedo DATA_UNAVAILABLE",
    });
  }

  return rows;
}

export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  const { pin, tickers } = req.query || {};

  if (!pin || pin !== process.env.MONI_PIN) {
    return res.status(401).json({ error: "invalid_pin" });
  }
  if (!tickers) {
    return res.status(400).json({ error: "missing_params", detail: "usa ?tickers=ANET,VRT,ALAB,..." });
  }

  try {
    const cikMap = await getCikMap();
    const tickerList = tickers.split(",").map((t) => t.trim().toUpperCase()).filter(Boolean);
    const summary = [];

    for (const ticker of tickerList) {
      const cikPadded = cikMap[ticker];
      if (!cikPadded) {
        summary.push({ ticker, ok: false, error: "cik_not_found" });
        continue;
      }
      try {
        const rows = await processTicker(ticker, cikPadded);
        const { error: insertErr } = await supabase.from("sec_financials_normalized").insert(rows);
        if (insertErr) {
          summary.push({ ticker, ok: false, error: insertErr.message });
          continue;
        }
        summary.push({ ticker, ok: true, cik: cikPadded, rows_inserted: rows.length });
      } catch (tickerErr) {
        summary.push({ ticker, ok: false, error: String(tickerErr.message || tickerErr) });
      }
    }

    return res.status(200).json({ ok: true, processed: summary.length, summary });
  } catch (err) {
    return res.status(500).json({ error: "sec_benchmark_failed", detail: String(err.message || err) });
  }
}
