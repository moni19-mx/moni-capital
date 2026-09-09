// lib/materialityValidation.js
// Sprint P3.1B.1 (Materiality Real-World Validation). Comparacion PURA
// entre la clasificacion humana (EXPECTED, Regla 3 -- decidida ANTES de
// ver el score del engine) y el resultado real del engine (ACTUAL).
// Recibe solo dos strings ya resueltos -- nunca toca facts, nunca
// recalcula ni un solo componente del engine, nunca se persiste ni
// alimenta de vuelta al scoring (Regla 12 -- NO AUTO-TUNING). Se usa
// exclusivamente para construir el reporte de validacion (Regla 5).

const LEVEL_ORDER = Object.freeze({ LOW: 0, MEDIUM: 1, HIGH: 2 });

// FALSE_POSITIVE: el engine dice HIGH cuando la evidencia humana
// razonable dice LOW.
// FALSE_NEGATIVE: el engine dice LOW cuando hay evidencia fuerte de un
// evento HIGH.
// NEAR_MISS: MEDIUM vs HIGH, o LOW vs MEDIUM -- discrepancia adyacente,
// razonablemente debatible, nunca un error grave.
// MATCH: EXPECTED === ACTUAL.
export function classifyPredictionOutcome({ expected, actual }) {
  if (!(expected in LEVEL_ORDER) || !(actual in LEVEL_ORDER)) {
    return { outcome: "NOT_COMPARABLE", distance: null };
  }
  const distance = LEVEL_ORDER[actual] - LEVEL_ORDER[expected];
  if (distance === 0) return { outcome: "MATCH", distance: 0 };
  if (expected === "LOW" && actual === "HIGH") return { outcome: "FALSE_POSITIVE", distance };
  if (expected === "HIGH" && actual === "LOW") return { outcome: "FALSE_NEGATIVE", distance };
  return { outcome: "NEAR_MISS", distance };
}
