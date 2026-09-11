#!/usr/bin/env node
// scripts/fmpAuthTest.mjs
//
// PRIORITY 2, paso 2: UNA sola llamada simple de auth/capability a FMP,
// ANTES de correr la auditoria completa de cobertura historica. Nunca
// loguea ni imprime el valor de la API key. Nunca reintenta -- si esto
// falla por auth, el workflow debe detenerse (ver be-eps-candidate-dump
// / asml-finnhub-probe: NUNCA correr el probe completo sobre un key que
// ya fallo auth).
//
// AAPL/quote es el endpoint mas simple posible y ya confirmado
// funcional para FMP en produccion (ver
// docs/intelligence/P3.1A.1-REAL-PROVIDER-FACT-CHECK.md) -- nunca
// devuelve 401, solo 200 (datos reales) o 402 (Payment Required, plan
// insuficiente). 402 significa "la key SI autentico, solo el plan no
// alcanza" -- eso NO es un fallo de auth, es un fallo de plan-tier.
// Solo 401/403 cuentan como fallo real de autenticacion.

import { appendFileSync } from "node:fs";

const FMP_KEY = process.env.FMP_API_KEY;
const FMP_BASE = "https://financialmodelingprep.com/stable";

function setOutput(name, value) {
  const outFile = process.env.GITHUB_OUTPUT;
  if (outFile) appendFileSync(outFile, `${name}=${value}\n`);
}

async function main() {
  if (!FMP_KEY) {
    console.log("[fmp-auth-test] FMP_API_KEY not present in environment -- this script should not have run");
    setOutput("auth_ok", "false");
    setOutput("classification", "NO_KEY");
    process.exit(1);
  }

  const url = `${FMP_BASE}/quote?symbol=AAPL&apikey=${FMP_KEY}`;
  console.log(`[fmp-auth-test] started_at=${new Date().toISOString()} test_symbol=AAPL endpoint=quote`);

  let resp;
  try {
    resp = await fetch(url);
  } catch (e) {
    console.log(`[fmp-auth-test] network_error=${String(e.message || e)}`);
    setOutput("auth_ok", "false");
    setOutput("classification", "NETWORK_ERROR");
    process.exit(0);
    return;
  }

  console.log(`[fmp-auth-test] http_status=${resp.status}`);

  if (resp.status === 401 || resp.status === 403) {
    const bodyText = await resp.text();
    console.log(`[fmp-auth-test] classification=AUTH_ERROR body_snippet=${bodyText.slice(0, 200)}`);
    setOutput("auth_ok", "false");
    setOutput("classification", "AUTH_ERROR");
    process.exit(0);
    return;
  }

  if (resp.status === 402) {
    console.log("[fmp-auth-test] classification=PLAN_BLOCKED -- key authenticated (not a 401/403), but this specific endpoint/symbol is outside the current plan tier");
    setOutput("auth_ok", "true");
    setOutput("classification", "PLAN_BLOCKED");
    process.exit(0);
    return;
  }

  if (!resp.ok) {
    const bodyText = await resp.text();
    console.log(`[fmp-auth-test] classification=OTHER_ERROR status=${resp.status} body_snippet=${bodyText.slice(0, 200)}`);
    setOutput("auth_ok", "false");
    setOutput("classification", "OTHER_ERROR");
    process.exit(0);
    return;
  }

  const data = await resp.json();
  const hasRealData = Array.isArray(data) && data.length > 0 && typeof data[0]?.price === "number";
  console.log(`[fmp-auth-test] classification=OK response_shape=${Array.isArray(data) ? "array" : typeof data} records=${Array.isArray(data) ? data.length : "n/a"} has_real_price_field=${hasRealData}`);
  console.log(`[fmp-auth-test] sample_record=${JSON.stringify(Array.isArray(data) ? data[0] : data).slice(0, 500)}`);
  setOutput("auth_ok", "true");
  setOutput("classification", "OK");
}

main().catch((e) => {
  console.error("[fatal]", e);
  setOutput("auth_ok", "false");
  setOutput("classification", "FATAL_ERROR");
  process.exit(1);
});
