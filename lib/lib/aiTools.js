// lib/aiTools.js
// Las 12 herramientas que Moni AI puede invocar. Cada una es una funcion
// pura de Capa 1 -- consulta datos REALES (Supabase + precios en vivo) y
// devuelve el contrato estructurado de lib/toolResult.js. Nunca texto
// narrativo. Moni AI (el modelo) nunca calcula, solo interpreta lo que
// estas funciones regresan.
//
// Frescura de datos (Arquitectura v1.1, seccion 5):
// - Nivel A (precio, cambio diario, patrimonio) -- SIEMPRE en vivo, jamas
//   cacheado. source refleja el proveedor real (finnhub/coingecko).
// - Nivel B (rango 52w, market cap, fundamentales) -- cache de horas via
//   lib/marketCache.js, como ya existe en el resto de Moni Capital.

import { getStockData, getCryptoData, COINGECKO_FALLBACK_IDS } from "./prices.js";
import { ok, notFound, toolError } from "./toolResult.js";
import {
  scoreBreakdown, simulateMonthsToGoal, solveRequiredContribution,
  monthsBetweenDates, computeRebalanceDeviations, computeSystemHealth,
} from "./financialMath.js";

function round2(n) {
  return n == null ? null : Math.round(n * 100) / 100;
}

async function fetchMarketFor(supabase, ticker, type, coingeckoId, FINNHUB_KEY) {
  try {
    if (type === "stock") return { market: await getStockData(supabase, ticker, FINNHUB_KEY), source: "finnhub" };
    if (type === "crypto") {
      const id = coingeckoId || COINGECKO_FALLBACK_IDS[ticker];
      if (!id) return { market: null, source: null };
      return { market: await getCryptoData(supabase, ticker, id), source: "coingecko" };
    }
  } catch (e) {
    return { market: null, source: null, failed: true };
  }
  return { market: null, source: null };
}

async function enrichPositions(supabase, FINNHUB_KEY) {
  const [{ data: positions }, { data: thesisRows }, { data: cashMovs }] = await Promise.all([
    supabase.from("positions").select("*"),
    supabase.from("thesis").select("*"),
    supabase.from("cash_movements").select("*"),
  ]);
  const thesisByTicker = {};
  (thesisRows || []).forEach((t) => { thesisByTicker[t.ticker] = t; });
  const cashValue = (cashMovs || []).reduce(
    (a, m) => a + (m.type === "deposito" ? Number(m.amount) : -Number(m.amount)), 0
  );

  const enriched = [];
  let anyFetchFailed = false;
  for (const p of positions || []) {
    if (p.type === "cash") continue;
    const { market, failed } = await fetchMarketFor(supabase, p.ticker, p.type, p.coingecko_id, FINNHUB_KEY);
    if (failed) anyFetchFailed = true;
    const value = market ? Number(p.shares) * market.price : null;
    enriched.push({ ...p, market, value, thesis: thesisByTicker[p.ticker] || null });
  }
  return { enriched, cashValue, anyFetchFailed };
}

// ---------------------------------------------------------------------

export async function get_portfolio_summary(supabase, FINNHUB_KEY) {
  const { enriched, cashValue, anyFetchFailed } = await enrichPositions(supabase, FINNHUB_KEY);
  const withValue = enriched.filter((p) => p.value != null);
  const missing = enriched.filter((p) => p.value == null).map((p) => p.ticker);
  const stocksValue = withValue.filter((p) => p.type === "stock").reduce((a, p) => a + p.value, 0);
  const cryptoValue = withValue.filter((p) => p.type === "crypto").reduce((a, p) => a + p.value, 0);
  const patrimonio = stocksValue + cryptoValue + cashValue;

  if (patrimonio === 0 && positionsEmpty(enriched)) return notFound("supabase");
  if (anyFetchFailed && withValue.length === 0) return toolError("provider_timeout", "finnhub/coingecko");

  const invested = withValue.reduce((a, p) => a + Number(p.cost_basis), 0) + cashValue;
  return ok({
    patrimonio_total: round2(patrimonio),
    capital_invertido: round2(invested),
    ganancia_perdida: round2(patrimonio - invested),
    rendimiento_pct: invested ? round2(((patrimonio - invested) / invested) * 100) : null,
    efectivo: round2(cashValue),
    valor_acciones: round2(stocksValue),
    valor_cripto: round2(cryptoValue),
    posiciones_sin_precio_ahora: missing,
    top_5_posiciones: withValue
      .sort((a, b) => b.value - a.value)
      .slice(0, 5)
      .map((p) => ({ ticker: p.ticker, valor: round2(p.value), pct_del_patrimonio: round2((p.value / patrimonio) * 100) })),
  }, "computed");
}

