#!/usr/bin/env node
// scripts/beEpsTagAudit.mjs
//
// Sprint P2A -- auditoria puntual, SOLO LECTURA, temporal, de UN solo
// caso (BE). No modifica CANDIDATE_TAGS ni ningun mapeo de tags --
// solo lee TODOS los conceptos us-gaap que BE ha reportado alguna vez
// (companyfacts, no companyconcept) y muestra cualquier concepto cuyo
// nombre sugiera "earnings per share" con su punto mas reciente, para
// decidir CON EVIDENCIA si el tag actual (EarningsPerShareDiluted /
// EarningsPerShareBasicAndDiluted, resuelto hoy en LOW confidence,
// ultimo valor 2020) sigue siendo el tag correcto o si BE migro a otro
// tag que este probe simplemente no está buscando todavia.
//
// SEC EDGAR es publico -- sin API key, sin secret.

const SEC_HEADERS = {
  "User-Agent": "MoniCapital-Diagnostic contacto@moni-capital-diagnostic.local",
};
const BE_CIK = "0001664703";

async function main() {
  console.log(`[be-audit] started_at=${new Date().toISOString()} cik=${BE_CIK}`);
  const url = `https://data.sec.gov/api/xbrl/companyfacts/CIK${BE_CIK}.json`;
  const resp = await fetch(url, { headers: SEC_HEADERS });
  console.log(`[be-audit] companyfacts status=${resp.status}`);
  if (!resp.ok) {
    console.error(`[be-audit] fetch failed, status=${resp.status}`);
    process.exit(1);
  }
  const data = await resp.json();
  const entityName = data.entityName || "UNKNOWN";
  const usGaap = data.facts?.["us-gaap"] || {};
  const allTags = Object.keys(usGaap);
  console.log(`[be-audit] entityName=${entityName} total_us_gaap_tags=${allTags.length}`);

  const epsLikeTags = allTags.filter((t) => /earningsper|incomeperdilutedshare|incomeperbasicshare|netincomelosspershare/i.test(t));
  console.log(`[be-audit] eps_like_tags_found=${JSON.stringify(epsLikeTags)}`);

  const results = [];
  for (const tag of epsLikeTags) {
    const units = usGaap[tag]?.units || {};
    const unitKey = Object.keys(units)[0];
    const entries = unitKey ? units[unitKey] : [];
    // mas reciente por period_end, sin filtrar por forma -- queremos ver
    // TODO lo que existe, incluida cualquier forma no-10-K/10-Q, para
    // decidir con evidencia completa.
    const sorted = [...(entries || [])].filter((e) => e.end).sort((a, b) => (a.end < b.end ? 1 : -1));
    const mostRecent = sorted[0] || null;
    const annualLike = sorted.filter((e) => {
      if (!e.start) return false;
      const dur = Math.round((new Date(e.end) - new Date(e.start)) / 86400000);
      return dur >= 330 && dur <= 400;
    });
    results.push({
      tag,
      unit: unitKey || null,
      total_points: sorted.length,
      most_recent: mostRecent ? { value: mostRecent.val, end: mostRecent.end, start: mostRecent.start || null, form: mostRecent.form, filed: mostRecent.filed, fy: mostRecent.fy } : null,
      most_recent_annual_shaped: annualLike[0] ? { value: annualLike[0].val, end: annualLike[0].end, form: annualLike[0].form, filed: annualLike[0].filed, fy: annualLike[0].fy } : null,
    });
    console.log(`[be-audit] tag=${tag} total_points=${sorted.length} most_recent=${JSON.stringify(mostRecent ? { value: mostRecent.val, end: mostRecent.end, form: mostRecent.form } : null)}`);
  }

  // Tambien: cual es el filing mas reciente de CUALQUIER tipo que BE
  // tenga en companyfacts (via REVENUE-like o cualquier tag con datos
  // 2024/2025/2026), para saber si BE simplemente dejo de existir como
  // filer activo o si sigue filing pero sin EPS bajo estos tags.
  let latestFilingAnyTag = null;
  for (const tag of allTags) {
    const units = usGaap[tag]?.units || {};
    const unitKey = Object.keys(units)[0];
    const entries = unitKey ? units[unitKey] : [];
    for (const e of entries || []) {
      if (e.filed && (!latestFilingAnyTag || e.filed > latestFilingAnyTag.filed)) {
        latestFilingAnyTag = { tag, filed: e.filed, form: e.form, end: e.end };
      }
    }
  }
  console.log(`[be-audit] latest_filing_any_tag=${JSON.stringify(latestFilingAnyTag)}`);

  console.log("[be-audit] === RESULT ===");
  console.log(JSON.stringify({ entityName, eps_like_tags: results, latest_filing_any_tag: latestFilingAnyTag }, null, 2));
}

main().catch((e) => { console.error("[fatal]", e); process.exit(1); });
