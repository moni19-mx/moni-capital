-- Sprint P3.2 (Thesis / Conviction Engine 2.0)
-- 3 tablas nuevas: thesis_dimensions, thesis_dimension_effects,
-- conviction_history. Mismo patron de mutabilidad que P3.1A/P3.1B:
-- append-only por default (prevent_snapshot_mutation, ya existente),
-- con triggers de column-lock a medida donde un subconjunto de columnas
-- SI necesita poder cambiar (revision de usuario, promocion de status).
--
-- Deliberadamente NO se migra thesis.conviction (smallint, 1-5 entero)
-- a un tipo decimal en esta migracion -- ver Sprint P3.2 PRE-audit
-- (seccion 3 del reporte): el campo se usa hoy en multiples lugares de
-- UI/scoring (ConvictionStars, scoreBreakdown en Opportunity Score,
-- journal_entries.conviction_at_time) que asumen un entero 1-5; migrar
-- el tipo de columna sin antes corregir esos consumidores produciria
-- un bug real y silencioso (String.prototype.repeat trunca decimales,
-- ConvictionStars mostraria un numero de estrellas incorrecto para
-- valores como 4.5). thesis.conviction permanece intacto; la escala
-- decimal 1.0-5.0 nueva vive exclusivamente en conviction_history
-- (propuestas del engine), nunca escrita automaticamente de vuelta a
-- thesis.conviction en este sprint.

