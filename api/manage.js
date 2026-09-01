// api/manage.js
// Punto de entrada UNICO para todas las escrituras protegidas por PIN.
// Antes eran 8 archivos separados (manage-positions, manage-watchlist,
// manage-thesis, manage-cash, manage-goal, manage-journal,
// manage-decisions, manage-rebalance) -- cada archivo en /api cuenta como
// una "Serverless Function" en el plan gratuito de Vercel, y con 8 + otros
// 4 (market-data, search, snapshot, market-pulse) se paso del limite de 12.
// Consolidar aqui es la arquitectura correcta, no un parche: mismo
// comportamiento exacto, un solo archivo. El frontend ahora manda
// { resource: "positions"|"watchlist"|"thesis"|"cash"|"goal"|"journal"|
//   "decisions"|"rebalance"|"assets", ...resto del payload de siempre }.
//
// Asset Master (Fase 0, Paso 6 -- revision critica): ningun write path
// crea un asset nuevo como efecto secundario. positions/watchlist/thesis
// SIEMPRE resuelven contra `assets` primero -- si el ticker no existe,
// devuelven UNKNOWN_ASSET y detienen la escritura. La creacion de un
// asset nuevo es una accion explicita separada (resource: "assets",
// action: "create"), nunca implicita.

import { createClient } from "@supabase/supabase-js";
import { checkRateLimit, recordFailedAttempt } from "../lib/security.js";

