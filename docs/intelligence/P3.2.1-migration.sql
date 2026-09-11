-- Micro-sprint P3.2.1 (Fundamental Conviction Coverage)
-- Agrega recommendation_status a conviction_history (LOW COVERAGE GUARD,
-- item 14/21): permite distinguir "el engine propuso un cambio real"
-- de "coverage/confidence insuficientes para siquiera proponerlo" sin
-- tocar ninguna columna existente. Nullable -- filas previas (P3.2)
-- quedan NULL honestamente (no se re-evaluaron bajo esta regla, nunca
-- se backfillea un valor inventado).

alter table conviction_history
  add column if not exists recommendation_status text;

alter table conviction_history
  add constraint conviction_history_recommendation_status_check
  check (recommendation_status is null or recommendation_status = any (array[
    'PROPOSED_CHANGE', 'INSUFFICIENT_EVIDENCE_FOR_CHANGE', 'NO_CHANGE', 'DATA_UNAVAILABLE'
  ]));

comment on column conviction_history.recommendation_status is
  'P3.2.1 LOW COVERAGE GUARD: PROPOSED_CHANGE (coverage/componentes suficientes y hay delta real), INSUFFICIENT_EVIDENCE_FOR_CHANGE (hay delta nominal pero coverage/componentes no alcanzan el minimo -- nunca se crea decision), NO_CHANGE (sin delta), DATA_UNAVAILABLE (deterministic_status=DATA_UNAVAILABLE). NULL = fila anterior a P3.2.1, nunca evaluada bajo esta regla.';

-- Extiende el trigger de columna-lock existente para proteger tambien
-- recommendation_status (mismo patron: solo status/reviewed_at/
-- reviewed_by/accepted_conviction pueden cambiar despues del insert).
create or replace function protect_conviction_history_facts()
returns trigger
language plpgsql
set search_path = public
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
     or OLD.recommendation_status is distinct from NEW.recommendation_status
     or OLD.created_at is distinct from NEW.created_at then
    raise exception 'conviction_history: solo status/reviewed_at/reviewed_by/accepted_conviction pueden cambiar -- id=%', OLD.id;
  end if;
  return NEW;
end;
$$;
