// tests/aiTools.test.js
// Pruebas deterministas de las 12 herramientas de Moni AI. CERO llamadas a
// un modelo de IA (eso no se puede probar gratis, ver Architecture v1.1
// seccion 16). CERO llamadas a Finnhub/CoinGecko reales -- se prueban
// solo los caminos que no dependen de precios en vivo, con datos de
// prueba (fixtures) inyectados via un mock de Supabase.
//
// Correr con: node tests/aiTools.test.js

import {
  get_thesis, get_watchlist, get_journal, get_decision_queue,
  get_portfolio_summary, TOOL_DEFINITIONS,
} from "../lib/aiTools.js";
import { ok, partial, notFound, toolError } from "../lib/toolResult.js";

// --- Mock minimo de Supabase: soporta select/eq/order/limit encadenados,
// y es "thenable" para que `await query` funcione igual que con el cliente real.
function mockSupabase(fixtures) {
  function makeQuery(table) {
    let rows = [...(fixtures[table] || [])];
    const filters = [];
    let limitN = null;
    const builder = {
      select() { return builder; },
      eq(col, val) { filters.push([col, val]); return builder; },
      order() { return builder; },
      limit(n) { limitN = n; return builder; },
      async maybeSingle() {
        let f = applyFilters(rows, filters);
        return { data: f[0] || null, error: null };
      },
      then(resolve) {
        let f = applyFilters(rows, filters);
        if (limitN != null) f = f.slice(0, limitN);
        resolve({ data: f, error: null, count: f.length });
      },
    };
    return builder;
  }
  function applyFilters(rows, filters) {
    return rows.filter((r) => filters.every(([c, v]) => r[c] === v));
  }
  return { from: (table) => makeQuery(table) };
}

let passed = 0, failed = 0;
function assert(cond, label) {
  if (cond) { passed++; console.log(`  ok  ${label}`); }
  else { failed++; console.log(`  FAIL  ${label}`); }
}

function hasContract(result) {
  return "status" in result && "data" in result && "asOf" in result && "source" in result;
}

