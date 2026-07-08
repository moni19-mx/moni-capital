// api/manage-cash.js
// Agrega o borra movimientos de efectivo (depositos/retiros). El balance de
// efectivo se calcula en el frontend como la suma de estos movimientos, no
// se guarda un "total" aparte -- asi nunca se desincroniza.

import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.VITE_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "method_not_allowed" });
  }

  const { pin, action, movement, id } = req.body || {};

  if (!pin || pin !== process.env.MONI_PIN) {
    return res.status(401).json({ error: "invalid_pin" });
  }

  try {
    if (action === "add") {
      if (!movement || !movement.type || !movement.amount || !movement.date) {
        return res.status(400).json({ error: "missing_fields" });
      }
      if (movement.type !== "deposito" && movement.type !== "retiro") {
        return res.status(400).json({ error: "invalid_type" });
      }
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
  } catch (err) {
    return res.status(500).json({ error: "db_error", detail: String(err.message || err) });
  }
}
