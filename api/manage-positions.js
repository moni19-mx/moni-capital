// api/manage-positions.js
// Unica puerta de escritura hacia Supabase. Requiere el PIN correcto
// (guardado como variable de entorno MONI_PIN) para add/update/delete.

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

  const { pin, action, position, id } = req.body || {};

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
      if (!position || !position.ticker || !position.type) {
        return res.status(400).json({ error: "missing_fields" });
      }
      const { data, error } = await supabase.from("positions").insert([position]).select();
      if (error) throw error;

      // Cada compra nueva desde Gestionar tambien queda en el Historial,
      // para que ambas vistas cuenten siempre la misma historia.
      if (position.type !== "cash") {
        try {
          await supabase.from("transactions").insert([{
            date: new Date().toISOString().slice(0, 10),
            ticker: position.ticker,
            type: "compra",
            amount: -Math.abs(Number(position.cost_basis)),
            quantity: Number(position.shares),
            notes: "Agregado desde Gestionar",
          }]);
        } catch (e) {
          // si esto falla, no debe tumbar el guardado de la posicion
        }
      }

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
