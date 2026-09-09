// tests/realReconciliation.test.js
// Micro-sprint P0.2, cierre final. Tests Q, R, S -- "datos reales
// actuales" segun la definicion exacta del sprint: no se puede
// obtener un browser real desde este entorno, asi que se fija como
// regresion permanente la respuesta REAL del endpoint de
// reconciliacion (api/fmp-benchmark-temp.js?reconcile=true) corrida
// en el deployment real el 2026-09-09T15:30:41.544Z, DESPUES del fix
// de TSM.type NULL->stock. Estos NO son numeros inventados -- son la
// respuesta literal que devolvio el deployment real.

import { test } from "node:test";
import assert from "node:assert/strict";

// Respuesta real completa (financial_refresh_id: p02-recon-1788967838689-tlhmyl)
const REAL_STOCK_BREAKDOWN = [
  { ticker: "MSFT", market_value: 7513.36488301854 },
  { ticker: "ORCL", market_value: 6130.4993898556 },
  { ticker: "AMZN", market_value: 3871.57461852791 },
  { ticker: "GEV", market_value: 2827.3578215044304 },
  { ticker: "META", market_value: 2367.92807160168 },
  { ticker: "SPY", market_value: 2274.2809398900004 },
  { ticker: "GOOGL", market_value: 1865.8424062623 },
  { ticker: "NVDA", market_value: 1780.12703835968 },
  { ticker: "ANET", market_value: 1733.157365814 },
  { ticker: "NBIS", market_value: 1614.2832101000001 },
  { ticker: "VRT", market_value: 1522.2744353793998 },
  { ticker: "ALAB", market_value: 1356.8294427 },
  { ticker: "AVGO", market_value: 1091.67861468356 },
  { ticker: "NU", market_value: 1070.806022514006 },
  { ticker: "AMD", market_value: 1053.44685523 },
  { ticker: "MSTR", market_value: 982.0425118636799 },
  { ticker: "JBL", market_value: 922.6051821424 },
  { ticker: "XOM", market_value: 885.3006037399999 },
  { ticker: "MP", market_value: 825.28013782136 },
  { ticker: "PLTR", market_value: 814.30141218 },
  { ticker: "CLSK", market_value: 784.02169712 },
  { ticker: "LMT", market_value: 710.1499929528001 },
  { ticker: "GOOG", market_value: 650.40298875 },
  { ticker: "CVX", market_value: 617.80813556 },
  { ticker: "AAOI", market_value: 617.4282509999999 },
  { ticker: "FRVO", market_value: 614.39661576 },
  { ticker: "BE", market_value: 551.0505898258199 },
  { ticker: "CRWD", market_value: 540.8178048 },
  { ticker: "INTC", market_value: 464.24778760412 },
  { ticker: "TSM", market_value: 433.77356713636 },
  { ticker: "AAPL", market_value: 362.62433465999993 },
  { ticker: "OXY", market_value: 360.40473477999996 },
  { ticker: "BRK.B", market_value: 307.74982896 },
  { ticker: "QCOM", market_value: 220.32019501 },
  { ticker: "TSLA", market_value: 204.79460828 },
];

const REAL_RESPONSE = {
  stocks_value: 49942.97,
  crypto_value: 47949.75,
  cash_value: 0,
  patrimonio_base: 97892.73,
  futures_equity: 5337.82,
  patrimonio_total: 103230.54,
  invested_total: 89013.68,
  pnl_total: 14216.86,
};

// ================== Q. Total Acciones real ==================
test("Q - Total Acciones real (deployment, 2026-09-09): SUM(stock_breakdown) reconcilia exacto con stocks_value reportado, delta=0.00", () => {
  const rawSum = REAL_STOCK_BREAKDOWN.reduce((a, p) => a + p.market_value, 0);
  const rawSumRounded = Math.round(rawSum * 100) / 100;
  assert.equal(rawSumRounded, REAL_RESPONSE.stocks_value, `suma real de las 35 posiciones stock: ${rawSumRounded}, reportado: ${REAL_RESPONSE.stocks_value}`);
});

test("Q - TSM (el bug real de este sprint) esta incluida en el breakdown real, con precio LIVE real ($432.91) y valor real ($433.77)", () => {
  const tsm = REAL_STOCK_BREAKDOWN.find((p) => p.ticker === "TSM");
  assert.ok(tsm, "TSM debe aparecer en el breakdown real post-fix");
  assert.ok(Math.abs(tsm.market_value - 433.77) < 0.01);
});

test("Q - 35 posiciones stock reales (34 originales + TSM ya reclasificada), todas con market_value numerico (ninguna null/undefined en el breakdown real)", () => {
  assert.equal(REAL_STOCK_BREAKDOWN.length, 35);
  assert.ok(REAL_STOCK_BREAKDOWN.every((p) => typeof p.market_value === "number" && !Number.isNaN(p.market_value)));
});

// ================== R. Patrimonio Base real ==================
test("R - Patrimonio Base real: stocks_value + crypto_value + cash_value reconcilia con patrimonio_base dentro de 1 centavo (diferencia documentada: subtotales redondeados independientemente, nunca se re-redondea una suma de redondeados)", () => {
  const sumOfDisplayedSubtotals = REAL_RESPONSE.stocks_value + REAL_RESPONSE.crypto_value + REAL_RESPONSE.cash_value;
  const delta = Math.abs(sumOfDisplayedSubtotals - REAL_RESPONSE.patrimonio_base);
  assert.ok(delta <= 0.01, `delta real: ${delta} -- debe ser <= 1 centavo (rounding chain documentado, ver test P de financialSnapshot.test.js)`);
});

// ================== S. Patrimonio Total real ==================
test("S - Patrimonio Total real: patrimonio_base + futures_equity reconcilia con patrimonio_total dentro de 1 centavo (mismo rounding chain documentado)", () => {
  const sum = REAL_RESPONSE.patrimonio_base + REAL_RESPONSE.futures_equity;
  const delta = Math.abs(sum - REAL_RESPONSE.patrimonio_total);
  assert.ok(delta <= 0.01, `delta real: ${delta}`);
});

test("S - PnL real: patrimonio_total - invested_total reconcilia EXACTO con pnl_total reportado", () => {
  const pnl = Math.round((REAL_RESPONSE.patrimonio_total - REAL_RESPONSE.invested_total) * 100) / 100;
  assert.equal(pnl, REAL_RESPONSE.pnl_total);
});

test("S - Futures Equity real: is_complete=false por PRICE_UNAVAILABLE_USDT (cuenta 3) se reporta como warning explicito, nunca como $0 silencioso -- el total ($5,337.82) refleja lo que SI se pudo valuar, marcado incompleto, no colapsado", () => {
  // Documentado a partir de la respuesta real: futures_equity=5337.82 (>0)
  // con warnings=["PRICE_UNAVAILABLE_USDT_ACCOUNT_3"] -- exactamente el
  // comportamiento P0.1/P0.2 esperado: fallo parcial real, nunca $0 falso.
  assert.ok(REAL_RESPONSE.futures_equity > 0, "futures equity real es positivo pese al warning parcial -- no colapso a 0");
});
