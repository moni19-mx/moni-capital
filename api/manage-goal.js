// api/manage-goal.js
// Guarda/actualiza la meta patrimonial (una sola fila, upsert). Protegida
// por el mismo PIN y el mismo limite de intentos que el resto.

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

  const { pin, target_amount } = req.body || {};

  const { blocked } = await checkRateLimit(supabase);
  if (blocked) {
    return res.status(429).json({ error: "rate_limited", detail: "Demasiados intentos fallidos. Espera unos minutos e intenta de nuevo." });
  }

  if (!pin || pin !== process.env.MONI_PIN) {
    await recordFailedAttempt(supabase);
    return res.status(401).json({ error: "invalid_pin" });
  }

  if (!target_amount || Number(target_amount) <= 0) {
    return res.status(400).json({ error: "invalid_amount" });
  }

  try {
    const { data: existing } = await supabase.from("goals").select("id").limit(1).maybeSingle();
    if (existing) {
      const { data, error } = await supabase
        .from("goals")
        .update({ target_amount: Number(target_amount), updated_at: new Date().toISOString() })
        .eq("id", existing.id)
        .select();
      if (error) throw error;
      return res.status(200).json({ ok: true, data });
    } else {
      const { data, error } = await supabase
        .from("goals")
        .insert([{ target_amount: Number(target_amount), updated_at: new Date().toISOString() }])
        .select();
      if (error) throw error;
      return res.status(200).json({ ok: true, data });
    }
  } catch (err) {
    return res.status(500).json({ error: "db_error", detail: String(err.message || err) });
  }
}
