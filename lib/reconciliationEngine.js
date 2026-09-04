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

// ==================================================
// getAccountEquity -- Paso 2
// ==================================================
// balanceRow: { equity_value, wallet_balance_value, available_balance_value,
//               margin_balance_value, unrealized_pnl_value, asset_id }
// accountType: "spot" | "wallet" | "broker" | "futures"
//
// Regla: si el proveedor ya entrega equity explicita, se usa esa y punto
// -- nunca se recalcula. Si no, se usa UNICAMENTE una formula validada
// para ese account_type. Si falta un insumo necesario, DATA_UNAVAILABLE
// -- nunca se rellena con 0.
export function getAccountEquity(balanceRow, accountType) {
  if (!balanceRow || typeof balanceRow !== "object") {
    throw new Error("getAccountEquity: se requiere un objeto balanceRow");
  }
  if (!balanceRow.asset_id && balanceRow.asset_id !== 0) {
    throw new Error("getAccountEquity: balanceRow.asset_id es requerido");
  }

  if (balanceRow.equity_value != null) {
    return { status: "OK", value: balanceRow.equity_value, asset_id: balanceRow.asset_id };
  }

  if (accountType === "spot" || accountType === "wallet" || accountType === "broker") {
    if (balanceRow.wallet_balance_value != null) {
      return { status: "OK", value: balanceRow.wallet_balance_value, asset_id: balanceRow.asset_id };
    }
    return { status: "DATA_UNAVAILABLE", reason: "missing_wallet_balance_value" };
  }

  if (accountType === "futures") {
    const { available_balance_value, margin_balance_value, unrealized_pnl_value } = balanceRow;
    if (available_balance_value == null || margin_balance_value == null || unrealized_pnl_value == null) {
      return { status: "DATA_UNAVAILABLE", reason: "missing_futures_equity_components" };
    }
    return {
      status: "OK",
      value: available_balance_value + margin_balance_value + unrealized_pnl_value,
      asset_id: balanceRow.asset_id,
    };
  }

  return { status: "DATA_UNAVAILABLE", reason: `unsupported_account_type:${accountType}` };
}

// ==================================================
// computeNetWorth -- Paso 2, contrato anti-double-counting
// ==================================================
// holdings: [{ account_id: number|null, asset_id, value }]
// accountEquities: [{ account_id: number, value: number|null }]  (value=null -> DATA_UNAVAILABLE para esa cuenta)
//
// Regla dura: si un account_id aparece en AMBOS arreglos, es conflicto.
// Gana account_equity si tiene valor real; si no, cae a holdings de esa
// cuenta como fallback. Nunca se suman ambos.
export function computeNetWorth({ holdings, accountEquities }) {
  if (!Array.isArray(holdings) || !Array.isArray(accountEquities)) {
    throw new Error("computeNetWorth: holdings y accountEquities deben ser arrays");
  }

  const holdingsByAccount = new Map(); // account_id (no-null) -> suma de holdings
  const holdingsWithoutAccount = []; // holdings sin account_id -- nunca generan conflicto

  for (const h of holdings) {
    if (typeof h.value !== "number" || Number.isNaN(h.value)) {
      throw new Error(`computeNetWorth: holding con value invalido (asset_id=${h.asset_id})`);
    }
    if (h.account_id == null) {
      holdingsWithoutAccount.push(h);
    } else {
      holdingsByAccount.set(h.account_id, (holdingsByAccount.get(h.account_id) || 0) + h.value);
    }
  }

  const equityByAccount = new Map();
  for (const e of accountEquities) {
    if (e.account_id == null) {
      throw new Error("computeNetWorth: accountEquities requiere account_id en cada entrada");
    }
    equityByAccount.set(e.account_id, e.value);
  }

  let total = 0;
  const breakdown = [];
  const conflicts = [];
  const missingComponents = [];

  // Holdings sin cuenta: siempre se suman directo, nunca conflictan.
  for (const h of holdingsWithoutAccount) {
    total += h.value;
    breakdown.push({ account_id: null, source: "HOLDINGS", value: h.value });
  }

  const allAccountIds = new Set([...holdingsByAccount.keys(), ...equityByAccount.keys()]);

  for (const accountId of allAccountIds) {
    const hasHoldings = holdingsByAccount.has(accountId);
    const hasEquity = equityByAccount.has(accountId);

    if (hasHoldings && hasEquity) {
      const equityValue = equityByAccount.get(accountId);
      if (equityValue != null) {
        total += equityValue;
        breakdown.push({ account_id: accountId, source: "ACCOUNT_EQUITY", value: equityValue });
        conflicts.push({ account_id: accountId, reason: "OVERLAP_HOLDINGS_AND_EQUITY", resolution: "USED_ACCOUNT_EQUITY" });
      } else {
        const holdingsValue = holdingsByAccount.get(accountId);
        total += holdingsValue;
        breakdown.push({ account_id: accountId, source: "HOLDINGS", value: holdingsValue });
        conflicts.push({ account_id: accountId, reason: "OVERLAP_HOLDINGS_AND_EQUITY", resolution: "USED_HOLDINGS_FALLBACK" });
      }
    } else if (hasEquity) {
      const equityValue = equityByAccount.get(accountId);
      if (equityValue != null) {
        total += equityValue;
        breakdown.push({ account_id: accountId, source: "ACCOUNT_EQUITY", value: equityValue });
      } else {
        missingComponents.push(accountId);
      }
    } else {
      // solo holdings, sin fila de equity para esa cuenta -- normal, sin conflicto
      const holdingsValue = holdingsByAccount.get(accountId);
      total += holdingsValue;
      breakdown.push({ account_id: accountId, source: "HOLDINGS", value: holdingsValue });
    }
  }

  return { value: total, breakdown, conflicts, missingComponents };
}

