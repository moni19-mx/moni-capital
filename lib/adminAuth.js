// lib/adminAuth.js
//
// Auth pura para los endpoints administrativos temporales
// (api/sec-benchmark-temp.js, api/conviction-benchmark-temp.js). Dos
// caminos, en orden de preferencia:
//
//   1. header x-admin-secret (para automatizacion -- GitHub Actions u
//      otro runner con egress real). Nunca aparece en query string, nunca
//      en historial de navegador, nunca en logs de acceso por URL.
//   2. ?pin= en query string (fallback manual, deprecado para
//      automatizacion -- se mantiene solo para no romper debugging
//      manual existente).
//
// Funcion pura: recibe {headers, query} y un objeto env ya resuelto
// (nunca lee process.env directamente) para que sea testeable sin mocks
// de Vercel. Nunca devuelve ni loguea el valor del secreto -- solo
// {authorized, method}.
export function checkAdminAuth({ headers, query } = {}, env = {}) {
  const headerSecret = headers?.["x-admin-secret"];
  if (headerSecret && env.MONI_ADMIN_SECRET && headerSecret === env.MONI_ADMIN_SECRET) {
    return { authorized: true, method: "header" };
  }

  const pin = query?.pin;
  if (pin && env.MONI_PIN && pin === env.MONI_PIN) {
    return { authorized: true, method: "pin_fallback" };
  }

  return { authorized: false, method: "none" };
}
