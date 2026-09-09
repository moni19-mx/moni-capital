-- Sprint P3.1A (Event Ingestion Foundation)
-- Migration: material_events_ingestion_foundation
-- Solo 2 tablas: material_events, event_sources. NO thesis_dimensions,
-- NO conviction_history, NO opportunities (esas son P3.2/P3.3, fuera de
-- alcance de este sprint).

-- ============================================================
-- 1. event_sources primero (material_events la referencia via
--    primary_source_id)
-- ============================================================

create table public.event_sources (
  id bigint generated always as identity primary key,
  cluster_id text not null,
  source_role text not null check (source_role in ('DISCOVERY_SOURCE', 'PRIMARY_EVIDENCE_SOURCE', 'CORROBORATING_SOURCE')),
  source_tier smallint not null check (source_tier between 1 and 4),
  provider text not null,
  source_url text,
  raw_headline text,
  raw_snippet text,
  attributed_wire text,
  source_published_at timestamptz,
  ingested_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

comment on table public.event_sources is 'Sprint P3.1A. Una fila por evidencia individual (un articulo, un filing) que respalda un cluster de material_events. Nunca se borra ni se reescribe salvo source_role (promocion/democion) -- ver trigger trg_protect_event_source_facts.';
comment on column public.event_sources.attributed_wire is 'Origen de wire syndication cuando es detectable (ej. "reuters-wire-123") -- evita contar N republicaciones del mismo wire como N fuentes independientes en CORROBORATION_CONFIDENCE.';

create index idx_event_sources_cluster_id on public.event_sources (cluster_id);

-- ============================================================
-- 2. material_events
-- ============================================================

create table public.material_events (
  id bigint generated always as identity primary key,
  cluster_id text not null,
  supersedes_event_id bigint references public.material_events(id),
  is_current boolean not null default true,

  asset_id bigint not null references public.assets(asset_id),
  ticker text not null,
  event_type text not null check (event_type in (
    'EARNINGS', 'GUIDANCE', 'MAJOR_CONTRACT', 'CUSTOMER_LOSS', 'PRODUCT_LAUNCH', 'M_AND_A',
    'REGULATORY_LEGAL', 'CAPITAL_ALLOCATION', 'INSIDER_MANAGEMENT', 'SUPPLY_CHAIN', 'MACRO', 'ANALYST', 'OTHER'
  )),
  headline text not null,

  -- Contrato temporal (Final Architecture Review, seccion 5)
  occurred_at timestamptz,
  published_at timestamptz,
  discovered_at timestamptz not null,
  processed_at timestamptz,
  decision_available_at timestamptz,

  -- Capa FACT -- nunca escrita por AI, inmutable una vez seteada (ver trigger)
  facts jsonb not null default '{}'::jsonb,
  classification_method text not null check (classification_method in ('structured_field', 'rule_based_keyword', 'unclassified')),
  known_fact_count smallint not null default 0,
  expected_fact_keys jsonb not null default '[]'::jsonb,

  -- Provenance (primary_source_id es MUTABLE -- promocion)
  primary_source_id bigint references public.event_sources(id),

  -- Confidence breakdown (Final Architecture Review, seccion 3) -- inmutable una vez seteado
  source_confidence smallint,
  data_completeness smallint,
  freshness_confidence smallint,
  corroboration_confidence smallint,
  overall_confidence smallint,
  confidence_policy_version text,

  -- Versioning (Final Architecture Review, seccion 6) -- inmutable
  engine_version text not null,
  normalization_policy_version text not null,

  -- Lifecycle -- MUTABLE
  requires_review boolean not null default false,
  status text not null default 'NEW' check (status in ('NEW', 'REVIEWED', 'DISMISSED', 'ACTIONED')),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.material_events is 'Sprint P3.1A. Un evento de mercado normalizado. facts/deterministic scoring/timestamps/version fields son inmutables una vez escritos (trigger trg_protect_material_event_facts) -- un re-proceso crea una fila nueva con supersedes_event_id apuntando a la version anterior, nunca sobreescribe. primary_source_id/status/requires_review/is_current SI son mutables (promocion de fuente, revision del usuario).';
comment on column public.material_events.decision_available_at is 'Momento en que el sistema pudo haber actuado sobre este evento -- P3.1A lo resuelve como processed_at (ver lib/materialEventTemporal.js::resolveDecisionAvailableAt). CUALQUIER analisis retrospectivo futuro (backtesting, decision review) debe filtrar por esta columna, NUNCA por occurred_at -- evita look-ahead bias.';
comment on column public.material_events.cluster_id is 'Comparte valor con event_sources.cluster_id. Tambien comparte valor entre material_events cuando un evento se re-procesa (supersedes_event_id) -- el cluster_id identifica "el mismo evento real del mundo", no una fila especifica.';

create index idx_material_events_cluster_id on public.material_events (cluster_id);
create index idx_material_events_asset_id on public.material_events (asset_id, is_current);
create index idx_material_events_discovered_at on public.material_events (discovered_at);

-- ============================================================
-- 3. Append-only / column-lock triggers
-- ============================================================
-- Reusa prevent_snapshot_mutation() (ya existente, Fase 0) SOLO para
-- bloquear DELETE -- esa funcion no distingue columnas, asi que blindar
-- UPDATE con ella tambien bloquearia cambios legitimos de status/
-- primary_source_id/is_current. Por eso UPDATE necesita una funcion
-- nueva, consciente de columnas, para cada tabla -- no encaja reusar el
-- patron tal cual, como se anticipo en el pedido de este sprint.

create trigger trg_no_delete_material_events
  before delete on public.material_events
  for each row execute function prevent_snapshot_mutation();

create trigger trg_no_delete_event_sources
  before delete on public.event_sources
  for each row execute function prevent_snapshot_mutation();

create or replace function public.protect_material_event_facts()
returns trigger
language plpgsql
as $$
begin
  if OLD.facts is distinct from NEW.facts then
    raise exception 'material_events.facts es inmutable una vez escrito -- id=%. Use una fila nueva (supersedes_event_id) para reprocesar.', OLD.id;
  end if;
  if OLD.classification_method is distinct from NEW.classification_method
     or OLD.known_fact_count is distinct from NEW.known_fact_count
     or OLD.expected_fact_keys is distinct from NEW.expected_fact_keys then
    raise exception 'material_events: campos de clasificacion/facts son inmutables -- id=%', OLD.id;
  end if;
  if OLD.occurred_at is distinct from NEW.occurred_at
     or OLD.published_at is distinct from NEW.published_at
     or OLD.discovered_at is distinct from NEW.discovered_at
     or OLD.processed_at is distinct from NEW.processed_at
     or OLD.decision_available_at is distinct from NEW.decision_available_at then
    raise exception 'material_events: campos temporales son inmutables una vez escritos -- id=%', OLD.id;
  end if;
  if OLD.engine_version is distinct from NEW.engine_version
     or OLD.normalization_policy_version is distinct from NEW.normalization_policy_version
     or OLD.confidence_policy_version is distinct from NEW.confidence_policy_version then
    raise exception 'material_events: version fields son inmutables -- id=%', OLD.id;
  end if;
  if OLD.source_confidence is distinct from NEW.source_confidence
     or OLD.data_completeness is distinct from NEW.data_completeness
     or OLD.freshness_confidence is distinct from NEW.freshness_confidence
     or OLD.corroboration_confidence is distinct from NEW.corroboration_confidence
     or OLD.overall_confidence is distinct from NEW.overall_confidence then
    raise exception 'material_events: confidence breakdown es inmutable -- id=%', OLD.id;
  end if;
  if OLD.cluster_id is distinct from NEW.cluster_id
     or OLD.supersedes_event_id is distinct from NEW.supersedes_event_id
     or OLD.asset_id is distinct from NEW.asset_id
     or OLD.ticker is distinct from NEW.ticker
     or OLD.event_type is distinct from NEW.event_type
     or OLD.headline is distinct from NEW.headline then
    raise exception 'material_events: identidad del evento es inmutable -- id=%', OLD.id;
  end if;
  NEW.updated_at = now();
  return NEW;
end;
$$;

create trigger trg_protect_material_event_facts
  before update on public.material_events
  for each row execute function protect_material_event_facts();

create or replace function public.protect_event_source_facts()
returns trigger
language plpgsql
as $$
begin
  if OLD.cluster_id is distinct from NEW.cluster_id
     or OLD.source_tier is distinct from NEW.source_tier
     or OLD.provider is distinct from NEW.provider
     or OLD.source_url is distinct from NEW.source_url
     or OLD.raw_headline is distinct from NEW.raw_headline
     or OLD.raw_snippet is distinct from NEW.raw_snippet
     or OLD.attributed_wire is distinct from NEW.attributed_wire
     or OLD.source_published_at is distinct from NEW.source_published_at
     or OLD.ingested_at is distinct from NEW.ingested_at then
    raise exception 'event_sources: solo source_role puede cambiar (promocion/democion) -- id=%', OLD.id;
  end if;
  return NEW;
end;
$$;

create trigger trg_protect_event_source_facts
  before update on public.event_sources
  for each row execute function protect_event_source_facts();

-- ============================================================
-- 4. RLS + grants (Fase 0 Grupo C: server-only, sin anon read/write)
-- ============================================================
-- HALLAZGO DE SEGURIDAD (fuera del alcance original de este sprint,
-- documentado en el reporte): los "default privileges" del schema
-- public TODAVIA otorgan a anon/authenticated los 7 privilegios
-- completos (incluido TRUNCATE) sobre CUALQUIER tabla nueva creada por
-- el rol postgres -- confirmado via pg_default_acl. Fase 0 arreglo los
-- grants de las 27 tablas que existian en ese momento, pero NUNCA
-- corrigio el default para tablas futuras. Por eso estas 2 tablas
-- nuevas requieren un REVOKE explicito aqui -- sin este paso,
-- heredarian silenciosamente la misma vulnerabilidad que Fase 0 cerro.

alter table public.material_events enable row level security;
alter table public.event_sources enable row level security;

revoke all on public.material_events from anon, authenticated;
revoke all on public.event_sources from anon, authenticated;

-- Sin policy para anon/authenticated (deny-all real, no solo grants) --
-- mismo patron que account_snapshots/derivative_positions (Fase 0 Grupo C).
