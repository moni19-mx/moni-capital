#!/usr/bin/env node
// scripts/asmlFinnhubProbe.mjs
//
// AUDITORIA ANGOSTA, TEMPORAL, SOLO LECTURA -- "PROVIDER SYMBOL
// RESOLUTION GAP -- ASML.AS". Corre en GitHub Actions (egress real --
// este sandbox de Claude Code no llega a *.finnhub.io, mismo motivo
// documentado para el Price Truth Probe / Conviction Coverage
// Orchestrator).
//
// NUNCA escribe en Supabase. NUNCA toca product code
// (api/market-data.js, lib/prices.js, lib/marketDataOrchestrator.js
// quedan intactos). NUNCA imprime ni loguea FINNHUB_API_KEY -- toda URL
// se sanitiza (token reemplazado por "REDACTED") ANTES de loguearse,
// nunca despues.
//
// Objetivo: evidencia REAL, no inferida, para responder:
//   1-4. endpoint exacto / symbol enviado / HTTP status / respuesta
//        saneada (nunca se loguea el token)
//   5. si el quote es valido/no-cero
//   6. si /search resuelve el listing de Amsterdam
//   7. si Finnhub identifica exchange/market/currency (via /stock/profile2)
//   8. si "ASML" mapea al ADR de EEUU y "ASML.AS" a Amsterdam
//   9. si el plan actual soporta el listing de Amsterdam
//   10. clasificacion de causa raiz: WRONG_SYMBOL_FORMAT |
//       UNSUPPORTED_EXCHANGE_OR_PLAN | PROVIDER_DATA_GAP | OTHER
//   11. fix minimo seguro (propuesto, NUNCA escrito por este script)

import { writeFileSync } from "node:fs";

const FINNHUB_KEY = process.env.FINNHUB_API_KEY;
if (!FINNHUB_KEY) {
  console.error("[fatal] FINNHUB_API_KEY es requerido -- no hay fallback, nunca se corre sin key real.");
  process.exit(1);
}

const BASE = "https://finnhub.io/api/v1";

// Nunca se loguea el token: se reemplaza ANTES de cualquier console.log,
// nunca se loguea la URL cruda.
function redactedUrl(path) {
  const url = new URL(`${BASE}${path}`);
  if (url.searchParams.has("token")) url.searchParams.set("token", "REDACTED");
  return url.toString();
}

async function callFinnhub(path) {
  const url = `${BASE}${path}&token=${encodeURIComponent(FINNHUB_KEY)}`;
  const safeUrl = redactedUrl(path);
  const startedAt = Date.now();
  let resp, text = "";
  try {
    resp = await fetch(url);
    text = await resp.text();
  } catch (e) {
    return { url: safeUrl, ok: false, status: "NETWORK_ERROR", detail: String(e && e.message || e), duration_ms: Date.now() - startedAt, json: null };
  }
  let json = null;
  try { json = JSON.parse(text); } catch { /* respuesta no-JSON */ }
  return { url: safeUrl, ok: resp.ok, status: resp.status, duration_ms: Date.now() - startedAt, json, raw_snippet: text.slice(0, 300) };
}

function isValidQuote(json) {
  return !!json && typeof json.c === "number" && json.c > 0;
}

async function main() {
  console.log(`[asml-probe] started_at=${new Date().toISOString()}`);
  const report = { started_at: new Date().toISOString(), calls: [] };

  // 1. /quote directo para los dos candidatos obvios -- exactamente el
  //    mismo endpoint/formato que usa lib/prices.js::getStockData hoy.
  for (const symbol of ["ASML.AS", "ASML"]) {
    const call = await callFinnhub(`/quote?symbol=${encodeURIComponent(symbol)}`);
    const entry = {
      step: "quote", symbol, ...call,
      quote_valid_nonzero: isValidQuote(call.json),
    };
    report.calls.push(entry);
    console.log(`[asml-probe] QUOTE symbol=${symbol} status=${call.status} valid_nonzero=${entry.quote_valid_nonzero} json=${JSON.stringify(call.json)}`);
  }

  // 2. /search -- que symbols indexa Finnhub realmente para "ASML".
  const searchCall = await callFinnhub(`/search?q=${encodeURIComponent("ASML")}`);
  report.calls.push({ step: "search", query: "ASML", ...searchCall });
  const searchResults = Array.isArray(searchCall.json?.result) ? searchCall.json.result : [];
  console.log(`[asml-probe] SEARCH q=ASML status=${searchCall.status} count=${searchCall.json?.count ?? "n/a"} results=${JSON.stringify(searchResults)}`);

  // Candidatos derivados de /search: cualquier symbol/displaySymbol que
  // contenga "ASML" -- nunca inventados, solo lo que Finnhub mismo
  // devolvio. Tope de 8 para mantener esto angosto.
  const candidateSymbols = [...new Set(
    searchResults
      .filter((r) => (r.symbol || "").toUpperCase().includes("ASML") || (r.description || "").toUpperCase().includes("ASML"))
      .map((r) => r.symbol)
      .filter(Boolean)
  )].slice(0, 8);
  console.log(`[asml-probe] candidate_symbols_from_search=${JSON.stringify(candidateSymbols)}`);

  for (const symbol of candidateSymbols) {
    if (symbol === "ASML.AS" || symbol === "ASML") continue; // ya probados arriba
    const call = await callFinnhub(`/quote?symbol=${encodeURIComponent(symbol)}`);
    const entry = { step: "quote_candidate", symbol, ...call, quote_valid_nonzero: isValidQuote(call.json) };
    report.calls.push(entry);
    console.log(`[asml-probe] QUOTE(candidate) symbol=${symbol} status=${call.status} valid_nonzero=${entry.quote_valid_nonzero} json=${JSON.stringify(call.json)}`);
  }

  // 3. /stock/profile2 para ASML.AS y ASML -- unica forma de que Finnhub
  //    mismo declare exchange/currency/name por symbol (nunca inferido).
  for (const symbol of ["ASML.AS", "ASML"]) {
    const call = await callFinnhub(`/stock/profile2?symbol=${encodeURIComponent(symbol)}`);
    report.calls.push({ step: "profile2", symbol, ...call });
    console.log(`[asml-probe] PROFILE2 symbol=${symbol} status=${call.status} json=${JSON.stringify(call.json)}`);
  }

  report.finished_at = new Date().toISOString();
  writeFileSync("asml-finnhub-probe.json", JSON.stringify(report, null, 2));
  console.log(`[asml-probe] finished_at=${report.finished_at}`);
  console.log("[asml-probe] done -- see asml-finnhub-probe.json artifact for full detail (token never included).");
}

main().catch((e) => { console.error("[fatal]", e); process.exit(1); });
