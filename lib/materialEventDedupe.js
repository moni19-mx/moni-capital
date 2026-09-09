// lib/materialEventDedupe.js
// Sprint P3.1A (Event Ingestion Foundation). Heuristica de clustering
// SIN embeddings (deliberado -- ver Sprint P3.1 Design Review, seccion
// 13: "escalar a similarity de embeddings solo si la heuristica simple
// resulta insuficiente en la practica"). Puro: nunca toca Supabase, opera
// sobre "candidatos" (clusters ya existentes en memoria) y una nueva
// lectura normalizada, devuelve la decision de a cual cluster pertenece
// (o si es uno nuevo).

const CLUSTER_WINDOW_HOURS = 24;

function hoursBetween(a, b) {
  return Math.abs(new Date(a).getTime() - new Date(b).getTime()) / 3_600_000;
}

// Similaridad de facts MINIMA -- comparacion exacta de las claves que
// ambos lados tienen en comun (nunca compara una clave contra UNKNOWN/
// null como si fueran iguales -- eso inflaria falsos matches). Si ningun
// campo es comparable (ninguna clave en comun con valor conocido en
// ambos lados), la similaridad de facts no aporta señal -- el match
// depende solo de asset_id + event_type + ventana de tiempo.
function factsRoughlyMatch(factsA, factsB) {
  const keys = Object.keys(factsA || {}).filter((k) => (factsB || {})[k] !== undefined);
  if (keys.length === 0) return { comparable: false, match: true };
  let allMatch = true;
  for (const k of keys) {
    const a = factsA[k], b = factsB[k];
    if (a == null || b == null || a === "UNKNOWN" || b === "UNKNOWN") continue; // nunca compara incognitas
    if (typeof a === "number" && typeof b === "number") {
      // tolerancia del 5% para montos -- evita que un redondeo distinto
      // entre proveedores rompa un match real
      if (Math.abs(a - b) / Math.max(Math.abs(a), Math.abs(b), 1) > 0.05) allMatch = false;
    } else if (String(a).toLowerCase() !== String(b).toLowerCase()) {
      allMatch = false;
    }
  }
  return { comparable: true, match: allMatch };
}

// candidateClusters: array de { cluster_id, asset_id, event_type,
//   effective_occurred_at, facts }, representando el estado "actual"
// (facts de la version mas reciente/is_current) de cada cluster abierto
// reciente para ese asset.
// newReading: { asset_id, event_type, effective_occurred_at, facts }
//
// Devuelve { action: "ATTACH_TO_CLUSTER", cluster_id } o
//          { action: "NEW_CLUSTER" }
// -- nunca decide fusionar dos clusters YA existentes entre si (fuera de
// alcance de P3.1A: si eso pasa, ambos quedan abiertos, revisable a mano
// -- mejor un falso negativo de dedupe que un falso positivo que mezcle
// dos eventos reales distintos).
export function resolveClusterAssignment(candidateClusters, newReading) {
  for (const cluster of candidateClusters || []) {
    if (cluster.asset_id !== newReading.asset_id) continue;
    if (cluster.event_type !== newReading.event_type) continue;
    if (hoursBetween(cluster.effective_occurred_at, newReading.effective_occurred_at) > CLUSTER_WINDOW_HOURS) continue;

    const { comparable, match } = factsRoughlyMatch(cluster.facts, newReading.facts);
    // Sin facts comparables, el match depende solo de asset+type+ventana
    // (ya validado arriba) -- suficiente por diseño: dos eventos
    // genuinamente distintos del MISMO asset+type en la MISMA ventana de
    // 24h son el caso raro que Test F cubre explicitamente y para el que
    // este modulo debe FALLAR a favor de no fusionar cuando los facts SI
    // son comparables y difieren.
    if (!comparable || match) {
      return { action: "ATTACH_TO_CLUSTER", cluster_id: cluster.cluster_id };
    }
  }
  return { action: "NEW_CLUSTER" };
}