-- ============================================================
-- 1. thesis_dimensions
-- ============================================================
create table public.thesis_dimensions (
  id bigint generated always as identity primary key,
  asset_id bigint not null references public.assets(asset_id),
  ticker text not null,
  dimension_type text not null check (dimension_type in ('WHY_OWN', 'EDGE', 'CATALYST', 'RISK', 'SELL_TRIGGER')),
  label text not null,
  detail text not null,
  status text not null default 'ACTIVE' check (status in ('ACTIVE', 'CONFIRMED', 'WEAKENED', 'INVALIDATED', 'RETIRED')),
  source text not null check (source in ('MIGRATED_FROM_THESIS_TEXT', 'MANUAL', 'REVIEW_REQUIRED')),
  source_confidence text not null check (source_confidence in ('CLEAR', 'AMBIGUOUS', 'UNKNOWN')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.thesis_dimensions is 'Sprint P3.2. Descompone thesis.why_bought/what_special/sell_trigger/risks (texto libre) en dimensiones explicitas. Migracion conservadora: 1 fila por (ticker, dimension_type) cuando el campo origen existe, texto ORIGINAL preservado verbatim en detail -- nunca reescrito por AI. CATALYST no se migra (no existe campo origen en thesis) -- se agrega manualmente o via un motor de catalizadores futuro. Solo status/updated_at son mutables (trigger trg_protect_thesis_dimension_facts) -- todo lo demas es inmutable una vez escrito.';

create index idx_thesis_dimensions_asset_id on public.thesis_dimensions (asset_id);

create trigger trg_no_delete_thesis_dimensions
  before delete on public.thesis_dimensions
  for each row execute function prevent_snapshot_mutation();

create or replace function public.protect_thesis_dimension_facts()
returns trigger
language plpgsql
as $$
begin
  if OLD.asset_id is distinct from NEW.asset_id
     or OLD.ticker is distinct from NEW.ticker
     or OLD.dimension_type is distinct from NEW.dimension_type
     or OLD.label is distinct from NEW.label
     or OLD.detail is distinct from NEW.detail
     or OLD.source is distinct from NEW.source
     or OLD.source_confidence is distinct from NEW.source_confidence
     or OLD.created_at is distinct from NEW.created_at then
    raise exception 'thesis_dimensions: solo status/updated_at pueden cambiar -- id=%', OLD.id;
  end if;
  return NEW;
end;
$$;

create trigger trg_protect_thesis_dimension_facts
  before update on public.thesis_dimensions
  for each row execute function protect_thesis_dimension_facts();

-- ============================================================
-- 2. thesis_dimension_effects (event -> dimension, 100% append-only)
-- ============================================================
create table public.thesis_dimension_effects (
  id bigint generated always as identity primary key,
  material_event_id bigint not null references public.material_events(id),
  dimension_id bigint not null references public.thesis_dimensions(id),
  asset_id bigint not null references public.assets(asset_id),
  effect text not null check (effect in ('CONFIRMS', 'WEAKENS', 'INVALIDATES', 'NEUTRAL')),
  confidence smallint check (confidence between 0 and 100),
  evidence_refs jsonb not null default '[]'::jsonb,
  explanation text,
  requires_review boolean not null default false,
  engine_version text not null,
  created_at timestamptz not null default now()
);

comment on table public.thesis_dimension_effects is 'Sprint P3.2. Un material_event puede afectar 0, 1 o varias thesis_dimensions -- una fila por (evento, dimension) afectada, nunca un evento reescribiendo toda la tesis de una vez. INTERPRETATION, no FACT -- nunca modifica material_events.facts. 100% append-only (prevent_snapshot_mutation) -- una reevaluacion es una fila nueva.';

create index idx_thesis_dimension_effects_event_id on public.thesis_dimension_effects (material_event_id);
create index idx_thesis_dimension_effects_dimension_id on public.thesis_dimension_effects (dimension_id);

create trigger trg_no_mutate_thesis_dimension_effects_delete
  before delete on public.thesis_dimension_effects
  for each row execute function prevent_snapshot_mutation();

create trigger trg_no_mutate_thesis_dimension_effects_update
  before update on public.thesis_dimension_effects
  for each row execute function prevent_snapshot_mutation();

-- ============================================================
-- 3. conviction_history (append-only con revision de usuario)
-- ============================================================
create table public.conviction_history (
  id bigint generated always as identity primary key,
  asset_id bigint not null references public.assets(asset_id),
  ticker text not null,

  previous_conviction numeric(2,1),
  proposed_conviction numeric(2,1) check (proposed_conviction is null or proposed_conviction between 1.0 and 5.0),
  accepted_conviction numeric(2,1) check (accepted_conviction is null or accepted_conviction between 1.0 and 5.0),

  deterministic_status text not null check (deterministic_status in ('SCORED', 'DATA_UNAVAILABLE')),
  component_scores jsonb not null default '{}'::jsonb,
  component_confidences jsonb not null default '{}'::jsonb,
  known_score numeric(3,2),
  coverage numeric(4,3),

  overall_confidence smallint check (overall_confidence between 0 and 100),
  confidence_breakdown jsonb not null default '{}'::jsonb,

  reason text,
  evidence_refs jsonb not null default '[]'::jsonb,
  triggered_by_event_id bigint references public.material_events(id),

  requires_user_review boolean not null default true,
  review_reasons jsonb not null default '[]'::jsonb,
  decision_id bigint references public.decisions(id),

  source text not null check (source in ('ENGINE_PROPOSAL', 'MANUAL_OVERRIDE', 'PERIODIC_REVIEW')),
  engine_version text not null,
  scoring_policy_version text not null,
  confidence_policy_version text not null,
  model_provider text,
  model_name text,

  status text not null default 'PENDING' check (status in ('PENDING', 'ACCEPTED', 'REJECTED', 'AUTO_ACCEPTED')),
  reviewed_at timestamptz,
  reviewed_by text,

  created_at timestamptz not null default now()
);

comment on table public.conviction_history is 'Sprint P3.2. Una fila = una propuesta (o cambio manual) de conviction en un instante. Append-only -- reevaluar SIEMPRE crea una fila nueva, nunca UPDATE de component_scores/proposed_conviction/etc. Solo status/reviewed_at/reviewed_by/accepted_conviction son mutables (trigger trg_protect_conviction_history_facts), para poder resolver una fila PENDING sin reescribir la propuesta original -- mismo patron que decisions.status/resolved_at.';

create index idx_conviction_history_asset_id on public.conviction_history (asset_id, created_at desc);
create index idx_conviction_history_status on public.conviction_history (status) where status = 'PENDING';

create trigger trg_no_delete_conviction_history
  before delete on public.conviction_history
  for each row execute function prevent_snapshot_mutation();

create or replace function public.protect_conviction_history_facts()
returns trigger
language plpgsql
as $$
begin
  if OLD.asset_id is distinct from NEW.asset_id
     or OLD.ticker is distinct from NEW.ticker
     or OLD.previous_conviction is distinct from NEW.previous_conviction
     or OLD.proposed_conviction is distinct from NEW.proposed_conviction
     or OLD.deterministic_status is distinct from NEW.deterministic_status
     or OLD.component_scores is distinct from NEW.component_scores
     or OLD.component_confidences is distinct from NEW.component_confidences
     or OLD.known_score is distinct from NEW.known_score
     or OLD.coverage is distinct from NEW.coverage
     or OLD.overall_confidence is distinct from NEW.overall_confidence
     or OLD.confidence_breakdown is distinct from NEW.confidence_breakdown
     or OLD.reason is distinct from NEW.reason
     or OLD.evidence_refs is distinct from NEW.evidence_refs
     or OLD.triggered_by_event_id is distinct from NEW.triggered_by_event_id
     or OLD.requires_user_review is distinct from NEW.requires_user_review
     or OLD.review_reasons is distinct from NEW.review_reasons
     or OLD.decision_id is distinct from NEW.decision_id
     or OLD.source is distinct from NEW.source
     or OLD.engine_version is distinct from NEW.engine_version
     or OLD.scoring_policy_version is distinct from NEW.scoring_policy_version
     or OLD.confidence_policy_version is distinct from NEW.confidence_policy_version
     or OLD.model_provider is distinct from NEW.model_provider
     or OLD.model_name is distinct from NEW.model_name
     or OLD.created_at is distinct from NEW.created_at then
    raise exception 'conviction_history: solo status/reviewed_at/reviewed_by/accepted_conviction pueden cambiar -- id=%', OLD.id;
  end if;
  return NEW;
end;
$$;

create trigger trg_protect_conviction_history_facts
  before update on public.conviction_history
  for each row execute function protect_conviction_history_facts();

-- ============================================================
-- 4. RLS + grants (mismo patron server-only que P3.1A/P3.1B)
-- ============================================================
alter table public.thesis_dimensions enable row level security;
alter table public.thesis_dimension_effects enable row level security;
alter table public.conviction_history enable row level security;

revoke all on public.thesis_dimensions from anon, authenticated;
revoke all on public.thesis_dimension_effects from anon, authenticated;
revoke all on public.conviction_history from anon, authenticated;

-- Sin policy para anon/authenticated (deny-all real, no solo grants).
