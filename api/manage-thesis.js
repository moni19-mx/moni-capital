// api/manage-thesis.js
// Guarda/actualiza la ficha de Investment Thesis de un ticker (upsert por
// ticker). Protegida por el mismo PIN que las demas escrituras.
// Espera: { pin, ticker, fields: { conviction, why_bought, what_special, sell_trigger, horizon, risks } }

import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.VITE_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "method_not_allowed" });
  }

  const { pin, ticker, fields } = req.body || {};

  if (!pin || pin !== process.env.MONI_PIN) {
    return res.status(401).json({ error: "invalid_pin" });
  }

  if (!ticker) {
    return res.status(400).json({ error: "missing_ticker" });
  }

  const payload = { ticker, ...(fields || {}) };

  try {
    const { data: existing, error: findErr } = await supabase
      .from("thesis")
      .select("id")
      .eq("ticker", ticker)
      .maybeSingle();
    if (findErr) throw findErr;

    if (existing) {
      const { data, error } = await supabase
        .from("thesis")
        .update(payload)
        .eq("id", existing.id)
        .select();
      if (error) throw error;
      return res.status(200).json({ ok: true, data });
    } else {
      const { data, error } = await supabase.from("thesis").insert([payload]).select();
      if (error) throw error;
      return res.status(200).json({ ok: true, data });
    }
  } catch (err) {
    return res.status(500).json({ error: "db_error", detail: String(err.message || err) });
  }
}