function positionsEmpty(enriched) { return enriched.length === 0; }

export async function get_position(supabase, FINNHUB_KEY, ticker) {
  if (!ticker) return toolError("missing_argument", "input");
  const { data: pos } = await supabase.from("positions").select("*").eq("ticker", ticker.toUpperCase()).maybeSingle();
  if (!pos) return notFound("supabase");

  const { data: thesis } = await supabase.from("thesis").select("*").eq("ticker", ticker.toUpperCase()).maybeSingle();
  let market = null, source = "supabase";
  if (pos.type !== "cash") {
    const r = await fetchMarketFor(supabase, pos.ticker, pos.type, pos.coingecko_id, FINNHUB_KEY);
    market = r.market;
    if (r.failed) return toolError("provider_timeout", pos.type === "stock" ? "finnhub" : "coingecko");
    if (market) source = pos.type === "stock" ? "finnhub" : "coingecko";
  }
  const value = market ? Number(pos.shares) * market.price : (pos.type === "cash" ? Number(pos.cost_basis) : null);

  return ok({
    ticker: pos.ticker, nombre: pos.name, tipo: pos.type, sector: pos.sector, tema: pos.tema,
    rol_estrategico: pos.strategic_role,
    acciones: pos.shares, costo_base: Number(pos.cost_basis),
    precio_actual: market?.price ?? null,
    valor_actual: value != null ? round2(value) : null,
    ganancia: value != null ? round2(value - Number(pos.cost_basis)) : null,
    conviccion: thesis?.conviction ?? null,
  }, source);
}

export async function get_thesis(supabase, ticker) {
  if (!ticker) return toolError("missing_argument", "input");
  const { data, error } = await supabase.from("thesis").select("*").eq("ticker", ticker.toUpperCase()).maybeSingle();
  if (error) return toolError("db_error", "supabase");
  if (!data) return notFound("supabase");
  return ok({
    conviccion: data.conviction,
    por_que_la_compre: data.why_bought,
    que_tiene_de_especial: data.what_special,
    exit_thesis: data.sell_trigger,
    horizonte: data.horizon,
    riesgos: data.risks,
    ultima_revision: data.updated_at,
  }, "supabase");
}

export async function get_opportunities(supabase, FINNHUB_KEY) {
  const { enriched, anyFetchFailed } = await enrichPositions(supabase, FINNHUB_KEY);
  const { data: watchlist, error: wErr } = await supabase.from("watchlist").select("*");
  if (wErr) return toolError("db_error", "supabase");

  const scored = [];
  for (const p of enriched) {
    if (!p.market) continue;
    const b = scoreBreakdown({ price: p.market.price, low: p.market.low, high: p.market.high, changePct: p.market.changePct, conviction: p.thesis?.conviction || 0 });
    scored.push({ ticker: p.ticker, fuente: "cartera", conviccion: p.thesis?.conviction || 0, score: b.total });
  }
  for (const w of watchlist || []) {
    const { market, failed } = await fetchMarketFor(supabase, w.ticker, w.type, w.coingecko_id, FINNHUB_KEY);
    if (!market) { if (failed) continue; else continue; }
    const b = scoreBreakdown({ price: market.price, low: market.low, high: market.high, changePct: market.changePct, conviction: 0 });
    const hit = w.target_price != null && market.price <= Number(w.target_price);
    scored.push({ ticker: w.ticker, fuente: "watchlist", score: Math.min(100, b.total + (hit ? 20 : 0)), en_precio_objetivo: hit });
  }

  const result = scored.filter((o) => o.score >= 50).sort((a, b) => b.score - a.score).slice(0, 5);
  if (result.length === 0) {
    if (anyFetchFailed) return toolError("provider_timeout", "finnhub/coingecko");
    return notFound("computed"); // no es que falle -- genuinamente no hay ninguna con score alto
  }
  return ok(result, "computed");
}