// ==================================================
// computeAssetOwnership -- Paso 2
// ==================================================
// ownershipEntries: [{ asset_id, owned_value, encumbered_value: number|null|undefined }]
// encumbered_value: number conocido (incluyendo 0 = nada bloqueado),
// o null/undefined = no se puede determinar la particion de forma confiable.
export function computeAssetOwnership(assetId, ownershipEntries) {
  if (assetId == null) throw new Error("computeAssetOwnership: assetId es requerido");
  if (!Array.isArray(ownershipEntries)) throw new Error("computeAssetOwnership: ownershipEntries debe ser un array");

  const matching = ownershipEntries.filter((e) => e.asset_id === assetId);

  let owned = 0;
  let encumberedKnownSum = 0;
  let anyUnknownEncumbrance = false;

  for (const entry of matching) {
    if (typeof entry.owned_value !== "number" || Number.isNaN(entry.owned_value)) {
      throw new Error(`computeAssetOwnership: owned_value invalido para asset_id=${assetId}`);
    }
    owned += entry.owned_value;
    if (entry.encumbered_value == null) {
      anyUnknownEncumbrance = true;
    } else {
      encumberedKnownSum += entry.encumbered_value;
    }
  }

  if (matching.length === 0) {
    return { owned: 0, available: 0, encumbered: 0 };
  }

  if (anyUnknownEncumbrance) {
    return { owned, available: "DATA_UNAVAILABLE", encumbered: "DATA_UNAVAILABLE" };
  }

  return { owned, available: owned - encumberedKnownSum, encumbered: encumberedKnownSum };
}

// ==================================================
// deriveNotional -- Paso 3
// ==================================================
// unitSemanticsRegistry: objeto { [key]: { mode, underlyingAssetId } }
// key = `${provider}::${product_type}::${instrument}::${contract_type}`
//
// Mientras una key no exista en el registry, SIEMPRE se devuelve
// UNIT_SEMANTICS_UNVERIFIED -- nunca se deriva un valor por default.
// Hoy el registry esta vacio para COIN-M deliberadamente.
//
// Unico modo soportado por ahora: "DIRECT_QUANTITY_IS_UNDERLYING"
// (position_quantity_value ya representa directamente unidades del
// activo subyacente, 1:1 -- valido para el caso mas simple, ej. algunos
// productos de margen lineal). Otros modos se agregan cuando se
// verifique su semantica real, nunca antes.
export function deriveNotional(rawFacts, unitSemanticsKey, unitSemanticsRegistry) {
  if (!rawFacts || typeof rawFacts !== "object") {
    throw new Error("deriveNotional: se requiere rawFacts");
  }
  if (!unitSemanticsKey) {
    throw new Error("deriveNotional: se requiere unitSemanticsKey");
  }
  const registry = unitSemanticsRegistry || {};
  const entry = registry[unitSemanticsKey];

  const unverified = () => ({
    status: "UNIT_SEMANTICS_UNVERIFIED",
    underlying_equivalent_value: null,
    underlying_equivalent_asset_id: null,
    notional_value: null,
    notional_asset_id: null,
    warnings: ["UNIT_SEMANTICS_UNVERIFIED"],
  });

  if (!entry) return unverified();

  if (entry.mode === "DIRECT_QUANTITY_IS_UNDERLYING") {
    const { position_quantity_value, entry_price, price_currency } = rawFacts;
    if (typeof position_quantity_value !== "number") {
      throw new Error("deriveNotional: rawFacts.position_quantity_value numerico es requerido");
    }
    const notionalKnown = entry_price != null && price_currency != null;
    return {
      status: "VERIFIED",
      underlying_equivalent_value: position_quantity_value,
      underlying_equivalent_asset_id: entry.underlyingAssetId,
      notional_value: notionalKnown ? position_quantity_value * entry_price : null,
      notional_asset_id: notionalKnown ? price_currency : null,
      warnings: notionalKnown ? [] : ["NOTIONAL_PRICE_MISSING"],
    };
  }

  // Modo desconocido en el registry -- tratado como no verificado, nunca
  // se adivina una formula para un modo que no reconocemos.
  return unverified();
}

