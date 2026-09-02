// lib/reconciliationEngine.js
// Stage E, Paso 1 -- 100% puro. Ninguna funcion aqui hace fetch, importa
// @supabase/supabase-js, ni toca red/disco. Todo I/O real (buscar cuentas
// conocidas, transacciones existentes, etc.) vive en un archivo hermano
// separado (reconciliationQueries.js, todavia no creado -- no hace falta
// para este paso).
//
// Principio: LLM extrae e interpreta semanticamente. Este motor decide
// efectos financieros/de persistencia. Nunca al reves.

const TRADE_STATUSES = ["EXECUTED", "PENDING", "CANCELLED", "REJECTED"];
const TRADE_TYPES = ["BUY", "SELL"];

function emptyEffects() {
  return {
    holdings: "NONE",
    cost_basis: "NONE",
    cash_balance: "NONE",
    cash_reserved: "NONE",
    realized_pnl: "NONE",
    net_worth: {
      principal: "NONE",
      fee: "NONE",
      transfer: "NONE",
      external_movement: "NONE",
    },
    source_account_balance: "NONE",
    destination_account_balance: "NONE",
    warnings: [],
  };
}

// ==================================================
// getTransactionEffects -- BUY/SELL en sus 4 estados
// ==================================================
// Input esperado:
//   { status: "EXECUTED"|"PENDING"|"CANCELLED"|"REJECTED",
//     type: "BUY"|"SELL" (requerido si status es EXECUTED o PENDING),
//     fee: number | null | undefined,
//     reserved_cash: boolean | undefined (solo relevante si PENDING) }
//
// Errores de programacion (input invalido/incompleto) -> throw.
// Ambiguedad de negocio esperada (fee desconocido, sin evidencia de
// reserved_cash) -> resultado estructurado + warnings[], nunca throw.
export function getTransactionEffects(transaction) {
  if (!transaction || typeof transaction !== "object") {
    throw new Error("getTransactionEffects: se requiere un objeto transaction");
  }
  const { status, type, fee, reserved_cash } = transaction;

  if (!TRADE_STATUSES.includes(status)) {
    throw new Error(`getTransactionEffects: status invalido "${status}"`);
  }
  if ((status === "EXECUTED" || status === "PENDING") && !TRADE_TYPES.includes(type)) {
    throw new Error(`getTransactionEffects: type debe ser BUY o SELL para status ${status}, recibido "${type}"`);
  }

  const effects = emptyEffects();

  if (status === "CANCELLED" || status === "REJECTED") {
    // Nunca ocurrio de verdad -- todo permanece NONE.
    return effects;
  }

  if (status === "PENDING") {
    if (reserved_cash === true) {
      effects.cash_reserved = "INCREASE";
    } else if (reserved_cash === undefined || reserved_cash === null) {
      // Sin evidencia explicita, NUNCA se asume que el broker reservo capital.
      effects.cash_reserved = "NONE";
      effects.warnings.push("PENDING_RESERVED_CASH_NO_EVIDENCE");
    } else {
      effects.cash_reserved = "NONE";
    }
    // holdings, cost_basis, cash_balance, realized_pnl, net_worth: todo
    // permanece NONE -- una orden pendiente nunca afecta el portafolio.
    return effects;
  }

  // status === "EXECUTED"
  if (type === "BUY") {
    effects.holdings = "INCREASE";
    effects.cost_basis = "UPDATE";
    effects.cash_balance = "DECREASE";
  } else {
    // SELL
    effects.holdings = "DECREASE";
    effects.cost_basis = "UPDATE";
    effects.cash_balance = "INCREASE";
    effects.realized_pnl = "UPDATE";
  }
  // El principal de una compra/venta ejecutada es neutral para Net Worth
  // -- cambia composicion (cash <-> holdings), no el total.
  effects.net_worth.principal = "NONE";

  if (fee === undefined || fee === null) {
    effects.net_worth.fee = "DATA_UNAVAILABLE";
    effects.warnings.push("FEE_UNKNOWN");
  } else if (typeof fee !== "number" || Number.isNaN(fee)) {
    throw new Error(`getTransactionEffects: fee debe ser numero o null/undefined, recibido "${fee}"`);
  } else if (fee > 0) {
    effects.net_worth.fee = "DECREASE";
  } else {
    effects.net_worth.fee = "NONE";
  }

  return effects;
}

// ==================================================
// isInternalTransfer / classifyTransfer
// ==================================================
// knownAccountIds: Set<number> o array de account_id ya conocidos
// (accounts.id de Supabase) -- se pasa como parametro, esta funcion
// nunca hace su propio fetch.
function toKnownSet(knownAccountIds) {
  if (knownAccountIds instanceof Set) return knownAccountIds;
  if (Array.isArray(knownAccountIds)) return new Set(knownAccountIds);
  throw new Error("knownAccountIds debe ser un Set o un array de account_id");
}

export function isInternalTransfer(sourceAccountId, destinationAccountId, knownAccountIds) {
  const known = toKnownSet(knownAccountIds);
  return known.has(sourceAccountId) && known.has(destinationAccountId);
}

// Input: { sourceAccountId, destinationAccountId, knownAccountIds }
// sourceAccountId/destinationAccountId pueden ser un account_id real,
// o null si la extraccion no pudo identificar esa cuenta -- null es un
// caso de negocio valido (evidencia insuficiente), no un error de
// programacion. La clave debe existir en el objeto; si falta por
// completo, es un error de programacion.
export function classifyTransfer({ sourceAccountId, destinationAccountId, knownAccountIds } = {}) {
  if (sourceAccountId === undefined || destinationAccountId === undefined) {
    throw new Error("classifyTransfer: sourceAccountId y destinationAccountId son requeridos (usa null si no se pudo identificar)");
  }
  const known = toKnownSet(knownAccountIds);
  const sourceKnown = sourceAccountId != null && known.has(sourceAccountId);
  const destKnown = destinationAccountId != null && known.has(destinationAccountId);

  if (sourceKnown && destKnown) {
    const effects = emptyEffects();
    effects.source_account_balance = "DECREASE";
    effects.destination_account_balance = "INCREASE";
    // net_worth.transfer ya es "NONE" por default -- explicito por claridad.
    effects.net_worth.transfer = "NONE";
    return { type: "INTERNAL_TRANSFER", effects };
  }

  if (!sourceKnown && destKnown) {
    const effects = emptyEffects();
    effects.destination_account_balance = "INCREASE";
    effects.net_worth.external_movement = "INCREASE";
    return { type: "EXTERNAL_DEPOSIT", effects };
  }

  if (sourceKnown && !destKnown) {
    const effects = emptyEffects();
    effects.source_account_balance = "DECREASE";
    effects.net_worth.external_movement = "DECREASE";
    return { type: "EXTERNAL_WITHDRAWAL", effects };
  }

  // Ninguno de los dos extremos es una cuenta conocida -- no hay forma
  // de establecer direccion. Nunca se inventa un efecto de Net Worth.
  const effects = emptyEffects();
  effects.warnings.push("TRANSFER_DIRECTION_UNKNOWN");
  return { type: "TRANSFER_DIRECTION_UNKNOWN", effects };
}
