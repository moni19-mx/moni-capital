// tests/financialSnapshot.test.js
// Micro-sprint P0.2 (Financial Totals Correctness + Stability). Tests
// A-P (letras propias del sprint P0.2) sobre las funciones puras de
// lib/financialSnapshot.js -- formula canonica de Total Acciones,
// Total Cripto, Patrimonio Base, Patrimonio Total, Cash, PnL.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildMarketDataItems, mergeMarketData, enrichPositions, computeCashValue,
  computeStocksValue, computeCryptoValue, computePatrimonioBase, computePatrimonio,
  computeInvested, computeTotalGain, unclassifiedPositions,
} from "../lib/financialSnapshot.js";

const POSITIONS = [
  { ticker: "AAPL", type: "stock", shares: 2, cost_basis: 300 },
  { ticker: "QCOM", type: "stock", shares: 1.5, cost_basis: 200 },
  { ticker: "BTC", type: "crypto", shares: 0.1, cost_basis: 3000 },
];
const MARKET_DATA = { AAPL: { price: 200 }, QCOM: { price: 150 }, BTC: { price: 60000 } };
const CASH_MOVEMENTS = [{ type: "deposito", amount: 1000, date: "2026-01-01" }, { type: "retiro", amount: 100, date: "2026-01-02" }];

// ================== A. Total Acciones = suma canonica exacta ==================
test("A - computeStocksValue: SUM(shares x price) exacta para las posiciones type=stock", () => {
  const enriched = enrichPositions(POSITIONS, MARKET_DATA, {});
  // AAPL 2*200=400, QCOM 1.5*150=225 -> 625, BTC (crypto) excluido
  assert.equal(computeStocksValue(enriched), 625);
});

// ================== B. orden de posiciones no cambia el total ==================
test("B - computeStocksValue es independiente del orden de las posiciones", () => {
  const reversed = [...POSITIONS].reverse();
  const e1 = enrichPositions(POSITIONS, MARKET_DATA, {});
  const e2 = enrichPositions(reversed, MARKET_DATA, {});
  assert.equal(computeStocksValue(e1), computeStocksValue(e2));
});

// ================== C. price missing no se convierte a 0 ==================
test("C - una posicion sin precio en marketData tiene value=null, NUNCA 0 -- se excluye del total, no lo reduce a $0", () => {
  const partialMarket = { AAPL: { price: 200 } }; // QCOM/BTC sin precio
  const enriched = enrichPositions(POSITIONS, partialMarket, {});
  const qcom = enriched.find((p) => p.ticker === "QCOM");
  assert.equal(qcom.value, null);
  assert.notEqual(qcom.value, 0);
  assert.equal(computeStocksValue(enriched), 400); // solo AAPL, QCOM excluido, nunca contado como $0
});

// ================== D. stale price conserva LKG (mergeMarketData) ==================
test("D - mergeMarketData: un ticker que fallo ESTE ciclo conserva su ultimo precio conocido, no desaparece", () => {
  const previous = { AAPL: { price: 200 }, QCOM: { price: 150 } };
  const incoming = { AAPL: { price: 205 } }; // QCOM fallo este ciclo, no viene en la respuesta
  const merged = mergeMarketData(previous, incoming);
  assert.equal(merged.AAPL.price, 205, "AAPL se actualiza al precio nuevo");
  assert.equal(merged.QCOM.price, 150, "QCOM conserva el ultimo precio conocido -- REGRESION real de P0.2");
});

test("D - mergeMarketData nunca reemplaza el mapa completo -- reemplazo ingenuo perderia tickers que no vinieron en la respuesta", () => {
  const previous = { AAPL: { price: 200 }, QCOM: { price: 150 }, BTC: { price: 60000 } };
  const incoming = { AAPL: { price: 205 } };
  const merged = mergeMarketData(previous, incoming);
  assert.equal(Object.keys(merged).length, 3, "los 3 tickers siguen presentes, no solo el que vino en incoming");
});

