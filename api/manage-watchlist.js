// api/manage-watchlist.js
// Igual que manage-positions.js pero para la tabla watchlist (activos que
// vigilas, no que posees). Requiere el mismo PIN.

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

  const { pin, action, item, id } = req.body || {};

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
      if (!item || !item.ticker || !item.type) {
        return res.status(400).json({ error: "missing_fields" });
      }
      const payload = { status: "investigando", ...item };
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
  } catch (err) {
    return res.status(500).json({ error: "db_error", detail: String(err.message || err) });
  }
}
