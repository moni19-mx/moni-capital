// api/futures-equity.js
// READ-ONLY. Nunca escribe ninguna tabla. Devuelve el estado ACTUAL de
// Futures (solo el snapshot mas reciente CONFIRMADO por cuenta/posicion),
// valuado a USD via la fuente canonica de precios de Moni Capital
// (lib/prices.js -- la misma que usa el portafolio tradicional).
//
// Snapshots historicos (ej. #34/#35/#54) siguen existiendo en la DB para
// auditoria, pero este endpoint los ignora deliberadamente -- solo el
// mas reciente por account_id/derivative_position_id participa.

import { createClient } from "@supabase/supabase-js";
import { getCryptoData, COINGECKO_FALLBACK_IDS } from "../lib/prices.js";
import { valuateAccountEquity, selectLatestConfirmedSnapshot, selectLatestPositionSnapshot } from "../lib/reconciliationEngine.js";

const supabase = createClient(
  process.env.VITE_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const STALE_THRESHOLD_MS = 24 * 60 * 60 * 1000; // 24h -- no excluye del total, solo marca is_stale

async function resolvePriceUsd(ticker, providerSymbols) {
  const coingeckoId = providerSymbols?.coingecko || COINGECKO_FALLBACK_IDS[ticker];
  if (!coingeckoId) return null;
  try {
    const { price } = await getCryptoData(supabase, ticker, coingeckoId);
    return typeof price === "number" ? price : null;
  } catch {
    return null; // nunca inventa un precio -- PRICE_UNAVAILABLE aguas abajo
  }
}

export default async function handler(req, res) {
  try {
    // ================== 1. Cuentas futures reales ==================
    const { data: futuresAccounts, error: accErr } = await supabase
      .from("accounts").select("id, name, account_type, product_type").eq("account_type", "futures");
    if (accErr) throw accErr;

    // ================== 2. Todos los account_snapshots de esas cuentas ==================
    const accountIds = (futuresAccounts || []).map((a) => a.id);
    const { data: allSnapshots } = accountIds.length
      ? await supabase.from("account_snapshots").select("id, account_id, observed_at, source_import_id").in("account_id", accountIds)
      : { data: [] };

    // Confirmado, por construccion (el RPC solo inserta aqui de forma
    // atomica junto con smart_imports.status='CONFIRMED') -- pero se
    // valida explicitamente de todos modos, sin asumir.
    const importIds = [...new Set((allSnapshots || []).map((s) => s.source_import_id))];
    const { data: confirmedImports } = importIds.length
      ? await supabase.from("smart_imports").select("id, status").in("id", importIds)
      : { data: [] };
    const confirmedIdSet = new Set((confirmedImports || []).filter((i) => i.status === "CONFIRMED").map((i) => i.id));

    const warnings = [];
    const accountsOut = [];
    let totalValueUsd = 0;
    let isComplete = true;

    for (const account of futuresAccounts || []) {
      const latest = selectLatestConfirmedSnapshot(allSnapshots, confirmedIdSet, account.id);
      if (!latest) continue; // cuenta futures sin snapshot confirmado todavia

      const { data: balances } = await supabase
        .from("account_snapshot_balances")
        .select("asset_id, equity_value, available_balance_value, assets(ticker, provider_symbols)")
        .eq("account_snapshot_id", latest.id);

      let accountValueUsd = 0;
      let accountStatus = "OK";
      const balancesOut = [];

      for (const b of balances || []) {
        const ticker = b.assets?.ticker ?? null;
        const equityValue = b.equity_value != null ? Number(b.equity_value) : null;
        const availableValue = b.available_balance_value != null ? Number(b.available_balance_value) : null;
        const priceUsd = equityValue != null && ticker ? await resolvePriceUsd(ticker, b.assets?.provider_symbols) : null;
        const valuation = valuateAccountEquity({ account_id: account.id, asset_id: b.asset_id, equity_value: equityValue, price_usd_per_unit: priceUsd });

        balancesOut.push({ asset_id: b.asset_id, ticker, available_balance_value: availableValue, ...valuation });

        if (valuation.status === "OK") {
          accountValueUsd += valuation.value_usd;
        } else {
          accountStatus = "PARTIAL";
          isComplete = false;
          warnings.push(`${valuation.status}_${ticker ?? b.asset_id}_ACCOUNT_${account.id}`);
        }
      }

      const ageMs = Date.now() - new Date(latest.observed_at).getTime();
      const isStale = ageMs > STALE_THRESHOLD_MS;
      if (isStale) warnings.push(`STALE_SNAPSHOT_ACCOUNT_${account.id}`);

      accountsOut.push({
        account_id: account.id,
        account_name: account.name,
        product_type: account.product_type,
        snapshot_id: latest.id,
        observed_at: latest.observed_at,
        is_stale: isStale,
        value_usd: accountValueUsd,
        valuation_status: accountStatus,
        balances: balancesOut,
      });
      totalValueUsd += accountValueUsd;
    }

    // ================== 3. Posiciones OPEN -- solo el snapshot mas reciente de cada una ==================
    const { data: openPositions } = await supabase
      .from("derivative_positions").select("id, account_id, instrument, side, margin_mode").eq("status", "OPEN");

    // Sprint P0.2 (item 14, performance): antes esto era un for-loop
    // secuencial (1 query por posicion abierta, una tras otra). Las
    // queries son independientes entre si -- Promise.all las dispara
    // todas en paralelo, mismo resultado, sin la latencia acumulada de
    // N round-trips secuenciales a Supabase.
    const positionsOut = [];
    const positionSnapshotResults = await Promise.all(
      (openPositions || []).map((pos) =>
        supabase.from("derivative_position_snapshots").select("*").eq("derivative_position_id", pos.id)
          .then(({ data }) => ({ pos, allPosSnapshots: data }))
      )
    );
    for (const { pos, allPosSnapshots } of positionSnapshotResults) {
      const s = selectLatestPositionSnapshot(allPosSnapshots, pos.id);
      if (!s) continue;
      const ageMs = Date.now() - new Date(s.observed_at).getTime();
      const isStale = ageMs > STALE_THRESHOLD_MS;
      if (isStale) warnings.push(`STALE_SNAPSHOT_POSITION_${pos.id}`);

      positionsOut.push({
        derivative_position_id: pos.id,
        account_id: pos.account_id,
        instrument: pos.instrument,
        side: pos.side,
        leverage: s.leverage != null ? Number(s.leverage) : null,
        margin_mode: pos.margin_mode,
        snapshot_id: s.id,
        observed_at: s.observed_at,
        is_stale: isStale,
        // notional/exposure: RAW tal cual esta persistido -- este
        // endpoint NUNCA los deriva ni los suma a Net Worth.
        notional_value: s.notional_value != null ? Number(s.notional_value) : null,
        notional_asset_id: s.notional_asset_id,
        position_quantity_value: s.position_quantity_value != null ? Number(s.position_quantity_value) : null,
        position_quantity_unit: s.position_quantity_unit,
        entry_price: s.entry_price != null ? Number(s.entry_price) : null,
        mark_price: s.mark_price != null ? Number(s.mark_price) : null,
        liquidation_price: s.liquidation_price != null ? Number(s.liquidation_price) : null,
        unrealized_pnl_value: s.unrealized_pnl_value != null ? Number(s.unrealized_pnl_value) : null,
        roi_pct: s.roi_pct != null ? Number(s.roi_pct) : null,
        unit_semantics_status: s.unit_semantics_status,
      });
    }

    // Sin cache-control: este es un dashboard financiero -- prefiero
    // siempre fresco, nunca correr el riesgo de servir equity/exposure
    // vieja desde CDN/navegador. market-data.js si cachea (precios de
    // mercado cambian constantemente de todos modos), pero equity de
    // cuenta debe reflejar siempre el ultimo snapshot + precio real.
    res.status(200).json({
      total_value_usd: totalValueUsd,
      is_complete: isComplete,
      accounts: accountsOut,
      positions: positionsOut,
      warnings,
    });
  } catch (err) {
    res.status(500).json({ error: "futures_equity_failed", detail: String(err) });
  }
}
