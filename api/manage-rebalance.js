// api/manage-rebalance.js
// CRUD de objetivos de rebalanceo (% objetivo por tema o rol estrategico).
// Mismo patron de siempre: PIN + limite de intentos.
 
import { createClient } from "@supabase/supabase-js";
import { checkRateLimit, recordFailedAttempt } from "../lib/security.js";
 
const supabase = createClient(
  process.env.VITE_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);
 
export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "method_not_allowed" });
  }
 
  const { pin, action, target, id } = req.body || {};
 
  const { blocked } = await checkRateLimit(supabase);
  if (blocked) {
    return res.status(429).json({ error: "rate_limited", detail: "Demasiados intentos fallidos. Espera unos minutos e intenta de nuevo." });
  }
 
  if (!pin || pin !== process.env.MONI_PIN) {
    await recordFailedAttempt(supabase);
    return res.status(401).json({ error: "invalid_pin" });
  }
 
  try {
    if (action === "add") {
      if (!target || !target.dimension || !target.label || target.target_pct == null) {
        return res.status(400).json({ error: "missing_fields" });
      }
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
  } catch (err) {
    return res.status(500).json({ error: "db_error", detail: String(err.message || err) });
  }
}
 
