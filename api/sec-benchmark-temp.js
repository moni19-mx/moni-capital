// api/sec-benchmark-temp.js
//
// DIAGNOSTICO TEMPORAL -- no forma parte del flujo de produccion de Moni
// Capital. No lo importa ningun otro archivo. Se borra de este repo
// cuando terminemos de decidir arquitectura de datos.
//
// A diferencia de FMP/Finnhub, SEC EDGAR es 100% publico y no requiere
// ninguna API key -- solo un User-Agent con contacto real, que es un
// requisito de identificacion, no un secreto.
//
// Uso: GET /api/sec-benchmark-temp?pin=TU_PIN&tickers=ANET,VRT,ALAB,...
//   Los tickers van separados por coma. Cada uno necesita su CIK -- se
//   resuelven automaticamente contra el mapa oficial de SEC.
//
// Extrae 6 conceptos XBRL por ticker (los mas confiables entre distintas
// empresas, con nombres de tag alternativos por si una compania usa una
// variante distinta):
//   - Revenue (Revenues / RevenueFromContractWithCustomerExcludingAssessedTax)
//   - EPS diluido (EarningsPerShareDiluted)
//   - Net income (NetIncomeLoss)
//   - Operating income (OperatingIncomeLoss)
//   - Cash flow operativo (NetCashProvidedByUsedInOperatingActivities)
//   - CapEx (PaymentsToAcquirePropertyPlantAndEquipment)
//
// Con Revenue + NetIncome + OperatingIncome se puede derivar net/operating
// margin (division simple, Capa 1 -- no es interpretacion de IA). Con
// CashFlowOperativo - CapEx se deriva Free Cash Flow.

import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.VITE_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const SEC_HEADERS = {
  "User-Agent": "MoniCapital-Diagnostic contacto@moni-capital-diagnostic.local",
};

const REQUEST_DELAY_MS = 150; // SEC permite hasta 10 req/s; nos quedamos bien debajo

const CONCEPTS = [
  { tag: "Revenues", altTag: "RevenueFromContractWithCustomerExcludingAssessedTax", label: "revenue" },
  { tag: "EarningsPerShareDiluted", altTag: null, label: "eps_diluted" },
  { tag: "NetIncomeLoss", altTag: null, label: "net_income" },
  { tag: "OperatingIncomeLoss", altTag: null, label: "operating_income" },
  { tag: "NetCashProvidedByUsedInOperatingActivities", altTag: null, label: "operating_cash_flow" },
  { tag: "PaymentsToAcquirePropertyPlantAndEquipment", altTag: null, label: "capex" },
];

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

// Nos quedamos con el valor mas reciente de tipo 10-K anual (FY), que es
// el mas comparable entre companias. Si no hay 10-K, tomamos el ultimo
// valor disponible de cualquier forma.
function extractAnnualSeries(conceptJson) {
  const units = conceptJson?.units || {};
  const unitKey = Object.keys(units)[0]; // USD, USD/shares, etc.
  if (!unitKey) return [];
  const entries = units[unitKey] || [];
  const annual = entries.filter((e) => e.form === "10-K" && e.fp === "FY");
  const source = annual.length > 0 ? annual : entries;

  const byEnd = {};
  source.forEach((e) => {
    if (!byEnd[e.end] || e.filed > byEnd[e.end].filed) byEnd[e.end] = e;
  });

  return Object.values(byEnd)
    .sort((a, b) => (a.end < b.end ? 1 : -1))
    .slice(0, 5)
    .map((e) => ({
      value: e.val,
      unit: unitKey,
      form: e.form,
      filed_date: e.filed,
      period_end: e.end,
      fiscal_year: e.fy,
      fiscal_period: e.fp,
    }));
}

async function processTicker(ticker, cikPadded) {
  const rows = [];
  for (const concept of CONCEPTS) {
    let result = await fetchConcept(cikPadded, concept.tag);
    let usedTag = concept.tag;
    if (result.notFound && concept.altTag) {
      await sleep(REQUEST_DELAY_MS);
      result = await fetchConcept(cikPadded, concept.altTag);
      usedTag = concept.altTag;
    }

    if (result.data) {
      const series = extractAnnualSeries(result.data);
      series.forEach((point) => {
        rows.push({
          ticker,
          cik: cikPadded,
          concept: `${concept.label}(${usedTag})`,
          fiscal_year: point.fiscal_year,
          fiscal_period: point.fiscal_period,
          value: point.value,
          unit: point.unit,
          form: point.form,
          filed_date: point.filed_date,
          period_end: point.period_end,
          source: "sec_edgar",
          source_url: `https://data.sec.gov/api/xbrl/companyconcept/CIK${cikPadded}/us-gaap/${usedTag}.json`,
        });
      });
    } else {
      // Se registra la ausencia real -- ni el tag principal ni el
      // alterno tuvieron datos, o hubo un error de red/HTTP.
      rows.push({
        ticker,
        cik: cikPadded,
        concept: `${concept.label}(${usedTag})`,
        fiscal_year: null,
        fiscal_period: null,
        value: null,
        unit: null,
        form: null,
        filed_date: null,
        period_end: null,
        source: "sec_edgar",
        source_url: result.error ? `error:${result.error}` : "not_found",
      });
    }
    await sleep(REQUEST_DELAY_MS);
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
      const rows = await processTicker(ticker, cikPadded);
      const { error: insertErr } = await supabase.from("sec_financials").insert(rows);
      if (insertErr) {
        summary.push({ ticker, ok: false, error: insertErr.message });
        continue;
      }
      summary.push({ ticker, ok: true, cik: cikPadded, rows_inserted: rows.length });
    }

    return res.status(200).json({ ok: true, processed: summary.length, summary });
  } catch (err) {
    return res.status(500).json({ error: "sec_benchmark_failed", detail: String(err.message || err) });
  }
}
