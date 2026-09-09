# Moni Capital — Modelo de acceso a Supabase (Fase 0 Security Hardening)

> Documento de registro de la Fase 0 de hardening de seguridad (grants + RLS).
> No mezcla otros hallazgos del roadmap — solo el modelo de acceso a datos.
> Ejecutado: 2026-09-09. Migración Supabase: `fase0_security_hardening_grants_rls`.

## Principio

La `SUPABASE_ANON_KEY` en el bundle del navegador (`src/App.jsx:16-17`) **no es el
problema** — las anon/publishable keys están diseñadas para existir en clientes.
El problema real era qué privilegios tenía esa key a nivel de tabla: antes de esta
fase, `anon` y `authenticated` tenían los 7 privilegios de Postgres (`SELECT`,
`INSERT`, `UPDATE`, `DELETE`, `TRUNCATE`, `REFERENCES`, `TRIGGER`) en las 27 tablas
del schema `public` — incluyendo `TRUNCATE`, que Postgres **no sujeta a Row Level
Security**, así que ninguna política de RLS lo mitigaba.

La solución es GRANTS + RLS + rutas de acceso server-side correctas — nunca ocultar
la key.

## Modelo final

**`authenticated` no se usa en esta app** (cero `supabase.auth.*` en el código,
`auth.users` tiene 0 filas) — no tiene ningún privilegio en ninguna tabla, por
principio de mínimo privilegio, no por simetría con `anon`.

### Grupo A — client-readable (anon, solo SELECT)

Las únicas 13 tablas que `src/App.jsx` lee directo con la anon key (verificado por
grep exhaustivo del repo: helper `sb()` en `App.jsx:41-47` + el fetch directo de
`smart_imports` por id en `App.jsx:3983`). Ninguna escritura directa existe en el
frontend — todas las mutaciones pasan por `/api/*` con `service_role`.

`positions`, `watchlist`, `thesis`, `snapshots`, `cash_movements`, `transactions`,
`goals`, `journal_entries`, `decisions`, `rebalance_targets`, `ai_insights`,
`accounts`, `smart_imports`

RLS enabled + policy `"Enable read access for all users"` (`FOR SELECT TO public
USING (true)"`) — app personal de un solo usuario, sin columna `user_id` en ninguna
tabla, así que no hay partición por fila posible hoy. `anon` tiene únicamente
`GRANT SELECT`.

### Grupo B — server-only (ya tenían RLS, exposición de SELECT innecesaria)

`market_cache`, `pin_attempts`, `ai_conversations`, `ai_usage`

Nunca leídas directo por el frontend (van por `/api/market-data`, `/api/ai`, o son
puramente internas como `pin_attempts`). RLS enabled, sin ninguna policy (deny-all
para `anon`/`authenticated`). `pin_attempts` ya estaba así antes de esta fase; a
`market_cache`, `ai_conversations`, `ai_usage` se les quitó la policy pública que
tenían.

### Grupo C — Futures/assets server-only (RLS estaba deshabilitado)

`assets`, `derivative_positions`, `derivative_position_snapshots`,
`account_snapshots`, `account_snapshot_balances`, `smart_import_images`

Solo tocadas por `service_role` vía `api/smart-import.js`, `api/futures-equity.js`,
`lib/assetResolver.js`. RLS ahora enabled, sin policy.

### Grupo D — diagnóstico/benchmark server-only (RLS estaba deshabilitado)

`fmp_benchmark_results`, `fmp_benchmark_conflicts`, `sec_financials`,
`sec_financials_normalized`

Solo tocadas por `api/fmp-benchmark-temp.js` / `api/sec-benchmark-temp.js`
(`service_role`). RLS ahora enabled, sin policy.

## Server-side / financial writes

Todas las escrituras financieras (`positions`, `transactions`, `cash_movements`,
`goals`, `thesis`, `watchlist`, `decisions`, `rebalance_targets`, `journal_entries`,
Smart Import, Futures) pasan exclusivamente por `/api/*.js` (Vercel serverless),
cada uno instanciando su cliente Supabase con `SUPABASE_SERVICE_ROLE_KEY`
(`process.env.SUPABASE_SERVICE_ROLE_KEY`). `service_role` y `postgres` tienen
`rolbypassrls = true` en `pg_roles` — ignoran RLS por completo — y esta fase nunca
tocó sus grants ni los de las 3 funciones `SECURITY DEFINER`
(`confirm_smart_import_transaction`, `confirm_smart_import_futures_account_snapshot`,
`confirm_smart_import_futures_position_snapshot`) ni los 5 triggers append-only
existentes.

## SQL aplicado (migración `fase0_security_hardening_grants_rls`)

Ver `docs/security/fase0_migration.sql` en este mismo directorio para el SQL
exacto ejecutado.

## Rollback exacto

Ver `docs/security/fase0_rollback.sql` — restaura el estado PRE (los 7 privilegios
completos a `anon`/`authenticated` en las 27 tablas, RLS deshabilitado en las 12
tablas que originalmente no lo tenían, y las 3 policies públicas eliminadas de
`market_cache`/`ai_conversations`/`ai_usage` restauradas). `pin_attempts` nunca tuvo
esa policy — el rollback no la toca.