export async function get_strategy_status(supabase, FINNHUB_KEY) {
  const { enriched, cashValue } = await enrichPositions(supabase, FINNHUB_KEY);
  const withValue = enriched.filter((p) => p.value != null);
  const stocksValue = withValue.filter((p) => p.type === "stock").reduce((a, p) => a + p.value, 0);
  const cryptoValue = withValue.filter((p) => p.type === "crypto").reduce((a, p) => a + p.value, 0);
  const patrimonio = stocksValue + cryptoValue + cashValue;
  if (!patrimonio) return notFound("computed");

  const sorted = [...withValue].sort((a, b) => b.value - a.value);
  const top1Pct = sorted[0] ? sorted[0].value / patrimonio : 0;
  const badges = [];
  if (top1Pct > 0.35) badges.push({ texto: "Concentración elevada", ticker: sorted[0].ticker, pct: round2(top1Pct * 100) });
  else if (top1Pct > 0.2) badges.push({ texto: "Concentración moderada", ticker: sorted[0].ticker, pct: round2(top1Pct * 100) });
  else badges.push({ texto: "Diversificación correcta" });
  if (cashValue / patrimonio < 0.05) badges.push({ texto: "Liquidez baja" });
  const iaTemas = ["IA / Cloud", "IA / Software", "Semiconductores IA", "Infraestructura IA"];
  const iaValue = withValue.filter((p) => iaTemas.includes(p.tema)).reduce((a, p) => a + p.value, 0);
  const iaPct = iaValue / patrimonio;
  if (iaPct > 0.55) badges.push({ texto: "Sobrepeso IA", pct: round2(iaPct * 100) });

  return ok({ badges, peso_posicion_1_pct: round2(top1Pct * 100) }, "computed");
}

export async function get_recent_changes(supabase) {
  const { data: snaps, error } = await supabase.from("snapshots").select("*").order("date", { ascending: true });
  if (error) return toolError("db_error", "supabase");
  if (!snaps || snaps.length < 2) return notFound("supabase");
  const baseline = snaps[snaps.length - 2];
  const last = snaps[snaps.length - 1];
  return ok({
    desde: baseline.date,
    patrimonio_antes: round2(Number(baseline.patrimonio)),
    patrimonio_hoy: round2(Number(last.patrimonio)),
    cambio: round2(Number(last.patrimonio) - Number(baseline.patrimonio)),
  }, "supabase");
}

export async function get_watchlist(supabase) {
  const { data, error } = await supabase.from("watchlist").select("*");
  if (error) return toolError("db_error", "supabase");
  if (!data || data.length === 0) return notFound("supabase");
  return ok(data.map((w) => ({
    ticker: w.ticker, nombre: w.name, tipo: w.type, estado: w.status,
    precio_objetivo: w.target_price, notas: w.notes,
  })), "supabase");
}

export async function get_journal(supabase, ticker) {
  let q = supabase.from("journal_entries").select("*").eq("archived", false).order("date", { ascending: false }).limit(10);
  if (ticker) q = q.eq("ticker", ticker.toUpperCase());
  const { data, error } = await q;
  if (error) return toolError("db_error", "supabase");
  if (!data || data.length === 0) return notFound("supabase");
  return ok(data.map((j) => ({
    fecha: j.date, ticker: j.ticker, tipo: j.type, titulo: j.title, contenido: j.content,
    conviccion_al_escribir: j.conviction_at_time, estado_al_escribir: j.confidence_state,
    resultado: j.outcome_result, leccion_aprendida: j.outcome_lesson,
  })), "supabase");
}