// ==================================================
// computeDerivativeExposure -- Paso 3
// ==================================================
// positionSnapshots: [{ instrument, side, notional_value, notional_asset_id, unit_semantics_status }]
// options.notionalAssetId: el asset en el que se quiere medir exposicion
// (ej. "USDT") -- solo se suman posiciones cuyo notional ya este en ese
// asset. Las demas se excluyen explicitamente, nunca se convierten a
// ciegas ni se ignoran en silencio.
export function computeDerivativeExposure(positionSnapshots, { notionalAssetId } = {}) {
  if (!Array.isArray(positionSnapshots)) {
    throw new Error("computeDerivativeExposure: positionSnapshots debe ser un array");
  }
  if (!notionalAssetId) {
    throw new Error("computeDerivativeExposure: notionalAssetId es requerido");
  }

  let gross = 0;
  let net = 0;
  const excludedUnverified = [];
  const excludedAssetMismatch = [];

  for (const p of positionSnapshots) {
    if (p.unit_semantics_status !== "VERIFIED" || p.notional_value == null) {
      excludedUnverified.push(p.instrument);
      continue;
    }
    if (p.notional_asset_id !== notionalAssetId) {
      excludedAssetMismatch.push(p.instrument);
      continue;
    }
    const signedNotional = p.side === "short" ? -Math.abs(p.notional_value) : Math.abs(p.notional_value);
    gross += Math.abs(p.notional_value);
    net += signedNotional;
  }

  return { gross, net, excludedUnverified, excludedAssetMismatch };
}

// ==================================================
// computeEffectiveExposure -- Paso 3
// ==================================================
// ownership: resultado de computeAssetOwnership (owned puede ser DATA_UNAVAILABLE
//            en teoria, aunque en la practica owned casi siempre es numerico)
// exposure: resultado de computeDerivativeExposure, en el MISMO asset que ownership.owned
//
// btcLinkedEquityExposure (ej. MSTR) NUNCA se mezcla aqui -- es una
// metrica separada, fuera de alcance de esta funcion.
export function computeEffectiveExposure(ownership, exposure) {
  if (typeof ownership.owned !== "number") {
    return {
      status: "DATA_UNAVAILABLE",
      value: null,
      components: { owned: ownership.owned, derivativeNet: exposure?.net ?? null },
      warnings: [],
    };
  }

  const warnings = [];
  if (exposure.excludedUnverified?.length > 0) warnings.push("EXCLUDED_UNVERIFIED_POSITIONS");
  if (exposure.excludedAssetMismatch?.length > 0) warnings.push("EXCLUDED_ASSET_MISMATCH_POSITIONS");

  return {
    status: warnings.length > 0 ? "PARTIAL" : "OK",
    value: ownership.owned + exposure.net,
    components: { owned: ownership.owned, derivativeNet: exposure.net },
    warnings,
  };
}