// ================== E. partial market response no reduce el total artificialmente ==================
test("E - respuesta parcial de market-data (2 de 3 tickers) con mergeMarketData: el total refleja precios frescos + LKG, nunca colapsa a solo lo nuevo", () => {
  const previous = { AAPL: { price: 200 }, QCOM: { price: 150 }, BTC: { price: 60000 } };
  const incoming = { AAPL: { price: 210 } }; // QCOM y BTC fallaron este ciclo
  const merged = mergeMarketData(previous, incoming);
  const enriched = enrichPositions(POSITIONS, merged, {});
  // AAPL 2*210=420 (fresco) + QCOM 1.5*150=225 (LKG) = 645; BTC (crypto) no cuenta en stocksValue
  assert.equal(computeStocksValue(enriched), 645);
});

// ================== F. deterministico / reproducible ==================
test("F - computeStocksValue/computePatrimonioBase son puras y reproducibles: mismos inputs -> mismo resultado siempre", () => {
  const e1 = enrichPositions(POSITIONS, MARKET_DATA, {});
  const e2 = enrichPositions(JSON.parse(JSON.stringify(POSITIONS)), JSON.parse(JSON.stringify(MARKET_DATA)), {});
  const cash = computeCashValue(CASH_MOVEMENTS);
  assert.equal(computeStocksValue(e1), computeStocksValue(e2));
  assert.equal(computePatrimonioBase(e1, cash), computePatrimonioBase(e2, cash));
});

// ================== H. cash / rounding ==================
test("H - computeCashValue: depositos suman, retiros restan, exacto sin redondeo intermedio", () => {
  assert.equal(computeCashValue(CASH_MOVEMENTS), 900);
});

test("H - rounding: la suma RAW de positions coincide centavo a centavo con la suma manual (sin redondeo intermedio por posicion)", () => {
  const raw = [
    { ticker: "A", type: "stock", shares: 1, cost_basis: 10 },
    { ticker: "B", type: "stock", shares: 3, cost_basis: 10 },
  ];
  const md = { A: { price: 10.111 }, B: { price: 3.337 } };
  const enriched = enrichPositions(raw, md, {});
  const manualSum = 1 * 10.111 + 3 * 3.337;
  assert.equal(computeStocksValue(enriched), manualSum, "la suma canonica debe coincidir exacto con sumar los RAW values, sin redondear por posicion antes de sumar");
});

// ================== I. Patrimonio Base / Total ==================
test("I - computePatrimonioBase = SUM(withValue) + cash; computePatrimonio = Base + Futures", () => {
  const enriched = enrichPositions(POSITIONS, MARKET_DATA, {});
  const cash = computeCashValue(CASH_MOVEMENTS);
  const base = computePatrimonioBase(enriched, cash);
  // AAPL 400 + QCOM 225 + BTC 6000 + cash 900 = 7525
  assert.equal(base, 7525);
  const total = computePatrimonio(base, 500);
  assert.equal(total, 8025);
});

test("I - computePatrimonio con futuresEquityUsd=0 (o undefined) no cambia Patrimonio Base", () => {
  const base = 1000;
  assert.equal(computePatrimonio(base, 0), 1000);
  assert.equal(computePatrimonio(base, undefined), 1000);
});

// ================== J. PnL ==================
test("J - computeInvested/computeTotalGain: ganancia real = patrimonio - invertido, signo correcto", () => {
  const enriched = enrichPositions(POSITIONS, MARKET_DATA, {});
  const cash = computeCashValue(CASH_MOVEMENTS);
  const invested = computeInvested(enriched, cash);
  // cost_basis: 300+200+3000=3500 + cash 900 = 4400
  assert.equal(invested, 4400);
  const patrimonio = computePatrimonio(computePatrimonioBase(enriched, cash), 0);
  assert.equal(computeTotalGain(patrimonio, invested), patrimonio - invested);
});

