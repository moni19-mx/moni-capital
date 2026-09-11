#!/usr/bin/env node
// scripts/beEpsCandidateDump.mjs
//
// Diagnostico puntual, SOLO LECTURA, temporal -- un solo caso (BE),
// posterior al fix de seleccion de unidad. Objetivo: entender CON
// EVIDENCIA por que, incluso con selectCompatibleUnit ya corregido,
// BE sigue resolviendo a EarningsPerShareBasicAndDiluted (2020, LOW)
// en vez de EarningsPerShareDiluted (donde companyfacts muestra un
// punto 2025 real). No modifica CANDIDATE_TAGS ni ningun mapeo --
// solo imprime, para AMBOS tags candidatos, los puntos anuales reales
// que extractAnnualPoints + scoreCandidate producen hoy, y el detalle
// crudo de cada entrada bajo la unidad USD/shares (forma, duracion,
// fy) para ver exactamente por que una entrada califica o no como
// "anual" (form en TRUSTED_ANNUAL_FORMS + duracion 330-400 dias).
//
// SEC EDGAR es publico -- sin API key, sin secret.

import {
  CANDIDATE_TAGS, CONCEPT_UNITS, extractAnnualPoints, scoreCandidate,
  selectCompatibleUnit, TRUSTED_ANNUAL_FORMS,
} from "../lib/secFinancialsResolver.js";

const SEC_HEADERS = {
  "User-Agent": "MoniCapital-Diagnostic contacto@moni-capital-diagnostic.local",
};
const BE_CIK = "0001664703";

function daysBetween(a, b) {
  return Math.round((new Date(b) - new Date(a)) / 86400000);
}

async function main() {
  console.log(`[be-candidate-dump] started_at=${new Date().toISOString()} cik=${BE_CIK}`);
  console.log(`[be-candidate-dump] TRUSTED_ANNUAL_FORMS=${JSON.stringify(TRUSTED_ANNUAL_FORMS)}`);
  const tags = CANDIDATE_TAGS.EPS_DILUTED;
  const allowedUnits = CONCEPT_UNITS.EPS_DILUTED;
  console.log(`[be-candidate-dump] tags=${JSON.stringify(tags)} allowedUnits=${JSON.stringify(allowedUnits)}`);

  for (const tag of tags) {
    const url = `https://data.sec.gov/api/xbrl/companyconcept/CIK${BE_CIK}/us-gaap/${tag}.json`;
    const resp = await fetch(url, { headers: SEC_HEADERS });
    console.log(`\n[be-candidate-dump] === tag=${tag} status=${resp.status} ===`);
    if (!resp.ok) {
      console.log(`[be-candidate-dump] tag=${tag} fetch_failed`);
      continue;
    }
    const data = await resp.json();
    const units = data.units || {};
    console.log(`[be-candidate-dump] tag=${tag} units_keys=${JSON.stringify(Object.keys(units))}`);
    const chosenUnit = selectCompatibleUnit(units, allowedUnits);
    console.log(`[be-candidate-dump] tag=${tag} selectCompatibleUnit_result=${JSON.stringify(chosenUnit)}`);

    if (chosenUnit) {
      const rawEntries = units[chosenUnit] || [];
      console.log(`[be-candidate-dump] tag=${tag} unit=${chosenUnit} raw_entry_count=${rawEntries.length}`);
      // Detalle crudo de TODAS las entradas bajo la unidad elegida,
      // para ver exactamente por que cada una califica o no.
      const detail = rawEntries.map((e) => ({
        val: e.val, start: e.start || null, end: e.end, form: e.form,
        fy: e.fy, fp: e.fp, filed: e.filed,
        duration_days: e.start ? daysBetween(e.start, e.end) : null,
        is_trusted_form: TRUSTED_ANNUAL_FORMS.includes(e.form),
        is_annual_duration: e.start ? (() => { const d = daysBetween(e.start, e.end); return d >= 330 && d <= 400; })() : false,
      }));
      console.log(`[be-candidate-dump] tag=${tag} raw_entries_detail=${JSON.stringify(detail, null, 2)}`);
    }

    const annualPoints = extractAnnualPoints(data, allowedUnits);
    console.log(`[be-candidate-dump] tag=${tag} extractAnnualPoints_count=${annualPoints.length}`);
    if (annualPoints.length > 0) {
      console.log(`[be-candidate-dump] tag=${tag} extractAnnualPoints_points=${JSON.stringify(annualPoints, null, 2)}`);
      const score = scoreCandidate(annualPoints);
      console.log(`[be-candidate-dump] tag=${tag} scoreCandidate=${JSON.stringify(score)}`);
    }
    await new Promise((r) => setTimeout(r, 150));
  }

  console.log("\n[be-candidate-dump] done -- diagnostico puro, sin escritura.");
}

main().catch((e) => { console.error("[fatal]", e); process.exit(1); });