export async function get_wealth_summary(supabase, FINNHUB_KEY) {
  const { enriched, cashValue } = await enrichPositions(supabase, FINNHUB_KEY);
  const withValue = enriched.filter((p) => p.value != null);
  const patrimonio = withValue.reduce((a, p) => a + p.value, 0) + cashValue;
  if (!patrimonio) return notFound("computed");

  const byDim = (getKey) => {
    const map = {};
    withValue.filter((p) => p.type !== "cash").forEach((p) => {
      const k = getKey(p) || "Sin clasificar";
      map[k] = (map[k] || 0) + p.value;
    });
    return Object.entries(map).sort((a, b) => b[1] - a[1]).map(([label, value]) => ({ label, pct: round2((value / patrimonio) * 100) }));
  };

  return ok({
    por_sector: byDim((p) => p.sector),
    por_tema: byDim((p) => p.tema),
    por_rol_estrategico: byDim((p) => p.strategic_role),
  }, "computed");
}

export async function get_goal_status(supabase) {
  const { data: goals, error } = await supabase.from("goals").select("*");
  if (error) return toolError("db_error", "supabase");
  const primary = (goals || []).find((g) => g.is_primary) || (goals || [])[0];
  if (!primary) return notFound("supabase");

  const { data: posData } = await supabase.from("positions").select("cost_basis,type");
  // patrimonio aproximado solo para esta tool via snapshot mas reciente (evita recalcular todo el portafolio)
  const { data: snaps } = await supabase.from("snapshots").select("*").order("date", { ascending: false }).limit(1);
  const patrimonio = snaps?.[0] ? Number(snaps[0].patrimonio) : null;
  if (patrimonio == null) return toolError("db_error", "supabase");

  const contribution = Number(primary.monthly_contribution || 0);
  const annualReturn = Number(primary.expected_annual_return || 0);
  const target = Number(primary.target_amount);
  const monthsToGoal = simulateMonthsToGoal(patrimonio, target, contribution, annualReturn);

  let requiredContribution = null, monthsToTargetDate = null;
  if (primary.target_date) {
    monthsToTargetDate = monthsBetweenDates(new Date(), new Date(primary.target_date));
    requiredContribution = solveRequiredContribution(patrimonio, target, monthsToTargetDate, annualReturn);
  }

  return ok({
    nombre: primary.name, monto_objetivo: target, patrimonio_actual: round2(patrimonio),
    progreso_pct: round2(Math.min(100, (patrimonio / target) * 100)),
    meses_estimados_con_supuestos_actuales: monthsToGoal,
    fecha_objetivo: primary.target_date,
    aportacion_necesaria_para_fecha_objetivo: requiredContribution,
    aportacion_mensual_actual_asumida: contribution,
    rendimiento_anual_esperado_pct: annualReturn,
  }, "computed");
}

export async function get_system_health(supabase, FINNHUB_KEY) {
  const { enriched, cashValue } = await enrichPositions(supabase, FINNHUB_KEY);
  const withValue = enriched.filter((p) => p.value != null);
  const patrimonio = withValue.reduce((a, p) => a + p.value, 0) + cashValue;
  if (!patrimonio) return notFound("computed");

  const sorted = [...withValue].sort((a, b) => b.value - a.value);
  const top1Pct = sorted[0] ? sorted[0].value / patrimonio : 0;

  const { data: goals } = await supabase.from("goals").select("*");
  const primaryGoal = (goals || []).find((g) => g.is_primary) || (goals || [])[0] || null;

  const { data: targets } = await supabase.from("rebalance_targets").select("*");
  const rebalanceDeviations = computeRebalanceDeviations(targets || [], withValue, cashValue, patrimonio);

  const { count: openCount } = await supabase.from("decisions").select("id", { count: "exact", head: true }).eq("status", "abierta");

  const health = computeSystemHealth({
    positionsWithThesis: enriched, top1Pct, cashValue, patrimonio, primaryGoal,
    rebalanceDeviations, openDecisionsCount: openCount || 0,
  });

  return ok({ puntaje: health.score, factores: health.factors }, "computed");
}