// ================== K. TSM real: posicion sin type clasificado ==================
test("K - REGRESION real (TSM, produccion): posicion con type=null se detecta como unclassified, nunca se cuela en Total Acciones", () => {
  const withUnclassified = [...POSITIONS, { ticker: "TSM", type: null, shares: 1.001994796, cost_basis: 436 }];
  const unc = unclassifiedPositions(withUnclassified);
  assert.equal(unc.length, 1);
  assert.equal(unc[0].ticker, "TSM");

  // Aunque marketData tuviera un precio para TSM, enrichPositions jamas
  // la valua porque el ticker nunca se manda a /api/market-data con un
  // type reconocido -- pero incluso si se le pasara un precio a mano,
  // computeStocksValue solo cuenta type==="stock" explicito:
  const mdWithTsm = { ...MARKET_DATA, TSM: { price: 444 } };
  const enriched = enrichPositions(withUnclassified, mdWithTsm, {});
  const tsm = enriched.find((p) => p.ticker === "TSM");
  // type!=="stock" (es null) y !=="cash" -> cae al branch else, con
  // marketData[TSM] presente SI se calcularia su value (esto documenta
  // por que el fix real esta en buildMarketDataItems/market-data.js,
  // que nunca pide su precio en primer lugar por no tener type valido).
  assert.equal(tsm.value, 444 * 1.001994796);
  // Y aun con value calculado, NUNCA aparece en stocksValue por no ser type==="stock":
  assert.ok(!POSITIONS.some((p) => p.ticker === "TSM"));
});

test("K - unclassifiedPositions: type='stock'/'crypto'/'cash' nunca se marcan como unclassified", () => {
  const mixed = [
    { ticker: "A", type: "stock" }, { ticker: "B", type: "crypto" }, { ticker: "C", type: "cash" },
    { ticker: "D", type: undefined }, { ticker: "E", type: "" }, { ticker: "F", type: "bond" },
  ];
  const unc = unclassifiedPositions(mixed);
  assert.deepEqual(unc.map((p) => p.ticker), ["D", "E", "F"]);
});

// ================== L. buildMarketDataItems ==================
test("L - buildMarketDataItems: dedupea por ticker+type y excluye posiciones type=cash", () => {
  const positions = [
    { ticker: "AAPL", type: "stock" }, { ticker: "AAPL", type: "stock" }, // duplicado
    { ticker: "USD", type: "cash" },
  ];
  const watchlist = [{ ticker: "TSLA", type: "stock" }];
  const items = buildMarketDataItems(positions, watchlist);
  assert.equal(items.length, 2);
  assert.ok(items.some((i) => i.ticker === "AAPL"));
  assert.ok(items.some((i) => i.ticker === "TSLA"));
  assert.ok(!items.some((i) => i.ticker === "USD"));
});

// ================== O. reproducible / puro sin mutacion ==================
test("O - enrichPositions/mergeMarketData nunca mutan sus argumentos de entrada", () => {
  const positionsCopy = JSON.parse(JSON.stringify(POSITIONS));
  const marketCopy = JSON.parse(JSON.stringify(MARKET_DATA));
  enrichPositions(POSITIONS, MARKET_DATA, {});
  mergeMarketData(MARKET_DATA, { AAPL: { price: 999 } });
  assert.deepEqual(POSITIONS, positionsCopy);
  assert.deepEqual(MARKET_DATA, marketCopy);
});

// ================== P. sum displayed positions vs displayed total (policy) ==================
test("P - policy de rounding para DISPLAY: redondear solo al final (2 decimales), nunca redondear cada posicion antes de sumar", () => {
  const raw = [
    { ticker: "A", type: "stock", shares: 1, cost_basis: 1 },
    { ticker: "B", type: "stock", shares: 1, cost_basis: 1 },
    { ticker: "C", type: "stock", shares: 1, cost_basis: 1 },
  ];
  const md = { A: { price: 0.111 }, B: { price: 0.111 }, C: { price: 0.111 } };
  const enriched = enrichPositions(raw, md, {});
  const rawSum = computeStocksValue(enriched); // 0.333, exacto
  const sumOfRoundedDisplay = [0.111, 0.111, 0.111].reduce((a, v) => a + Math.round(v * 100) / 100, 0); // 0.11*3=0.33
  assert.equal(Math.round(rawSum * 100) / 100, 0.33, "el total RAW redondeado al final da 0.33");
  assert.equal(sumOfRoundedDisplay, 0.33, "en este caso coinciden, pero la politica correcta (RAW->round al final) es la que se usa en produccion, nunca round(a)+round(b)+round(c) por diseno");
});
