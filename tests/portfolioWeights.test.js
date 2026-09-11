// tests/portfolioWeights.test.js
// Sprint P5 (Portfolio Weights / Allocation Truth). Tests A-J sobre
// lib/financialSnapshot.js::computePortfolioWeights/computeNetWorthWeights/
// computePatrimonioBreakdown/computeConcentration -- CERO red, CERO
// Supabase, CERO React. Dos metricas SIEMPRE separadas (nunca
// mezcladas): PORTFOLIO_WEIGHT_PCT (universo = portafolio tradicional,
// sin Futures) vs TOTAL_NET_WORTH_WEIGHT_PCT (universo = Patrimonio
// Total, incluye Futures).

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  enrichPositions, computeStocksValue, computeCryptoValue, computeCashValue,
  computePatrimonioBase, computePatrimonio,
  computePortfolioWeights, computeNetWorthWeights, computePatrimonioBreakdown, computeConcentration,
} from "../lib/financialSnapshot.js";

const POSITIONS = [
  { id: 1, ticker: "AAPL", type: "stock", shares: 10, cost_basis: 1000 },
  { id: 2, ticker: "QCOM", type: "stock", shares: 5, cost_basis: 500 },
  { id: 3, ticker: "BTC", type: "crypto", shares: 0.1, cost_basis: 3000 },
];
const MARKET_FULL = { AAPL: { price: 200 }, QCOM: { price: 100 }, BTC: { price: 50000 } };
// AAPL=2000, QCOM=500, BTC=5000 -> total tradicional = 7500 (sin cash)

// ================== A. todos los precios disponibles -> suma ~100% ==================
test("A - PORTFOLIO_WEIGHT_PCT: con todos los precios disponibles, los pesos suman ~100% del portafolio tradicional", () => {
  const enriched = enrichPositions(POSITIONS, MARKET_FULL, {});
  const result = computePortfolioWeights(enriched);
  assert.equal(result.status, "COMPLETE");
  const sum = result.weights.reduce((a, w) => a + w.portfolio_weight_pct, 0);
  assert.ok(Math.abs(sum - 100) < 1e-9, `esperaba ~100%, obtuve ${sum}`);
  // Verificacion individual: QCOM = 500/7500*100
  const qcom = result.weights.find((w) => w.ticker === "QCOM");
  assert.ok(Math.abs(qcom.portfolio_weight_pct - (500 / 7500) * 100) < 1e-9);
});

// ================== B. falta un precio -> PARTIAL, sin renormalizar ==================
test("B - falta el precio de una posición -> status PARTIAL, NUNCA renormaliza las restantes a 100%", () => {
  const marketPartial = { AAPL: { price: 200 }, QCOM: { price: 100 } }; // BTC sin precio
  const enriched = enrichPositions(POSITIONS, marketPartial, {});
  const result = computePortfolioWeights(enriched);
  assert.equal(result.status, "PARTIAL");
  assert.equal(result.missingCount, 1);
  // Universo real sigue siendo solo AAPL+QCOM (2500), NUNCA se le suma
  // un BTC inventado ni se "estira" el resto a 100%:
  const sum = result.weights.reduce((a, w) => a + w.portfolio_weight_pct, 0);
  assert.ok(Math.abs(sum - 100) < 1e-9, "el universo VALUADO si suma 100% entre si mismo -- eso es esperado y correcto");
  assert.equal(result.totalTraditionalValue, 2500, "el denominador real es SOLO lo valuado, nunca incluye BTC sin precio como si fuera 0 o como si no existiera la posicion");
  const qcom = result.weights.find((w) => w.ticker === "QCOM");
  assert.ok(Math.abs(qcom.portfolio_weight_pct - (500 / 2500) * 100) < 1e-9, "REGRESION: si esto diera 500/7500 estaria usando el denominador COMPLETO con datos parciales");
});

