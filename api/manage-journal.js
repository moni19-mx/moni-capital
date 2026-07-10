// api/manage-journal.js
// Investment Journal. 3 acciones, nunca "delete":
// - add: crea una entrada nueva
// - add_outcome: agrega Resultado/Leccion a una entrada EXISTENTE, tocando
//   solo esos campos -- nunca el titulo/contenido/conviccion original.
// - archive: marca archived=true (soft, no destructivo). No existe
//   accion para borrar de verdad -- es una regla de producto, no un
//   descuido.

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

  const { pin, action, entry, id, outcome } = req.body || {};

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
      if (!entry || !entry.title || !entry.content || !entry.date || !entry.type) {
        return res.status(400).json({ error: "missing_fields" });
      }
      const payload = { ...entry, archived: false };
      const { data, error } = await supabase.from("journal_entries").insert([payload]).select();
      if (error) throw error;
      return res.status(200).json({ ok: true, data });
    }

    if (action === "add_outcome") {
      if (!id || !outcome || !outcome.outcome_result) {
        return res.status(400).json({ error: "missing_fields" });
      }
      // Solo estos 3 campos se tocan. Nunca el resto de la entrada.
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
  } catch (err) {
    return res.status(500).json({ error: "db_error", detail: String(err.message || err) });
  }
}