// ==================================================
// matchDerivativePositionIdentity -- Paso 4
// ==================================================
// normalizedFacts: { account_id, instrument, side, contract_type,
//   provider_position_id: string|null, margin_mode: "isolated"|"cross"|null,
//   strategy: string|null, leverage: number|null }
// openCandidates: array de derivative_positions YA existentes (se filtra
// defensivamente por status==="OPEN" dentro de esta funcion, aunque el
// llamador deberia mandarlas pre-filtradas).
//
// Jerarquia (revision del addendum): provider_position_id > tupla
// canonica (account+instrument+side+contract_type, solo entre OPEN) >
// evidencia de reconciliacion (margin_mode, etc). margin_mode NUNCA
// determina identidad por si solo -- solo baja confidence a MEDIUM, o
// dispara AMBIGUOUS si hay conflicto de provider_position_id.
export function matchDerivativePositionIdentity(normalizedFacts, openCandidates) {
  if (!normalizedFacts || typeof normalizedFacts !== "object") {
    throw new Error("matchDerivativePositionIdentity: se requiere normalizedFacts");
  }
  if (!Array.isArray(openCandidates)) {
    throw new Error("matchDerivativePositionIdentity: openCandidates debe ser un array");
  }
  const { account_id, instrument, contract_type, side, provider_position_id, margin_mode } = normalizedFacts;

  if (account_id == null || !instrument || !contract_type) {
    throw new Error("matchDerivativePositionIdentity: account_id, instrument y contract_type son requeridos");
  }
  if (!side) {
    // Caso de negocio real (la extraccion no pudo determinar long/short
    // con confianza) -- no es un bug de programacion, se devuelve como
    // resultado estructurado, nunca se lanza excepcion.
    return { decision: "INSUFFICIENT_DATA", matchedPositionId: null, reconciliation_confidence: null, reasons: ["missing_side"] };
  }

  const open = openCandidates.filter((c) => c.status === "OPEN");

  // Prioridad 1: provider_position_id exacto, dentro de la misma cuenta.
  if (provider_position_id != null) {
    const byProviderId = open.filter((c) => c.account_id === account_id && c.provider_position_id === provider_position_id);
    if (byProviderId.length === 1) {
      return { decision: "MATCH_EXISTING_HIGH", matchedPositionId: byProviderId[0].id, reconciliation_confidence: "HIGH", reasons: ["provider_position_id_match"] };
    }
    if (byProviderId.length > 1) {
      return { decision: "POSITION_IDENTITY_AMBIGUOUS", matchedPositionId: null, reconciliation_confidence: "AMBIGUOUS", reasons: ["multiple_candidates_same_provider_position_id"] };
    }
    // 0 matches por provider_position_id -- se continua con la tupla canonica.
  }

  // Prioridad 2: tupla canonica, solo entre OPEN.
  const byTuple = open.filter(
    (c) => c.account_id === account_id && c.instrument === instrument && c.side === side && c.contract_type === contract_type
  );

  if (byTuple.length === 0) {
    return { decision: "NEW_POSITION", matchedPositionId: null, reconciliation_confidence: null, reasons: ["no_open_candidate_for_identity_tuple"] };
  }

  if (byTuple.length > 1) {
    return { decision: "POSITION_IDENTITY_AMBIGUOUS", matchedPositionId: null, reconciliation_confidence: "AMBIGUOUS", reasons: ["multiple_open_candidates_same_tuple"] };
  }

  const candidate = byTuple[0];

  // Evidencia contradictoria fuerte: provider_position_id explicito en
  // ambos lados pero DISTINTO -- no se puede confiar en el match de tupla.
  if (provider_position_id != null && candidate.provider_position_id != null && candidate.provider_position_id !== provider_position_id) {
    return { decision: "POSITION_IDENTITY_AMBIGUOUS", matchedPositionId: null, reconciliation_confidence: "AMBIGUOUS", reasons: ["conflicting_provider_position_id"] };
  }

  // margin_mode es evidencia, no identidad -- si difiere, baja a MEDIUM
  // en vez de forzar NEW_POSITION o AMBIGUOUS.
  if (margin_mode != null && candidate.margin_mode != null && candidate.margin_mode !== margin_mode) {
    return { decision: "MATCH_EXISTING_MEDIUM", matchedPositionId: candidate.id, reconciliation_confidence: "MEDIUM", reasons: ["tuple_match_margin_mode_changed"] };
  }

  return { decision: "MATCH_EXISTING_HIGH", matchedPositionId: candidate.id, reconciliation_confidence: "HIGH", reasons: ["tuple_match_consistent_evidence"] };
}