const supabase = createClient(
  process.env.VITE_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Verifica PIN + rate limit. Si falla, ya responde el error y devuelve false
// -- el handler que llama debe hacer `if (!(await requirePin(...))) return;`
async function requirePin(res, pin) {
  const { blocked } = await checkRateLimit(supabase);
  if (blocked) {
    res.status(429).json({ error: "rate_limited", detail: "Demasiados intentos fallidos. Espera unos minutos e intenta de nuevo." });
    return false;
  }
  if (!pin || pin !== process.env.MONI_PIN) {
    await recordFailedAttempt(supabase);
    res.status(401).json({ error: "invalid_pin" });
    return false;
  }
  return true;
}

// ==================================================
// ASSET MASTER -- resolveAsset / createAsset
// ==================================================
// Normalizacion minima y segura: trim + uppercase. No se inventan
// equivalencias (no se mapea "Apple" -> "AAPL" aqui, eso requeriria una
// fuente de verdad de nombres que no tenemos todavia -- fuera de alcance
// de V1).
function normalizeTicker(input) {
  if (input == null) return null;
  const t = String(input).trim().toUpperCase();
  return t.length > 0 ? t : null;
}

// Solo LEE. Nunca crea. Devuelve el asset existente, "unknown" (no
// existe, puede crearse explicitamente), o "ambiguous" (mas de un
// candidato -- no debería pasar dado el UNIQUE(ticker) actual, pero se
// deja preparado para cuando el criterio de unicidad cambie).
async function resolveAsset(rawTicker) {
  const ticker = normalizeTicker(rawTicker);
  if (!ticker) return { status: "error", error: "missing_ticker" };

  const { data, error } = await supabase.from("assets").select("*").eq("ticker", ticker);
  if (error) throw error;

  if (!data || data.length === 0) {
    return { status: "unknown", ticker };
  }
  if (data.length > 1) {
    return { status: "ambiguous", ticker, candidates: data };
  }
  return { status: "ok", asset: data[0] };
}

// Accion EXPLICITA. Requiere que el llamador ya haya decidido crear el
// asset (el usuario confirmo en el modal, o un flujo futuro de Smart
// Import lo solicito explicitamente con el created_source correcto).
// Vuelve a chequear colision antes de insertar (protege contra doble
// click / requests concurrentes).
async function createAsset({ ticker, name, asset_type, exchange, currency, provider_symbols, created_source }) {
  const normalizedTicker = normalizeTicker(ticker);
  if (!normalizedTicker) return { status: "error", error: "missing_ticker" };

  const { data: existing, error: findErr } = await supabase.from("assets").select("*").eq("ticker", normalizedTicker);
  if (findErr) throw findErr;
  if (existing && existing.length === 1) {
    return { status: "ok", asset: existing[0], already_existed: true };
  }
  if (existing && existing.length > 1) {
    return { status: "ambiguous", ticker: normalizedTicker, candidates: existing };
  }

  const payload = {
    ticker: normalizedTicker,
    name: name || null,
    asset_type: asset_type || null,
    exchange: exchange || null,
    currency: currency || "USD",
    provider_symbols: provider_symbols || {},
    is_active: true,
    created_source: created_source || "MANUAL",
  };
  const { data, error } = await supabase.from("assets").insert([payload]).select();
  if (error) throw error;
  return { status: "ok", asset: data[0], already_existed: false };
}

async function handleAssets(req, res, body) {
  const { pin, action, ticker } = body;
  if (action === "resolve") {
    // Solo lectura -- no requiere PIN, igual que las lecturas de otras
    // tools de Moni AI. Ajustar si se prefiere requerir PIN tambien aqui.
    const result = await resolveAsset(ticker);
    return res.status(200).json(result);
  }
  if (action === "create") {
    if (!(await requirePin(res, pin))) return;
    const { name, asset_type, exchange, currency, provider_symbols, created_source } = body;
    const result = await createAsset({ ticker, name, asset_type, exchange, currency, provider_symbols, created_source });
    return res.status(200).json(result);
  }
  return res.status(400).json({ error: "unknown_action" });
}

async function handlePositions(req, res, body) {
  const { pin, action, position, id } = body;
  if (!(await requirePin(res, pin))) return;
  if (action === "add") {
    if (!position || !position.ticker || !position.type) return res.status(400).json({ error: "missing_fields" });
    const resolved = await resolveAsset(position.ticker);
    if (resolved.status === "unknown") {
      return res.status(409).json({ error: "UNKNOWN_ASSET", ticker: resolved.ticker, can_create: true });
    }
    if (resolved.status === "ambiguous") {
      return res.status(409).json({ error: "ASSET_AMBIGUOUS", ticker: resolved.ticker, candidates: resolved.candidates });
    }
    const payload = { ...position, asset_id: resolved.asset.asset_id };
    const { data, error } = await supabase.from("positions").insert([payload]).select();
    if (error) throw error;
    if (position.type !== "cash") {
      try {
        await supabase.from("transactions").insert([{
          date: new Date().toISOString().slice(0, 10), ticker: position.ticker, asset_id: resolved.asset.asset_id,
          type: "compra", amount: -Math.abs(Number(position.cost_basis)), quantity: Number(position.shares),
          notes: "Agregado desde Gestionar",
        }]);
      } catch (e) { /* no debe tumbar el guardado de la posicion */ }
    }
    return res.status(200).json({ ok: true, data });
  }
  if (action === "update") {
    if (!id) return res.status(400).json({ error: "missing_id" });
    const { data, error } = await supabase.from("positions").update(position).eq("id", id).select();
    if (error) throw error;
    return res.status(200).json({ ok: true, data });
  }
  if (action === "merge_buy") {
    // Suma una compra nueva a una posicion que YA existe -- evita crear una
    // fila duplicada por el mismo ticker (el bug que causo BTC/MSFT/ORCL
    // duplicados). El servidor hace la suma, nunca el navegador, para que
    // no haya dos calculos distintos si dos pestañas mandan la misma compra.
    // No hay que resolver asset_id aqui -- `existing` ya tiene el correcto,
    // la posicion ya paso por el guard de identidad cuando se creo.
    if (!id || !position || position.shares == null || position.cost_basis == null) {
      return res.status(400).json({ error: "missing_fields" });
    }
    const { data: existing, error: findErr } = await supabase.from("positions").select("*").eq("id", id).maybeSingle();
    if (findErr) throw findErr;
    if (!existing) return res.status(404).json({ error: "position_not_found" });

    const newShares = Number(existing.shares) + Number(position.shares);
    const newCostBasis = Number(existing.cost_basis) + Number(position.cost_basis);
    const { data, error } = await supabase.from("positions").update({ shares: newShares, cost_basis: newCostBasis }).eq("id", id).select();
    if (error) throw error;

    if (existing.type !== "cash") {
      try {
        await supabase.from("transactions").insert([{
          date: new Date().toISOString().slice(0, 10), ticker: existing.ticker, asset_id: existing.asset_id,
          type: "compra", amount: -Math.abs(Number(position.cost_basis)), quantity: Number(position.shares),
          notes: "Compra adicional sumada a posición existente desde Gestionar",
        }]);
      } catch (e) { /* no debe tumbar el guardado */ }
    }
    return res.status(200).json({ ok: true, data });
  }
  if (action === "delete") {
    if (!id) return res.status(400).json({ error: "missing_id" });
    const { error } = await supabase.from("positions").delete().eq("id", id);
    if (error) throw error;
    return res.status(200).json({ ok: true });
  }
  return res.status(400).json({ error: "unknown_action" });
}

async function handleWatchlist(req, res, body) {
  const { pin, action, item, id } = body;
  if (!(await requirePin(res, pin))) return;
  if (action === "add") {
    if (!item || !item.ticker || !item.type) return res.status(400).json({ error: "missing_fields" });
    const resolved = await resolveAsset(item.ticker);
    if (resolved.status === "unknown") {
      return res.status(409).json({ error: "UNKNOWN_ASSET", ticker: resolved.ticker, can_create: true });
    }
    if (resolved.status === "ambiguous") {
      return res.status(409).json({ error: "ASSET_AMBIGUOUS", ticker: resolved.ticker, candidates: resolved.candidates });
    }
    const payload = { status: "investigando", ...item, asset_id: resolved.asset.asset_id };
    const { data, error } = await supabase.from("watchlist").insert([payload]).select();
    if (error) throw error;
    return res.status(200).json({ ok: true, data });
  }
  if (action === "update") {
    if (!id) return res.status(400).json({ error: "missing_id" });
    const { data, error } = await supabase.from("watchlist").update(item).eq("id", id).select();
    if (error) throw error;
    return res.status(200).json({ ok: true, data });
  }
  if (action === "delete") {
    if (!id) return res.status(400).json({ error: "missing_id" });
    const { error } = await supabase.from("watchlist").delete().eq("id", id);
    if (error) throw error;
    return res.status(200).json({ ok: true });
  }
  return res.status(400).json({ error: "unknown_action" });
}

async function handleThesis(req, res, body) {
  const { pin, ticker, fields } = body;
  if (!(await requirePin(res, pin))) return;
  if (!ticker) return res.status(400).json({ error: "missing_ticker" });

  const resolved = await resolveAsset(ticker);
  if (resolved.status === "unknown") {
    return res.status(409).json({ error: "UNKNOWN_ASSET", ticker: resolved.ticker, can_create: true });
  }
  if (resolved.status === "ambiguous") {
    return res.status(409).json({ error: "ASSET_AMBIGUOUS", ticker: resolved.ticker, candidates: resolved.candidates });
  }

  const payload = { ticker, asset_id: resolved.asset.asset_id, ...(fields || {}), updated_at: new Date().toISOString() };
  const { data: existing, error: findErr } = await supabase.from("thesis").select("id").eq("ticker", ticker).maybeSingle();
  if (findErr) throw findErr;
  if (existing) {
    const { data, error } = await supabase.from("thesis").update(payload).eq("id", existing.id).select();
    if (error) throw error;
    return res.status(200).json({ ok: true, data });
  } else {
    const { data, error } = await supabase.from("thesis").insert([payload]).select();
    if (error) throw error;
    return res.status(200).json({ ok: true, data });
  }
}

async function handleCash(req, res, body) {
  const { pin, action, movement, id } = body;
  if (!(await requirePin(res, pin))) return;
  if (action === "add") {
    if (!movement || !movement.type || !movement.amount || !movement.date) return res.status(400).json({ error: "missing_fields" });
    if (movement.type !== "deposito" && movement.type !== "retiro") return res.status(400).json({ error: "invalid_type" });
    const { data, error } = await supabase.from("cash_movements").insert([movement]).select();
    if (error) throw error;
    return res.status(200).json({ ok: true, data });
  }
  if (action === "delete") {
    if (!id) return res.status(400).json({ error: "missing_id" });
    const { error } = await supabase.from("cash_movements").delete().eq("id", id);
    if (error) throw error;
    return res.status(200).json({ ok: true });
  }
  return res.status(400).json({ error: "unknown_action" });
}

async function clearOtherPrimaryGoals(exceptId) {
  let q = supabase.from("goals").update({ is_primary: false });
  if (exceptId) q = q.neq("id", exceptId);
  await q.eq("is_primary", true);
}

async function handleGoal(req, res, body) {
  const { pin, action, goal, id } = body;
  if (!(await requirePin(res, pin))) return;
  if (action === "add") {
    if (!goal || !goal.name || !goal.target_amount) return res.status(400).json({ error: "missing_fields" });
    const payload = { ...goal, updated_at: new Date().toISOString() };
    const { data, error } = await supabase.from("goals").insert([payload]).select();
    if (error) throw error;
    if (payload.is_primary && data?.[0]?.id) await clearOtherPrimaryGoals(data[0].id);
    return res.status(200).json({ ok: true, data });
  }
  if (action === "update") {
    if (!id || !goal) return res.status(400).json({ error: "missing_fields" });
    const payload = { ...goal, updated_at: new Date().toISOString() };
    const { data, error } = await supabase.from("goals").update(payload).eq("id", id).select();
    if (error) throw error;
    if (payload.is_primary) await clearOtherPrimaryGoals(id);
    return res.status(200).json({ ok: true, data });
  }
  if (action === "delete") {
    if (!id) return res.status(400).json({ error: "missing_id" });
    const { error } = await supabase.from("goals").delete().eq("id", id);
    if (error) throw error;
    return res.status(200).json({ ok: true });
  }
  return res.status(400).json({ error: "unknown_action" });
}

async function handleJournal(req, res, body) {
  const { pin, action, entry, id, outcome } = body;
  if (!(await requirePin(res, pin))) return;
  if (action === "add") {
    if (!entry || !entry.title || !entry.content || !entry.date || !entry.type) return res.status(400).json({ error: "missing_fields" });
    const payload = { ...entry, archived: false };
    const { data, error } = await supabase.from("journal_entries").insert([payload]).select();
    if (error) throw error;
    return res.status(200).json({ ok: true, data });
  }
  if (action === "add_outcome") {
    if (!id || !outcome || !outcome.outcome_result) return res.status(400).json({ error: "missing_fields" });
    const safePayload = {
      outcome_result: outcome.outcome_result,
      outcome_lesson: outcome.outcome_lesson || null,
      outcome_date: outcome.outcome_date || new Date().toISOString().slice(0, 10),
    };
    const { data, error } = await supabase.from("journal_entries").update(safePayload).eq("id", id).select();
    if (error) throw error;
    return res.status(200).json({ ok: true, data });
  }
  if (action === "archive") {
    if (!id) return res.status(400).json({ error: "missing_id" });
    const { data, error } = await supabase.from("journal_entries").update({ archived: true }).eq("id", id).select();
    if (error) throw error;
    return res.status(200).json({ ok: true, data });
  }
  return res.status(400).json({ error: "unknown_action" });
}

async function handleDecisions(req, res, body) {
  const { action, signals, pin, id, status } = body;
  if (action === "sync") {
    if (!Array.isArray(signals)) return res.status(400).json({ error: "missing_signals" });
    const { data: open } = await supabase.from("decisions").select("*").eq("status", "abierta");
    const openMap = {};
    (open || []).forEach((d) => { openMap[`${d.type}::${d.ticker || ""}::${d.title}`] = d; });
    const toInsert = [];
    for (const s of signals) {
      const key = `${s.type}::${s.ticker || ""}::${s.title}`;
      if (!openMap[key]) {
        toInsert.push({
          type: s.type, ticker: s.ticker || null, priority: s.priority || "media",
          title: s.title, detail: s.detail || null, status: "abierta", created_at: new Date().toISOString(),
        });
      }
    }
    if (toInsert.length) await supabase.from("decisions").insert(toInsert);
    return res.status(200).json({ ok: true, created: toInsert.length });
  }
  if (action === "resolve") {
    if (!(await requirePin(res, pin))) return;
    if (!id || !status) return res.status(400).json({ error: "missing_fields" });
    const { data, error } = await supabase.from("decisions").update({ status, resolved_at: new Date().toISOString() }).eq("id", id).select();
    if (error) throw error;
    return res.status(200).json({ ok: true, data });
  }
  return res.status(400).json({ error: "unknown_action" });
}

async function handleRebalance(req, res, body) {
  const { pin, action, target, id } = body;
  if (!(await requirePin(res, pin))) return;
  if (action === "add") {
    if (!target || !target.dimension || !target.label || target.target_pct == null) return res.status(400).json({ error: "missing_fields" });
    const { data, error } = await supabase.from("rebalance_targets").insert([target]).select();
    if (error) throw error;
    return res.status(200).json({ ok: true, data });
  }
  if (action === "update") {
    if (!id) return res.status(400).json({ error: "missing_id" });
    const { data, error } = await supabase.from("rebalance_targets").update(target).eq("id", id).select();
    if (error) throw error;
    return res.status(200).json({ ok: true, data });
  }
  if (action === "delete") {
    if (!id) return res.status(400).json({ error: "missing_id" });
    const { error } = await supabase.from("rebalance_targets").delete().eq("id", id);
    if (error) throw error;
    return res.status(200).json({ ok: true });
  }
  return res.status(400).json({ error: "unknown_action" });
}

const HANDLERS = {
  assets: handleAssets,
  positions: handlePositions,
  watchlist: handleWatchlist,
  thesis: handleThesis,
  cash: handleCash,
  goal: handleGoal,
  journal: handleJournal,
  decisions: handleDecisions,
  rebalance: handleRebalance,
};

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "method_not_allowed" });
  }
  const { resource, ...body } = req.body || {};
  const fn = HANDLERS[resource];
  if (!fn) {
    return res.status(400).json({ error: "unknown_resource" });
  }
  try {
    await fn(req, res, body);
  } catch (err) {
    if (!res.headersSent) {
      res.status(500).json({ error: "db_error", detail: String(err.message || err) });
    }
  }
}
