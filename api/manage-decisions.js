// api/manage-decisions.js
// Decision Queue / History del Command Center.
// - sync: recibe la lista de senales EN VIVO (ya calculadas por el
//   frontend con las mismas formulas de TODAY/Goals) y crea/actualiza una
//   fila "abierta" por cada una, deduplicando por (type, ticker). No pide
//   PIN porque solo registra un estado objetivo del sistema, no modifica
//   nada financiero.
// - resolve: marca una decision como "revisada" o "ignorada". Pide PIN
//   por consistencia con el resto de la app.
 
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
 
  const { action, signals, pin, id, status } = req.body || {};
 
  try {
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
            title: s.title, detail: s.detail || null, status: "abierta",
            created_at: new Date().toISOString(),
          });
        }
      }
      if (toInsert.length) {
        await supabase.from("decisions").insert(toInsert);
      }
      return res.status(200).json({ ok: true, created: toInsert.length });
    }
 
    if (action === "resolve") {
      const { blocked } = await checkRateLimit(supabase);
      if (blocked) {
        return res.status(429).json({ error: "rate_limited", detail: "Demasiados intentos fallidos. Espera unos minutos e intenta de nuevo." });
      }
      if (!pin || pin !== process.env.MONI_PIN) {
        await recordFailedAttempt(supabase);
        return res.status(401).json({ error: "invalid_pin" });
      }
      if (!id || !status) return res.status(400).json({ error: "missing_fields" });
      const { data, error } = await supabase
        .from("decisions")
        .update({ status, resolved_at: new Date().toISOString() })
        .eq("id", id)
        .select();
      if (error) throw error;
      return res.status(200).json({ ok: true, data });
    }
 
    return res.status(400).json({ error: "unknown_action" });
  } catch (err) {
    return res.status(500).json({ error: "db_error", detail: String(err.message || err) });
  }
}
 
