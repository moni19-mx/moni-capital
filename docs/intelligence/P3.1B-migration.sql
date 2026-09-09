-- Sprint P3.1B (Materiality Engine)
-- Migration: materiality_scores_foundation
-- Una sola tabla nueva. NO thesis_dimensions, NO conviction_history,
-- NO opportunities (siguen fuera de alcance).
--
-- Diseño: a diferencia de material_events/event_sources (que necesitan
-- un subconjunto MUTABLE de columnas -- status, primary_source_id,
-- source_role -- por eso tienen triggers de column-lock a medida),
-- materiality_scores es un caso que SI encaja tal cual con el patron
-- append-only existente (prevent_snapshot_mutation, ya usado en
-- account_snapshots): una fila de score es una conclusion de un
-- instante, punto -- NINGUNA columna deberia cambiar nunca. Un
-- re-score (nueva version del engine, nuevo ai_adjustment, lo que sea)
-- es SIEMPRE una fila nueva con material_event_id igual, nunca un
-- UPDATE.

create table public.materiality_scores (
  id bigint generated always as identity primary key,
  material_event_id bigint not null references public.material_events(id),
  scored_at timestamptz not null default now(),

  -- Capa DETERMINISTIC
  deterministic_status text not null check (deterministic_status in ('SCORED', 'DATA_UNAVAILABLE')),
  deterministic_score smallint check (deterministic_score between 0 and 100),
  deterministic_components jsonb not null default '{}'::jsonb,

  -- Capa AI ADJUSTMENT
  ai_status text not null check (ai_status in ('APPLIED', 'NEUTRAL', 'FAILED', 'NOT_ATTEMPTED')),
  ai_adjustment smallint not null default 0 check (ai_adjustment between -15 and 15),
  ai_adjustment_reason text,
  ai_interpretation text,

  -- FINAL
  final_materiality_score smallint check (final_materiality_score between 0 and 100),
  materiality_level text check (materiality_level in ('LOW', 'MEDIUM', 'HIGH')),

  -- Confidence (snapshot -- mismos 4 factores de material_events, copiados
  -- al momento del scoring para que esta fila sea autocontenida/reproducible
  -- incluso si la logica de confidence cambia en el futuro)
  source_confidence smallint,
  data_completeness smallint,
  freshness_confidence smallint,
  corroboration_confidence smallint,
  overall_confidence smallint,
  confidence_policy_version text,

  -- Portfolio awareness (seccion 12 -- dimension SEPARADA, nunca mezclada
  -- con final_materiality_score)
  portfolio_relevance_level text check (portfolio_relevance_level in ('LOW', 'MEDIUM', 'HIGH')),
  portfolio_relevance_reason text,

  -- Reproducibility
  evidence_refs jsonb not null default '[]'::jsonb,
  engine_version text not null,
  scoring_policy_version text not null,
  model_provider text,
  model_name text,

  created_at timestamptz not null default now()
);

comment on table public.materiality_scores is 'Sprint P3.1B. Una fila = una conclusion de materialidad en un instante. 100% append-only (trigger prevent_snapshot_mutation, mismo que account_snapshots) -- un re-score SIEMPRE es una fila nueva, nunca un UPDATE. material_event_id puede repetirse (multiples scores historicos del mismo evento).';
comment on column public.materiality_scores.deterministic_components is 'Breakdown completo por componente: {FINANCIAL_SCALE: {value, method, ...}, STRATEGIC_RELEVANCE: {...}, TIMELINE_URGENCY: {...}, SOURCE_STRENGTH: {...}} -- cada uno con value:number|"UNKNOWN" y method explicito. Nunca solo el numero final sin el desglose.';

create index idx_materiality_scores_event_id on public.materiality_scores (material_event_id);
create index idx_materiality_scores_scored_at on public.materiality_scores (scored_at);

create trigger trg_no_update_materiality_scores
  before update on public.materiality_scores
  for each row execute function prevent_snapshot_mutation();

create trigger trg_no_delete_materiality_scores
  before delete on public.materiality_scores
  for each row execute function prevent_snapshot_mutation();

alter table public.materiality_scores enable row level security;

-- HALLAZGO DE SEGURIDAD YA CONOCIDO (P3.1A.1): default privileges de
-- public siguen re-otorgando anon/authenticated en tablas nuevas -- se
-- repite el mismo revoke explicito, sin corregir el default global
-- (fuera de alcance de este sprint, igual que en P3.1A/P3.1A.1).
revoke all on public.materiality_scores from anon, authenticated;