export async function get_decision_queue(supabase) {
  const { data, error } = await supabase.from("decisions").select("*").eq("status", "abierta").order("priority", { ascending: true });
  if (error) return toolError("db_error", "supabase");
  if (!data || data.length === 0) return notFound("supabase");
  return ok(data.map((d) => ({
    tipo: d.type, ticker: d.ticker, prioridad: d.priority, titulo: d.title, detalle: d.detail, creada: d.created_at,
  })), "supabase");
}

// ---------------------------------------------------------------------

export const TOOL_DEFINITIONS = [
  { name: "get_portfolio_summary", description: "Patrimonio total, capital invertido, ganancia, rendimiento, efectivo, valor en acciones/cripto y las 5 posiciones más grandes.", input_schema: { type: "object", properties: {} } },
  { name: "get_position", description: "Detalle de una posición específica: acciones, costo base, precio actual, ganancia y convicción declarada.", input_schema: { type: "object", properties: { ticker: { type: "string" } }, required: ["ticker"] } },
  { name: "get_thesis", description: "La Investment Thesis de un ticker: por qué se compró, qué tiene de especial, Exit Thesis (criterio de salida), horizonte y riesgos.", input_schema: { type: "object", properties: { ticker: { type: "string" } }, required: ["ticker"] } },
  { name: "get_opportunities", description: "Lista de oportunidades (dentro y fuera de la cartera) con Opportunity Score >= 50.", input_schema: { type: "object", properties: {} } },
  { name: "get_strategy_status", description: "Estado de la estrategia: concentración, liquidez, sobrepeso temático.", input_schema: { type: "object", properties: {} } },
  { name: "get_recent_changes", description: "Qué cambió en el patrimonio desde el snapshot anterior.", input_schema: { type: "object", properties: {} } },
  { name: "get_watchlist", description: "Los activos en watchlist, con su estado (investigando/vigilando/listo), precio objetivo y notas.", input_schema: { type: "object", properties: {} } },
  { name: "get_journal", description: "Entradas del Investment Journal, opcionalmente filtradas por ticker.", input_schema: { type: "object", properties: { ticker: { type: "string" } } } },
  { name: "get_wealth_summary", description: "Diversificación del patrimonio por sector, tema de inversión y rol estratégico.", input_schema: { type: "object", properties: {} } },
  { name: "get_goal_status", description: "Estado de la meta patrimonial principal: progreso, fecha estimada, aportación necesaria.", input_schema: { type: "object", properties: {} } },
  { name: "get_system_health", description: "Puntaje de claridad del sistema (0-100) y qué factores lo afectan.", input_schema: { type: "object", properties: {} } },
  { name: "get_decision_queue", description: "Decisiones abiertas sin revisar, ordenadas por prioridad.", input_schema: { type: "object", properties: {} } },
];

export async function executeTool(name, input, supabase, FINNHUB_KEY) {
  try {
    switch (name) {
      case "get_portfolio_summary": return await get_portfolio_summary(supabase, FINNHUB_KEY);
      case "get_position": return await get_position(supabase, FINNHUB_KEY, input.ticker);
      case "get_thesis": return await get_thesis(supabase, input.ticker);
      case "get_opportunities": return await get_opportunities(supabase, FINNHUB_KEY);
      case "get_strategy_status": return await get_strategy_status(supabase, FINNHUB_KEY);
      case "get_recent_changes": return await get_recent_changes(supabase);
      case "get_watchlist": return await get_watchlist(supabase);
      case "get_journal": return await get_journal(supabase, input.ticker);
      case "get_wealth_summary": return await get_wealth_summary(supabase, FINNHUB_KEY);
      case "get_goal_status": return await get_goal_status(supabase);
      case "get_system_health": return await get_system_health(supabase, FINNHUB_KEY);
      case "get_decision_queue": return await get_decision_queue(supabase);
      default: return toolError("unknown_tool", "gateway");
    }
  } catch (e) {
    return toolError("tool_exception", "gateway");
  }
}