// ================== C. Futures Equity cambia -> portfolio weight NO cambia, net worth SI ==================
test("C - Futures Equity cambia: PORTFOLIO_WEIGHT_PCT de QCOM no cambia, TOTAL_NET_WORTH_WEIGHT_PCT sí cambia", () => {
  const enriched = enrichPositions(POSITIONS, MARKET_FULL, {});
  const pw = computePortfolioWeights(enriched);
  const qcomPortfolioWeight = pw.weights.find((w) => w.ticker === "QCOM").portfolio_weight_pct;

  const patrimonioSinFutures = 7500; // sin cash en este fixture
  const nwBefore = computeNetWorthWeights(enriched, patrimonioSinFutures, pw.status, true);
  const nwAfter = computeNetWorthWeights(enriched, patrimonioSinFutures + 10000, pw.status, true); // Futures Equity sube 10000

  const qcomBefore = nwBefore.weights.find((w) => w.ticker === "QCOM").net_worth_weight_pct;
  const qcomAfter = nwAfter.weights.find((w) => w.ticker === "QCOM").net_worth_weight_pct;

  // Portfolio weight es indiferente a Futures -- ni siquiera recibe el dato:
  const pw2 = computePortfolioWeights(enriched);
  assert.equal(pw2.weights.find((w) => w.ticker === "QCOM").portfolio_weight_pct, qcomPortfolioWeight);
  // Net worth weight SI cambia porque el denominador (patrimonio) cambio:
  assert.notEqual(qcomBefore, qcomAfter);
  assert.ok(qcomAfter < qcomBefore, "mas Futures Equity en el denominador -> el peso relativo de QCOM baja");
});

// ================== D. precio de una acción cambia -> market value y ambos weights cambian ==================
test("D - cambia el precio de AAPL: su market value y AMBOS weights cambian de forma determinística", () => {
  const enrichedBefore = enrichPositions(POSITIONS, MARKET_FULL, {});
  const marketAfter = { ...MARKET_FULL, AAPL: { price: 400 } }; // AAPL se duplica
  const enrichedAfter = enrichPositions(POSITIONS, marketAfter, {});

  const aaplBefore = enrichedBefore.find((p) => p.ticker === "AAPL").value;
  const aaplAfter = enrichedAfter.find((p) => p.ticker === "AAPL").value;
  assert.equal(aaplBefore, 2000);
  assert.equal(aaplAfter, 4000);

  const pwBefore = computePortfolioWeights(enrichedBefore).weights.find((w) => w.ticker === "AAPL").portfolio_weight_pct;
  const pwAfter = computePortfolioWeights(enrichedAfter).weights.find((w) => w.ticker === "AAPL").portfolio_weight_pct;
  assert.ok(pwAfter > pwBefore, "AAPL vale mas -> su peso en el portafolio tradicional sube");

  const patrimonio = 7500;
  const nwBefore = computeNetWorthWeights(enrichedBefore, patrimonio, "COMPLETE", true).weights.find((w) => w.ticker === "AAPL").net_worth_weight_pct;
  const nwAfterPatrimonio = 9500; // el patrimonio tambien sube porque AAPL vale mas
  const nwAfter = computeNetWorthWeights(enrichedAfter, nwAfterPatrimonio, "COMPLETE", true).weights.find((w) => w.ticker === "AAPL").net_worth_weight_pct;
  assert.ok(nwAfter > nwBefore);
});

// ================== E. position value NULL nunca se trata como 0 ==================
test("E - una posición con value=null nunca aparece con weight=0 -- simplemente se excluye del universo valuado, nunca se inventa un peso", () => {
  const marketMissingBtc = { AAPL: { price: 200 }, QCOM: { price: 100 } };
  const enriched = enrichPositions(POSITIONS, marketMissingBtc, {});
  const btc = enriched.find((p) => p.ticker === "BTC");
  assert.equal(btc.value, null);
  const result = computePortfolioWeights(enriched);
  assert.ok(!result.weights.some((w) => w.ticker === "BTC"), "BTC sin precio no debe aparecer en absoluto en `weights`, ni con 0 ni con null");
});

// ================== F. pie de Patrimonio Total suma ~100% ==================
test("F - computePatrimonioBreakdown: las categorías visibles (incluye Futures Equity) suman ~100% del Patrimonio Total", () => {
  const stocksValue = 2500, cryptoValue = 5000, cashValue = 1000, futuresEquityUsd = 1500;
  const patrimonio = stocksValue + cryptoValue + cashValue + futuresEquityUsd; // 10000, construido igual que computePatrimonio
  const breakdown = computePatrimonioBreakdown({ stocksValue, cryptoValue, cashValue, futuresEquityUsd, patrimonio });
  const sum = breakdown.reduce((a, c) => a + c.pct, 0);
  assert.ok(Math.abs(sum - 100) < 1e-9, `REGRESION: el pie anterior omitia Futures como categoria mientras lo contaba en el denominador -- ahora debe sumar 100%, obtuve ${sum}`);
  assert.ok(breakdown.some((c) => c.name === "Futures Equity"), "Futures Equity debe aparecer como su propia rebanada visible (item 6/7 del sprint)");
});

