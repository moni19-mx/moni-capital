// lib/security.js
// Limite simple de intentos fallidos de PIN, compartido por todas las
// funciones que escriben datos. No es por IP (app personal, no lo necesita)
// -- es un freno global: si hay demasiados intentos fallidos recientes en
// CUALQUIER endpoint, se bloquean nuevos intentos por un rato.

const WINDOW_MS = 15 * 60 * 1000; // 15 minutos
const MAX_ATTEMPTS = 8;

export async function checkRateLimit(supabase) {
  try {
    const since = new Date(Date.now() - WINDOW_MS).toISOString();
    const { count, error } = await supabase
      .from("pin_attempts")
      .select("id", { count: "exact", head: true })
      .gte("created_at", since);
    if (error) return { blocked: false }; // si falla la lectura, no bloqueamos al usuario legitimo
    if ((count || 0) >= MAX_ATTEMPTS) {
      return { blocked: true };
    }
    return { blocked: false };
  } catch (e) {
    return { blocked: false };
  }
}

export async function recordFailedAttempt(supabase) {
  try {
    await supabase.from("pin_attempts").insert([{}]);
  } catch (e) {
    // no pasa nada si falla el registro, no debe tronar la peticion principal
  }
}