async function run() {
  console.log("Moni AI -- tests deterministas de tools\n");

  // 1. get_thesis: existe
  {
    const supabase = mockSupabase({ thesis: [{ ticker: "ORCL", conviction: 5, why_bought: "x", updated_at: "2026-01-01" }] });
    const r = await get_thesis(supabase, "ORCL");
    assert(hasContract(r), "get_thesis: contrato correcto");
    assert(r.status === "ok", "get_thesis: status ok cuando existe");
    assert(r.data.conviccion === 5, "get_thesis: datos correctos, no inventados");
  }

  // 2. get_thesis: no existe -> not_found, NUNCA inventa un valor
  {
    const supabase = mockSupabase({ thesis: [] });
    const r = await get_thesis(supabase, "ZZZZ");
    assert(r.status === "not_found", "get_thesis: not_found cuando no existe (nunca inventa)");
    assert(r.data === null, "get_thesis: data es null en not_found");
  }

  // 3. get_thesis: sin ticker -> error de argumento, no un intento silencioso
  {
    const supabase = mockSupabase({ thesis: [] });
    const r = await get_thesis(supabase, undefined);
    assert(r.status === "error", "get_thesis: error si falta el ticker");
  }

  // 4. get_watchlist: vacio -> not_found
  {
    const supabase = mockSupabase({ watchlist: [] });
    const r = await get_watchlist(supabase);
    assert(r.status === "not_found", "get_watchlist: not_found si esta vacia");
  }

  // 5. get_watchlist: con datos -> mapea status correctamente
  {
    const supabase = mockSupabase({ watchlist: [{ ticker: "NU", name: "Nu Holdings", type: "stock", status: "vigilando", target_price: 12 }] });
    const r = await get_watchlist(supabase);
    assert(r.status === "ok", "get_watchlist: ok con datos");
    assert(r.data[0].estado === "vigilando", "get_watchlist: campo estado mapeado correctamente");
  }

  // 6. get_journal: filtra por ticker y excluye archivadas
  {
    const supabase = mockSupabase({
      journal_entries: [
        { date: "2026-01-01", ticker: "ORCL", type: "Reflexión", title: "A", content: "a", archived: false },
        { date: "2026-01-02", ticker: "MSFT", type: "Reflexión", title: "B", content: "b", archived: false },
        { date: "2026-01-03", ticker: "ORCL", type: "Reflexión", title: "C", content: "c", archived: true },
      ],
    });
    const r = await get_journal(supabase, "ORCL");
    assert(r.status === "ok", "get_journal: ok con datos filtrados");
    assert(r.data.length === 1, "get_journal: excluye archivadas y filtra por ticker");
    assert(r.data[0].titulo === "A", "get_journal: no mezcla entradas de otros tickers");
  }

  // 7. get_journal: sin resultados -> not_found, no un array vacio disfrazado de exito
  {
    const supabase = mockSupabase({ journal_entries: [] });
    const r = await get_journal(supabase);
    assert(r.status === "not_found", "get_journal: not_found si no hay entradas");
  }

  // 8. get_decision_queue: solo decisiones abiertas
  {
    const supabase = mockSupabase({
      decisions: [
        { type: "oportunidad", ticker: "ORCL", priority: "alta", title: "X", status: "abierta" },
        { type: "oportunidad", ticker: "MSFT", priority: "media", title: "Y", status: "revisada" },
      ],
    });
    const r = await get_decision_queue(supabase);
    assert(r.status === "ok", "get_decision_queue: ok");
    assert(r.data.length === 1, "get_decision_queue: solo trae status=abierta");
  }

  // 9. get_portfolio_summary: sin posiciones -> not_found (nunca inventa un patrimonio de $0 como si fuera un dato real)
  {
    const supabase = mockSupabase({ positions: [], thesis: [], cash_movements: [] });
    const r = await get_portfolio_summary(supabase, "fake_key");
    assert(r.status === "not_found", "get_portfolio_summary: not_found sin posiciones");
  }

  // 10. Contrato global: TODAS las definiciones de tools tienen name + description + input_schema
  {
    const allValid = TOOL_DEFINITIONS.every((t) => t.name && t.description && t.input_schema);
    assert(allValid, "TOOL_DEFINITIONS: las 12 tools tienen definicion completa");
    assert(TOOL_DEFINITIONS.length === 12, `TOOL_DEFINITIONS: son 12 herramientas (encontradas: ${TOOL_DEFINITIONS.length})`);
  }

  // 11. Contrato de 4 estados (Architecture v1.1.1): cada helper produce la forma correcta.
  // NOTA: get_portfolio_summary en estado "partial" real depende de
  // fetchMarketForAI (red en vivo) y no se puede probar aqui sin inyeccion
  // de dependencias -- se prueba la FORMA del contrato directamente contra
  // los helpers de toolResult.js, que es lo que garantiza que ninguna tool
  // pueda inventarse un shape distinto.
  {
    const okResult = ok({ x: 1 }, "computed");
    assert(okResult.status === "ok" && okResult.data.x === 1 && okResult.completeness === undefined, "toolResult.ok: forma correcta, sin completeness");

    const partialResult = partial({ x: 1 }, { coveragePct: 80, missingTickers: ["BTC"] }, "computed");
    assert(partialResult.status === "partial", "toolResult.partial: status correcto");
    assert(partialResult.completeness.coveragePct === 80, "toolResult.partial: coveragePct presente");
    assert(partialResult.completeness.missingTickers.includes("BTC"), "toolResult.partial: missingTickers presente");
    assert(partialResult.data.x === 1, "toolResult.partial: el dato real sigue disponible, no se oculta");

    const notFoundResult = notFound("supabase");
    assert(notFoundResult.status === "not_found" && notFoundResult.data === null, "toolResult.notFound: forma correcta, data null");

    const errorResult = toolError("provider_timeout", "finnhub");
    assert(errorResult.status === "error" && errorResult.errorCode === "provider_timeout", "toolResult.toolError: forma correcta, con errorCode");

    const allStatuses = new Set([okResult.status, partialResult.status, notFoundResult.status, errorResult.status]);
    assert(allStatuses.size === 4, "Contrato: los 4 estados son mutuamente distintos (ok/partial/not_found/error)");
  }

  console.log(`\n${passed} pasaron, ${failed} fallaron`);
  if (failed > 0) process.exit(1);
}

run();