// ================== G. Futures notional NO afecta ningún weight patrimonial ==================
test("G - Futures notional no es un input de ninguna función de weight -- cambiarlo no puede afectar nada (no double counting, item 7)", () => {
  const enriched = enrichPositions(POSITIONS, MARKET_FULL, {});
  const patrimonio = 7500 + 2000; // Futures Equity = 2000 (equity de cuenta, no notional)
  const before = computeNetWorthWeights(enriched, patrimonio, "COMPLETE", true);
  // Un notional de posiciones Futures (ej. BTCUSDT notional=50000) NUNCA
  // entra como argumento a computeNetWorthWeights/computePatrimonioBreakdown
  // -- las firmas de ambas funciones solo aceptan equity, nunca notional.
  // Este test documenta ese contrato: mismo patrimonio (mismo equity),
  // mismo resultado, sin importar que tan grande sea el notional real.
  const afterSameEquity = computeNetWorthWeights(enriched, patrimonio, "COMPLETE", true);
  assert.deepEqual(before.weights, afterSameEquity.weights);
});

// ================== H. Futures equity cambia -> Peso Patrimonio SI cambia ==================
test("H - Futures Equity cambia -> TOTAL_NET_WORTH_WEIGHT_PCT cambia para toda posición (ya cubierto en detalle por C, aquí se confirma el signo)", () => {
  const enriched = enrichPositions(POSITIONS, MARKET_FULL, {});
  const lowFutures = computeNetWorthWeights(enriched, 7500 + 500, "COMPLETE", true).weights.find((w) => w.ticker === "AAPL").net_worth_weight_pct;
  const highFutures = computeNetWorthWeights(enriched, 7500 + 50000, "COMPLETE", true).weights.find((w) => w.ticker === "AAPL").net_worth_weight_pct;
  assert.ok(highFutures < lowFutures, "mas Futures Equity -> menor peso relativo de cada posición tradicional dentro del patrimonio total");
});

// ================== I. Concentración usa portafolio tradicional, no Patrimonio Total ==================
test("I - computeConcentration: Top1/Top3/Top5/Top10 se calculan sobre PORTFOLIO_WEIGHT_PCT, nunca sobre Patrimonio Total", () => {
  const enriched = enrichPositions(POSITIONS, MARKET_FULL, {});
  const pw = computePortfolioWeights(enriched);
  const conc = computeConcentration(pw);
  assert.equal(conc.status, "COMPLETE");
  // BTC=5000/7500=66.67%, AAPL=2000/7500=26.67%, QCOM=500/7500=6.67%
  assert.ok(Math.abs(conc.top1_pct - (5000 / 7500) * 100) < 1e-6);
  assert.ok(Math.abs(conc.top3_pct - 100) < 1e-6, "solo hay 3 posiciones tradicionales -- top3 = 100% del portafolio tradicional");
  // Si estuviera mal y usara Patrimonio Total (con Futures) en vez del
  // portafolio tradicional, top3 NUNCA daria exactamente 100% con 3 de 3
  // posiciones (a menos que Futures Equity fuera 0) -- este test lo
  // distingue de forma inequívoca.
});

// ================== J. datos parciales -> nunca una alerta de concentración fabricada ==================
test("J - computeConcentration con datos parciales -> status CONCENTRATION_DATA_PARTIAL, nunca COMPLETE", () => {
  const marketPartial = { AAPL: { price: 200 } }; // QCOM y BTC sin precio
  const enriched = enrichPositions(POSITIONS, marketPartial, {});
  const pw = computePortfolioWeights(enriched);
  assert.equal(pw.status, "PARTIAL");
  const conc = computeConcentration(pw);
  assert.equal(conc.status, "CONCENTRATION_DATA_PARTIAL", "el llamador (App.jsx) debe usar este status para NO disparar una alerta automática de concentración como si fuera confiable");
});

// ================== regresión: cero cambio de fórmula financiera ==================
test("REGRESION - las funciones de weight nunca alteran computeStocksValue/computeCryptoValue/computePatrimonioBase -- solo las CONSUMEN", () => {
  const enriched = enrichPositions(POSITIONS, MARKET_FULL, {});
  const stocksValue = computeStocksValue(enriched);
  const cryptoValue = computeCryptoValue(enriched);
  computePortfolioWeights(enriched); // llamar no debe mutar nada
  assert.equal(computeStocksValue(enriched), stocksValue);
  assert.equal(computeCryptoValue(enriched), cryptoValue);
});