// ==================================================
// routeDerivativeSnapshot -- Paso 5, una posicion individual
// ==================================================
// Nunca escribe nada -- solo arma la estructura de proposed_changes.
// AMBIGUOUS/INSUFFICIENT_DATA nunca proponen CREATE de nada: van a REVIEW.
export function routeDerivativeSnapshot(normalizedFacts, reconciliationResult) {
  if (!normalizedFacts || !reconciliationResult) {
    throw new Error("routeDerivativeSnapshot: normalizedFacts y reconciliationResult son requeridos");
  }
  const { decision, matchedPositionId, reconciliation_confidence, reasons } = reconciliationResult;

  if (decision === "POSITION_IDENTITY_AMBIGUOUS" || decision === "INSUFFICIENT_DATA") {
    return [{
      entity: "derivative_position",
      operation: "REVIEW",
      target_id: matchedPositionId,
      fields: null,
      confidence: reconciliation_confidence,
      warnings: reasons || [],
      reason: decision,
    }];
  }

  const proposals = [];

  if (decision === "NEW_POSITION") {
    proposals.push({
      entity: "derivative_position",
      operation: "CREATE",
      target_id: null,
      fields: {
        account_id: normalizedFacts.account_id,
        underlying_asset_id: normalizedFacts.underlying_asset_id ?? null,
        instrument: normalizedFacts.instrument,
        contract_type: normalizedFacts.contract_type,
        side: normalizedFacts.side,
        margin_mode: normalizedFacts.margin_mode ?? null,
        strategy: normalizedFacts.strategy ?? null,
        provider_position_id: normalizedFacts.provider_position_id ?? null,
        status: "OPEN",
      },
      confidence: "HIGH",
      warnings: [],
    });
  }

  proposals.push({
    entity: "derivative_position_snapshot",
    operation: "CREATE",
    target_id: decision === "NEW_POSITION" ? null : matchedPositionId,
    fields: {
      position_quantity_value: normalizedFacts.position_quantity_value,
      position_quantity_unit: normalizedFacts.position_quantity_unit,
      leverage: normalizedFacts.leverage ?? null,
      margin_used_value: normalizedFacts.margin_used_value ?? null,
      margin_used_asset_id: normalizedFacts.margin_used_asset_id ?? null,
      entry_price: normalizedFacts.entry_price ?? null,
      mark_price: normalizedFacts.mark_price ?? null,
      liquidation_price: normalizedFacts.liquidation_price ?? null,
      price_currency: normalizedFacts.price_currency ?? null,
      unrealized_pnl_value: normalizedFacts.unrealized_pnl_value ?? null,
      unrealized_pnl_asset_id: normalizedFacts.unrealized_pnl_asset_id ?? null,
      observed_at: normalizedFacts.observed_at,
    },
    confidence: reconciliation_confidence,
    warnings: decision === "MATCH_EXISTING_MEDIUM" ? ["MEDIUM_CONFIDENCE_MATCH_REVIEW_RECOMMENDED"] : [],
  });

  return proposals;
}

