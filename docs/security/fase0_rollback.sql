-- ============================================================
-- MONI CAPITAL — ROLLBACK EXACTO DE FASE 0 SECURITY HARDENING
-- Restaura el estado PRE exactamente como se capturó el 2026-09-09,
-- antes de la migración fase0_security_hardening_grants_rls.
-- ============================================================

-- 1. Restaurar los 7 privilegios completos a anon/authenticated en las
--    27 tablas (estado original real: ambos roles tenian los 7
--    privilegios -- SELECT, INSERT, UPDATE, DELETE, TRUNCATE,
--    REFERENCES, TRIGGER -- en las 27 tablas, sin excepcion).
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO anon, authenticated;

-- 2. Volver a deshabilitar RLS en las 12 tablas que originalmente no lo
--    tenian.
ALTER TABLE public.assets DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.accounts DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.smart_imports DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.derivative_positions DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.derivative_position_snapshots DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.account_snapshots DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.account_snapshot_balances DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.smart_import_images DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.fmp_benchmark_results DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.fmp_benchmark_conflicts DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.sec_financials DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.sec_financials_normalized DISABLE ROW LEVEL SECURITY;

-- 3. Quitar las 2 policies nuevas (accounts, smart_imports).
DROP POLICY IF EXISTS "Enable read access for all users" ON public.accounts;
DROP POLICY IF EXISTS "Enable read access for all users" ON public.smart_imports;

-- 4. Restaurar las 3 policies eliminadas (market_cache, ai_conversations,
--    ai_usage). pin_attempts NUNCA tuvo esta policy -- no se toca.
CREATE POLICY "Enable read access for all users" ON public.market_cache FOR SELECT TO public USING (true);
CREATE POLICY "Enable read access for all users" ON public.ai_conversations FOR SELECT TO public USING (true);
CREATE POLICY "Enable read access for all users" ON public.ai_usage FOR SELECT TO public USING (true);
