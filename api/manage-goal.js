
// api/manage-goal.js
// Metas de planificacion patrimonial. Ahora es una lista real (Bloque 8:
// Metas multiples), no una sola fila. Solo una meta puede ser "principal"
// a la vez -- esa es la que alimenta TODAY, Wealth (Bloque 8) y Goals.
 
import { createClient } from "@supabase/supabase-js";
import { checkRateLimit, recordFailedAttempt } from "../lib/security.js";
 
const supabase = createClient(
  process.env.VITE_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);
 
async function clearOtherPrimaries(exceptId) {
  let q = supabase.from("goals").update({ is_primary: false });
  if (exceptId) q = q.neq("id", exceptId);
  await q.eq("is_primary", true);
}
 
export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "method_not_allowed" });
  }
 
  const { pin, action, goal, id } = req.body || {};
 
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
      if (!goal || !goal.name || !goal.target_amount) {
        return res.status(400).json({ error: "missing_fields" });
      }
      const payload = { ...goal, updated_at: new Date().toISOString() };
      const { data, error } = await supabase.from("goals").insert([payload]).select();
      if (error) throw error;
      if (payload.is_primary && data?.[0]?.id) {
        await clearOtherPrimaries(data[0].id);
      }
      return res.status(200).json({ ok: true, data });
    }
 
    if (action === "update") {
      if (!id || !goal) return res.status(400).json({ error: "missing_fields" });
      const payload = { ...goal, updated_at: new Date().toISOString() };
      const { data, error } = await supabase.from("goals").update(payload).eq("id", id).select();
      if (error) throw error;
      if (payload.is_primary) {
        await clearOtherPrimaries(id);
      }
      return res.status(200).json({ ok: true, data });
    }
 
    if (action === "delete") {
      if (!id) return res.status(400).json({ error: "missing_id" });
      const { error } = await supabase.from("goals").delete().eq("id", id);
      if (error) throw error;
      return res.status(200).json({ ok: true });
    }
 
    return res.status(400).json({ error: "unknown_action" });
  } catch (err) {
    return res.status(500).json({ error: "db_error", detail: String(err.message || err) });
  }
}