// ==================================================
// routeDerivativeImportBatch -- Paso 5, multiples posiciones + balance
// ==================================================
// UN solo account_snapshot para todo el batch, sin importar cuantas
// posiciones o balances traiga -- esto es lo que evita duplicar el
// account_snapshot por cada posicion.
export function routeDerivativeImportBatch({ accountId, observedAt, balanceFacts, positionFacts }, { openCandidates } = {}) {
  if (accountId == null || !observedAt) {
    throw new Error("routeDerivativeImportBatch: accountId y observedAt son requeridos");
  }
  if (!Array.isArray(balanceFacts) || !Array.isArray(positionFacts)) {
    throw new Error("routeDerivativeImportBatch: balanceFacts y positionFacts deben ser arrays");
  }
  const candidates = openCandidates || [];
  const warnings = [];

  const accountSnapshotProposal = {
    entity: "account_snapshot",
    operation: "CREATE",
    target_id: null,
    fields: { account_id: accountId, observed_at: observedAt },
    confidence: "HIGH",
    warnings: [],
  };

  const accountBalanceProposals = balanceFacts.map((b) => ({
    entity: "account_snapshot_balance",
    operation: "CREATE",
    target_id: null, // se resuelve al id del account_snapshot recien creado, fuera de esta funcion pura
    fields: {
      asset_id: b.asset_id,
      wallet_balance_value: b.wallet_balance_value ?? null,
      equity_value: b.equity_value ?? null,
      available_balance_value: b.available_balance_value ?? null,
      margin_balance_value: b.margin_balance_value ?? null,
      initial_margin_value: b.initial_margin_value ?? null,
      maintenance_margin_value: b.maintenance_margin_value ?? null,
      unrealized_pnl_value: b.unrealized_pnl_value ?? null,
    },
    confidence: b.confidence ?? "HIGH",
    warnings: [],
  }));

  const positionSnapshotProposals = [];
  for (const posFacts of positionFacts) {
    const factsWithAccount = { ...posFacts, account_id: accountId };
    const reconciliation = matchDerivativePositionIdentity(factsWithAccount, candidates);
    positionSnapshotProposals.push(...routeDerivativeSnapshot(factsWithAccount, reconciliation));
    if (reconciliation.decision === "POSITION_IDENTITY_AMBIGUOUS" || reconciliation.decision === "INSUFFICIENT_DATA") {
      warnings.push(`${posFacts.instrument || "unknown_instrument"}: ${reconciliation.decision}`);
    }
  }

  return { accountSnapshotProposal, accountBalanceProposals, positionSnapshotProposals, warnings };
}

// ==================================================
// classifyDuplicate -- Paso 6
// ==================================================
// Jerarquia de 3 niveles (aprobada previamente):
//   1. provider_transaction_id (scope por account_id) -> EXACT_DUPLICATE
//   2. fingerprint de timestamp exacto -> EXACT_DUPLICATE
//   3. solo fecha -> NUNCA EXACT_DUPLICATE, a lo mas POSSIBLE_DUPLICATE
//      (dos compras legitimas del mismo monto el mismo dia son posibles
//      y NO deben tratarse como la misma operacion)
const NUMERIC_TOLERANCE = 1e-9;
function numbersClose(a, b) {
  if (a == null || b == null) return false;
  return Math.abs(a - b) < NUMERIC_TOLERANCE;
}

export function classifyDuplicate(candidate, existingTransactions) {
  if (!candidate || typeof candidate !== "object") {
    throw new Error("classifyDuplicate: se requiere candidate");
  }
  if (!Array.isArray(existingTransactions)) {
    throw new Error("classifyDuplicate: existingTransactions debe ser un array");
  }

  // Nivel 1: provider_transaction_id, dentro de la misma cuenta.
  if (candidate.provider_transaction_id != null && candidate.account_id != null) {
    const match = existingTransactions.find(
      (t) => t.account_id === candidate.account_id && t.provider_transaction_id === candidate.provider_transaction_id
    );
    if (match) {
      return { result: "EXACT_DUPLICATE", matchedTransactionId: match.id, matchLevel: "PROVIDER_ID" };
    }
  }

  // Nivel 2: timestamp exacto + cuenta + asset + tipo + cantidad + precio/total.
  const hasLevel2Inputs =
    candidate.transaction_at != null && candidate.account_id != null && candidate.asset_id != null &&
    candidate.type != null && candidate.quantity != null && (candidate.price != null || candidate.total != null);

  if (hasLevel2Inputs) {
    const match = existingTransactions.find((t) =>
      t.account_id === candidate.account_id &&
      t.asset_id === candidate.asset_id &&
      t.type === candidate.type &&
      t.transaction_at === candidate.transaction_at &&
      numbersClose(t.quantity, candidate.quantity) &&
      (candidate.price != null ? numbersClose(t.price, candidate.price) : numbersClose(t.total, candidate.total))
    );
    if (match) {
      return { result: "EXACT_DUPLICATE", matchedTransactionId: match.id, matchLevel: "EXACT_TIMESTAMP" };
    }
  }

  // Nivel 3: solo fecha -- deliberadamente NUNCA produce EXACT_DUPLICATE.
  if (candidate.transaction_date != null && candidate.asset_id != null) {
    const match = existingTransactions.find((t) =>
      t.asset_id === candidate.asset_id &&
      t.transaction_date === candidate.transaction_date &&
      (candidate.type == null || t.type === candidate.type) &&
      ((candidate.quantity != null && numbersClose(t.quantity, candidate.quantity)) ||
        (candidate.total != null && numbersClose(t.total, candidate.total)))
    );
    if (match) {
      return { result: "POSSIBLE_DUPLICATE", matchedTransactionId: match.id, matchLevel: "DATE_ONLY" };
    }
  }

  return { result: "NO_MATCH", matchedTransactionId: null, matchLevel: null };
}

