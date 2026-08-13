// lib/aiPricing.js
// Precios oficiales por millon de tokens (USD), verificados en la
// documentacion de cada proveedor al momento de escribir esto
// (agosto 2026). Los proveedores cambian precios sin aviso -- si el
// costo estimado en ai_usage se ve raro, este es el primer lugar a
// revisar contra las paginas de pricing oficiales.

const PRICING = {
  "claude-sonnet-5": { input: 2.00, output: 10.00 },
  "gpt-5.6-sol": { input: 5.00, output: 30.00 },
  "gpt-5.6-terra": { input: 2.50, output: 15.00 },
};

export function estimateCostUSD(model, inputTokens, outputTokens) {
  const rates = PRICING[model];
  if (!rates || inputTokens == null || outputTokens == null) return null;
  const cost = (inputTokens / 1_000_000) * rates.input + (outputTokens / 1_000_000) * rates.output;
  return Math.round(cost * 1_000_000) / 1_000_000; // 6 decimales, montos son centavos de dolar
}
