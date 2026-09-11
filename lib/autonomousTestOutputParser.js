// lib/autonomousTestOutputParser.js
//
// PURA -- extrae conteos reales de la salida de `node --test` (formato
// TAP). Nunca inventa un conteo si el patron esperado no aparece --
// devuelve null en esos campos, nunca 0 por default (0 real vs
// "no se pudo parsear" deben ser distinguibles).

const PATTERNS = {
  tests: /^# tests (\d+)$/m,
  pass: /^# pass (\d+)$/m,
  fail: /^# fail (\d+)$/m,
  cancelled: /^# cancelled (\d+)$/m,
  skipped: /^# skipped (\d+)$/m,
};

export function parseNodeTestOutput(output) {
  const text = String(output || "");
  const result = {};
  for (const [key, regex] of Object.entries(PATTERNS)) {
    const match = text.match(regex);
    result[key] = match ? Number(match[1]) : null;
  }
  result.parsed_successfully = result.tests !== null && result.pass !== null && result.fail !== null;
  return result;
}
