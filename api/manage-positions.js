// api/manage-positions.js
// Unica puerta de escritura hacia Supabase. Requiere el PIN correcto
// (guardado como variable de entorno MONI_PIN) para add/update/delete.

import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.VITE_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "method_not_allowed" });
  }

  const { pin, action, position, id } = req.body || {};

  if (!pin || pin !== process.env.MONI_PIN) {
    return res.status(401).json({ error: "invalid_pin" });
  }

  try {
    if (action === "add") {
      if (!position || !position.ticker || !position.type) {
        return res.status(400).json({ error: "missing_fields" });
      }
      const { data, error } = await supabase.from("positions").insert([position]).select();
      if (error) throw error;
      return res.status(200).json({ ok: true, data });
    }

    if (action === "update") {
      if (!id) return res.status(400).json({ error: "missing_id" });
      const { data, error } = await supabase.from("positions").update(position).eq("id", id).select();
      if (error) throw error;
      return res.status(200).json({ ok: true, data });
    }

    if (action === "delete") {
      if (!id) return res.status(400).json({ error: "missing_id" });
      const { error } = await supabase.from("positions").delete().eq("id", id);
      if (error) throw error;
      return res.status(200).json({ ok: true });
    }

    return res.status(400).json({ error: "unknown_action" });
  } catch (err) {
    return res.status(500).json({ error: "db_error", detail: String(err.message || err) });
  }
}
