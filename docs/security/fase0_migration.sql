-- ============================================================
-- MONI CAPITAL — FASE 0 SECURITY HARDENING
-- Aplicado como migración Supabase: fase0_security_hardening_grants_rls
-- (2026-09-09). Solo grants + RLS/policies. Cero cambios a datos, schema
-- financiero, calculos, Smart Import, Futures o RPCs SECURITY DEFINER
-- existentes.
-- ============================================================

-- STEP 1: Reset limpio -- anon Y authenticated pierden TODO privilegio
-- en las 27 tablas (incluye TRUNCATE, el vector critico). service_role
-- y postgres nunca se tocan (rolbypassrls=true, no forman parte de este
-- REVOKE). `authenticated` se deja en cero permanentemente: la app no
-- usa Supabase Auth (cero supabase.auth.* en el codigo, auth.users
-- tiene 0 filas) -- no hay razon para otorgarle nada por simetria con
-- anon.
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM anon, authenticated;

-- STEP 2: Re-otorgar SOLO SELECT, SOLO a anon, SOLO en las 13 tablas
-- que src/App.jsx lee directo con la anon key (verificado por grep
-- exhaustivo: sb() en App.jsx:41-47 + fetch directo de smart_imports en
-- App.jsx:3983).
GRANT SELECT ON TABLE
  public.positions,
  public.watchlist,
  public.thesis,
  public.snapshots,
  public.cash_movements,
  public.transactions,
  public.goals,
  public.journal_entries,
  public.decisions,
  public.rebalance_targets,
  public.ai_insights,
  public.accounts,
  public.smart_imports
TO anon;

-- STEP 3: Habilitar RLS en accounts/smart_imports (les faltaba) con el
-- mismo patron ya usado en las otras 11 tablas de este grupo -- app
-- personal de un solo usuario, sin columna user_id en ninguna tabla, asi
-- que no hay forma real de particionar por fila hoy.
ALTER TABLE public.accounts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Enable read access for all users" ON public.accounts
  FOR SELECT TO public USING (true);

ALTER TABLE public.smart_imports ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Enable read access for all users" ON public.smart_imports
  FOR SELECT TO public USING (true);

-- STEP 4: Habilitar RLS (sin ninguna policy = default-deny para
-- anon/authenticated; service_role/postgres bypasean RLS de todos modos)
-- en las 10 tablas que estaban totalmente abiertas.
ALTER TABLE public.assets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.derivative_positions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.derivative_position_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.account_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.account_snapshot_balances ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.smart_import_images ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fmp_benchmark_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fmp_benchmark_conflicts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sec_financials ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sec_financials_normalized ENABLE ROW LEVEL SECURITY;

-- STEP 5: Quitar las 3 policies publicas de tablas Grupo B que SI tenian
-- una (market_cache, ai_conversations, ai_usage -- pin_attempts nunca
-- tuvo policy, ya estaba cerrada por RLS-enabled-sin-policy). Sus grants
-- ya quedaron en cero en STEP 1, pero dejar la policy viva reabriria
-- lectura publica en silencio si alguien vuelve a otorgar SELECT en el
-- futuro sin darse cuenta de que la policy sigue ahi.
DROP POLICY "Enable read access for all users" ON public.market_cache;
DROP POLICY "Enable read access for all users" ON public.ai_conversations;
DROP POLICY "Enable read access for all users" ON public.ai_usage;
