// api/snapshot.js
// Guarda "la foto de hoy" del patrimonio para poder graficar su evolucion.
// No requiere PIN porque no modifica ni borra posiciones reales, solo
// registra un numero observado. Esta protegido de otra forma: la fecha la
// decide el SERVIDOR (no el cliente), y es upsert por fecha unica, asi que
// como mucho alguien podria sobre-escribir el dato de HOY, nunca inflar
// el historial con filas falsas de otros dias.

import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.VITE_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "method_not_allowed" });
  }

  try {
    const { patrimonio, invested, stocksValue, cryptoValue, cashValue } = req.body || {};
    const nums = [patrimonio, invested, stocksValue, cryptoValue, cashValue];
    if (nums.some((n) => typeof n !== "number" || !isFinite(n))) {
      return res.status(400).json({ error: "invalid_numbers" });
    }

    const today = new Date().toISOString().slice(0, 10);

    const { data, error } = await supabase
      .from("snapshots")
      .upsert(
        [{
          date: today,
          patrimonio,
          invested,
          stocks_value: stocksValue,
          crypto_value: cryptoValue,
          cash_value: cashValue,
        }],
        { onConflict: "date" }
      )
      .select();

    if (error) throw error;
    res.status(200).json({ ok: true, data });
  } catch (err) {
    res.status(500).json({ error: "snapshot_failed", detail: String(err.message || err) });
  }
}