// ==================================================
// isEligibleForCreate -- contrato Smart Import Phase 1
// ==================================================
// normalized: normalized_extraction ya resuelto (asset, type, quantity,
// status, total, warnings, overall_import_confidence).
export function isEligibleForCreate(normalized) {
  if (!normalized || typeof normalized !== "object") {
    throw new Error("isEligibleForCreate: se requiere normalized_extraction");
  }
  if (normalized.overall_import_confidence === "AMBIGUOUS") return false;
  if (normalized.asset?.match_status !== "MATCHED_ASSET" || normalized.asset?.asset_id == null) return false;
  if (normalized.type !== "BUY" && normalized.type !== "SELL") return false;
  if (normalized.quantity == null || normalized.quantity <= 0) return false;
  if (normalized.status?.value !== "PENDING" && normalized.status?.value !== "EXECUTED") return false;
  if ((normalized.warnings || []).includes("DOCUMENT_TYPE_TRANSACTION_TYPE_CONFLICT")) return false;
  if (normalized.transaction_date == null) return false;
  const hasEconomicInfo = normalized.total?.value != null || normalized.price != null;
  if (!hasEconomicInfo) return false;
  return true;
}

// ==================================================
// buildProposedChange -- Smart Import Phase 1, 100% pura
// ==================================================
// UPDATE (PENDING->EXECUTED) solo con identidad FUERTE (PROVIDER_ID o
// EXACT_TIMESTAMP -- ambos ya implican result==="EXACT_DUPLICATE" segun
// classifyDuplicate). POSSIBLE_DUPLICATE (DATE_ONLY) nunca dispara
// UPDATE, sin importar que status diga -- va a REVIEW siempre.
export function buildProposedChange({ normalized, duplicateResult, matchedTransaction, effects, eligibility }) {
  if (!normalized || !duplicateResult) {
    throw new Error("buildProposedChange: normalized y duplicateResult son requeridos");
  }

  const base = {
    entity: "transaction",
    confidence: normalized.overall_import_confidence,
    warnings: normalized.warnings || [],
    duplicate_check: {
      result: duplicateResult.result,
      matchedTransactionId: duplicateResult.matchedTransactionId,
      matchLevel: duplicateResult.matchLevel,
    },
  };

  const strongIdentity = duplicateResult.matchLevel === "PROVIDER_ID" || duplicateResult.matchLevel === "EXACT_TIMESTAMP";

  if (duplicateResult.result === "EXACT_DUPLICATE" && strongIdentity && matchedTransaction?.status === "PENDING" && normalized.status?.value === "EXECUTED") {
    return { ...base, operation: "UPDATE", target_id: matchedTransaction.id, fields: { status: "EXECUTED" }, effects, reason: "PENDING_TO_EXECUTED" };
  }

  if (duplicateResult.result === "EXACT_DUPLICATE") {
    return { ...base, operation: "REVIEW", target_id: matchedTransaction?.id ?? null, fields: null, reason: "EXACT_DUPLICATE" };
  }

  if (duplicateResult.result === "POSSIBLE_DUPLICATE") {
    // NUNCA UPDATE aqui, sin importar el status -- identidad fuzzy/date-only.
    return { ...base, operation: "REVIEW", target_id: matchedTransaction?.id ?? null, fields: null, reason: "POSSIBLE_DUPLICATE" };
  }

  // NO_MATCH
  if (eligibility) {
    return {
      ...base,
      operation: "CREATE",
      target_id: null,
      fields: {
        asset_id: normalized.asset.asset_id,
        account_id: normalized.account?.account_id ?? null,
        type: normalized.type,
        quantity: normalized.quantity,
        price: normalized.price,
        amount: normalized.total?.value ?? null,
        fee: normalized.fee?.value ?? null,
        status: normalized.status.value,
        transaction_date: normalized.transaction_date,
        provider_transaction_id: normalized.provider_transaction_id,
      },
      effects,
    };
  }

  return { ...base, operation: "REVIEW", target_id: null, fields: null, reason: "NOT_ELIGIBLE_FOR_CREATE" };
}
