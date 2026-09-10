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
import { checkAdminAuth } from "../lib/adminAuth.js";
// Sprint P2A: la logica PURA de resolucion (extraccion de puntos,
// scoring, confidence, ranking+ambiguedad) vive ahora en
// lib/secFinancialsResolver.js para ser testeable sin red -- CERO
// cambio de comportamiento para REVENUE/NET_INCOME/OPERATING_INCOME/
// OPERATING_CASH_FLOW/CAPEX, solo se movio de archivo. EPS_DILUTED
// (septimo concepto anual) y la capa trimestral/TTM son nuevas, viven
// en ese mismo lib.
import {
  CANDIDATE_TAGS, CANONICAL_CONCEPTS,
  extractAnnualPoints, scoreCandidate, pickWinnerAndDetectAmbiguity, confidenceRank,
} from "../lib/secFinancialsResolver.js";

const supabase = createClient(
  process.env.VITE_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const SEC_HEADERS = {
  "User-Agent": "MoniCapital-Diagnostic contacto@moni-capital-diagnostic.local",
};

const REQUEST_DELAY_MS = 120;
const MAX_POINTS_STORED = 5;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

// Resuelve un concepto canonico para un ticker: prueba todos los tags
// candidatos, evalua cada uno, y selecciona por recencia+cobertura+
// continuidad -- nunca por prioridad ciega. Detecta ambiguedad cuando
// dos tags tienen valores materialmente distintos en el mismo periodo.
// La decision (ranking + ambiguedad) es pickWinnerAndDetectAmbiguity,
// pura, en lib/secFinancialsResolver.js -- esta funcion solo hace los
// fetch reales y arma los candidatos para pasarselos.
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

  const decision = pickWinnerAndDetectAmbiguity(candidates, tags);
  if (decision.status === "DATA_UNAVAILABLE") return decision;
  return { ...decision, points: decision.points.slice(0, MAX_POINTS_STORED) };
}

async function processTicker(ticker, cikPadded) {
  const rows = [];
  const resolved = {}; // canonicalConcept -> resolveConcept result, para poder calcular FCF despues
  let secHttpCalls = 0;

  for (const concept of CANONICAL_CONCEPTS) {
    secHttpCalls += CANDIDATE_TAGS[concept].length;
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

  return { rows, secHttpCalls };
}

export const config = { maxDuration: 60 };

// Instrumentacion real de timing (Priority 2, item 2 del sprint de
// automatizacion): antes solo se podia inferir runtime desde el
// fetched_at del ticker siguiente (delta entre inserts), lo cual mide
// OBSERVED_INTER_TICKER_DELTA, no ACTUAL_BATCH_DURATION ni el costo del
// primer ticker ni el fetch del CIK map. Ahora se mide con Date.now()
// real dentro del propio request/response -- no depende de acceso a
// logs de Vercel (al que este entorno no tiene acceso). Todo lo que no
// se puede medir limpiamente (timing por-request individual a SEC,
// tiempo de normalizacion aislado del de red) se deja fuera en vez de
// inventarse -- ver per_ticker.db_write_duration_ms como la unica pieza
// nueva medible con precision razonable.
export default async function handler(req, res) {
  const requestStartedAt = Date.now();
  const auth = checkAdminAuth(
    { headers: req.headers, query: req.query },
    { MONI_ADMIN_SECRET: process.env.MONI_ADMIN_SECRET, MONI_PIN: process.env.MONI_PIN }
  );
  if (!auth.authorized) {
    return res.status(401).json({ error: "unauthorized" });
  }
  const { tickers } = req.query || {};
  if (!tickers) {
    return res.status(400).json({ error: "missing_params", detail: "usa ?tickers=ANET,VRT,ALAB,..." });
  }

  try {
    const cikMapStartedAt = Date.now();
    const cikMap = await getCikMap();
    const cikMapDurationMs = Date.now() - cikMapStartedAt;

    const tickerList = tickers.split(",").map((t) => t.trim().toUpperCase()).filter(Boolean);
    const summary = [];

    for (const ticker of tickerList) {
      const tickerStartedAt = Date.now();
      const cikPadded = cikMap[ticker];
      if (!cikPadded) {
        summary.push({ ticker, ok: false, error: "cik_not_found" });
        continue;
      }
      try {
        const { rows, secHttpCalls } = await processTicker(ticker, cikPadded);
        const dbWriteStartedAt = Date.now();
        const { error: insertErr } = await supabase.from("sec_financials_normalized").insert(rows);
        const dbWriteDurationMs = Date.now() - dbWriteStartedAt;
        const tickerFinishedAt = Date.now();
        if (insertErr) {
          summary.push({ ticker, ok: false, error: insertErr.message });
          continue;
        }
        summary.push({
          ticker, ok: true, cik: cikPadded, rows_inserted: rows.length,
          timing: {
            started_at: new Date(tickerStartedAt).toISOString(),
            finished_at: new Date(tickerFinishedAt).toISOString(),
            duration_ms: tickerFinishedAt - tickerStartedAt,
            sec_http_calls: secHttpCalls,
            db_write_duration_ms: dbWriteDurationMs,
          },
        });
      } catch (tickerErr) {
        summary.push({ ticker, ok: false, error: String(tickerErr.message || tickerErr) });
      }
    }

    const requestFinishedAt = Date.now();
    return res.status(200).json({
      ok: true,
      processed: summary.length,
      summary,
      timing: {
        request_started_at: new Date(requestStartedAt).toISOString(),
        request_finished_at: new Date(requestFinishedAt).toISOString(),
        total_duration_ms: requestFinishedAt - requestStartedAt,
        cik_map_fetch_duration_ms: cikMapDurationMs,
      },
    });
  } catch (err) {
    return res.status(500).json({ error: "sec_benchmark_failed", detail: String(err.message || err) });
  }
}
