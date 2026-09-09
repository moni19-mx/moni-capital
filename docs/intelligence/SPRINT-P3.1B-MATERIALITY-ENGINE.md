# Sprint P3.1B — Materiality Engine

> Primer motor real de Moni Intelligence: responde "¿este evento
> realmente importa?" — nunca "¿debo comprar/vender?" ni cambia
> conviction. NO MAGIC SCORES: todo `final_materiality_score` se abre
> en deterministic score + componentes + AI adjustment + confidence +
> evidence, o no se muestra.

## 1. PRE audit

1. **Schema real de `material_events`/`event_sources`** (P3.1A): confirmado
   sin cambios desde el último sprint — `facts`/timestamps/confidence/
   versioning inmutables, `status`/`primary_source_id`/`source_role`/
   `is_current` mutables.
2. **Los 3 eventos reales de P3.1A.2** (`material_events.id` 4, 5, 6):
   todos QCOM, `event_type=OTHER`, `classification_method=unclassified`,
   `facts={headline_raw, source_url, publisher, finnhub_id}` — **sin
   ningún campo financiero** (deal_value, counterparty, revenue, etc.).
3. **Source roles actuales**: cada evento con su propia
   `PRIMARY_EVIDENCE_SOURCE` (Tier 3, Finnhub) — confirmado, sin
   promoción pendiente.
4. **Temporal fields**: `occurred_at=null`, `published_at` real (hoy),
   `discovered_at`/`processed_at` reales, `decision_available_at`
   resuelto = `processed_at` (P3.1A).
5. **Confidence fields**: los 3 con `source_confidence=50,
   data_completeness=0, freshness_confidence=100,
   corroboration_confidence=40, overall_confidence=43` — idéntico en
   los 3 (mismo patrón de headline, mismo tier, mismo día).
6. **Versioning fields**: `engine_version=material-events-ingestion-v1.0.0`,
   `normalization_policy_version=normalization-v1.0.0` en los 3.
7. **Append-only**: confirmado activo, sin cambios.
8. **Info financiera/fundamental real disponible**: ninguna de FMP para
   QCOM (P3.1A.1, bloqueado); ninguna en los `facts` de estos 3 eventos.
   Confirma que `FINANCIAL_SCALE` será `UNKNOWN` para los 3, honesto,
   no un fallo del engine.
9. **Datos de portfolio usables sin tocar cálculos financieros**: `positions`
   (QCOM: `asset_id=29`, `shares=1.267009`, `cost_basis=314.17`, `tema="Semiconductores IA"`,
   `sector="Semiconductores"`) y `thesis` (`conviction=4`,
   `why_bought` menciona "IA en el edge") — **solo lectura**, cero
   escritura a estas tablas en todo el sprint.
10. **Baseline tests/build**: 268/268 (225 previos + 43 nuevos de este
    sprint hasta este punto) antes de continuar con L/M/R.
11. **PRE financiero**: idéntico al de P3.1A.2 (positions=39,
    transactions=85, cash_movements=5, account_snapshots=4,
    account_snapshot_balances=4, derivative_positions=2,
    derivative_position_snapshots=3, smart_imports=30).

## 2. Schema delta

Una sola tabla nueva: `materiality_scores` (migración
`materiality_scores_foundation`, ver
`docs/intelligence/P3.1B-migration.sql`). **A diferencia de
`material_events`/`event_sources`** (que necesitaron triggers de
column-lock a medida porque tienen un subconjunto mutable real), esta
tabla **sí encaja tal cual** con el patrón `prevent_snapshot_mutation`
existente (mismo usado en `account_snapshots`) — ninguna columna debe
cambiar nunca, un re-score es siempre una fila nueva. RLS enabled, sin
policy, `revoke all` explícito de `anon`/`authenticated` (mismo
hallazgo de default privileges de P3.1A.1, mitigado igual, no corregido
a nivel de schema — fuera de alcance).

## 3. Deterministic engine

`lib/materialityEngine.js` — 4 componentes puros, cero red, cero
Supabase:

- `computeFinancialScale(eventType, facts, context)` — **event-type-aware**,
  con fórmula real distinta por tipo (MAJOR_CONTRACT/CUSTOMER_LOSS:
  `deal_value/trailing_annual_revenue`; CAPITAL_ALLOCATION: `dilution_pct`
  o `capex/market_cap`; EARNINGS: `|eps_actual-eps_estimated|/|eps_estimated|`;
  GUIDANCE: delta de guidance; M&A: `deal_value/market_cap`). Tipos sin
  fórmula definida (incluido `OTHER`) → `UNKNOWN` honesto. Nunca infiere
  de lenguaje ("major"/"huge").
- `computeStrategicRelevance(facts, positionContext)` — determinístico:
  posición activa real (+20) + clasificación temática real no-nula
  (+20) + overlap de keyword verificable entre tema/sector y el
  headline (+20). Nunca decide "este evento es relevante" por juicio —
  solo verifica hechos estructurados.
- `computeTimelineUrgency(facts, now)` — busca una fecha futura real
  (`effective_date`/`contract_start`/`earnings_date`/`regulatory_deadline`)
  en `facts`. Sin fecha → `UNKNOWN`. **Nunca** "publicado hoy = urgencia
  100" (eso es freshness, un concepto distinto).
- `computeSourceStrength(primaryEvidenceTier)` — reusa `tierScore()` de
  `lib/materialEventSources.js`, la misma tabla 1→100/2→70/3→50/4→25 ya
  usada en P3.1A. Sin duplicar la tabla.

`computeDeterministicScore(components)` pondera con
`DETERMINISTIC_WEIGHTS` (35/25/15/25), **renormalizando entre
componentes conocidos** cuando hay `UNKNOWN` — nunca convierte `UNKNOWN`
en 0. Si los 4 son `UNKNOWN` → `status: "DATA_UNAVAILABLE"`, `score:
null` — nunca `0` (0 significa "definitivamente no material", una
afirmación distinta de "no hay suficiente información").

`classifyPortfolioRelevance({isActivePosition, conviction})` — dimensión
**separada** (sección 12), nunca mezclada con el score de materialidad.

## 4. Fórmulas exactas

```
FINAL_MATERIALITY = clamp(deterministic_score + ai_adjustment, 0, 100)
ai_adjustment ∈ [-15, +15]
```

Verificado con los ejemplos exactos pedidos:
`20+0=20`, `20+15=35`, `50-15=35`, `80+15=95`, `95+15=100` (clamp),
`95+0=95` (nunca 66.5, el bug del blend anterior).

`materiality_level`: `HIGH >= 70`, `40 <= MEDIUM < 70`, `LOW < 40` —
siempre derivado del score al momento de persistir, nunca una columna
editable independiente.

## 5. UNKNOWN handling

Ver sección 3 — cada componente declara `inputs_missing` explícito
cuando es `UNKNOWN`. `computeDeterministicScore` renormaliza pesos
entre conocidos (`weights_used` documenta los pesos reales aplicados,
no los nominales). Verificado real contra los 3 eventos: `FINANCIAL_SCALE`
y `TIMELINE_URGENCY` ambos `UNKNOWN` → pesos renormalizados a
`STRATEGIC_RELEVANCE=0.5, SOURCE_STRENGTH=0.5` (de 0.25/0.25 nominal).

## 6. Company vs portfolio relevance

**Dos dimensiones separadas, nunca mezcladas en un solo número**
(sección 12 del sprint):

- `final_materiality_score`/`materiality_level` → describe el
  EVENTO/EMPRESA (¿qué tan importante es esto para QCOM?).
- `portfolio_relevance_level`/`portfolio_relevance_reason` → describe
  la relevancia para Moni Capital específicamente (¿es esto una
  posición activa, con qué conviction?).

Real, verificado: los 3 eventos → `materiality: 45 MEDIUM`,
`portfolio_relevance: HIGH (active_position_high_conviction(4))` —
exactamente el ejemplo conceptual del sprint ("Materiality 88 HIGH,
Portfolio relevance HIGH"), con el matiz honesto de que aquí la
materialidad quedó en MEDIUM, no HIGH, porque los hechos disponibles
son escasos.

## 7. Confidence model

Reusa **exactamente** los 4 factores ya construidos en P3.1A
(`lib/materialEventConfidence.js`) — no se recalculan, se **snapshotean**
al momento del scoring (los facts/evidence de `material_events` son
inmutables, así que el confidence ya calculado en P3.1A sigue siendo
válido; copiarlo hace que `materiality_scores` sea autocontenida y
reproducible aunque la lógica de confidence cambie en el futuro).
`overall_confidence = source×0.30 + completeness×0.30 + freshness×0.20 + corroboration×0.20` —
sin cambios a esos pesos.

Real: los 3 eventos → `overall_confidence=43` — **materiality MEDIUM (45)
con confidence baja (43)**, exactamente la combinación que el sprint
pidió poder representar: "parece moderadamente importante (es tu
posición, conviction 4), pero la evidencia todavía es floja (headline
genérico, sin hechos específicos verificables)".

## 8. AI adjustment contract

`lib/materialityAiAdjustment.js` — `parseAiAdjustmentResponse()` (pura)
+ `requestAiAdjustment(callModelFn, context)` (orquesta con la función
de llamada inyectada, mismo patrón que `executorFn` en
`api/ai.js::runQuestion`). 4 estados: `APPLIED`/`NEUTRAL`/`FAILED`/
`NOT_ATTEMPTED`. Cualquier fallo (red, JSON inválido, rango inválido,
reason faltante) → `FAILED`, `adjustment: 0`, **nunca propaga la
excepción, nunca deja el score determinístico sin resultado**.

**No se llamó al AI Gateway real en este sprint** — mismo motivo que
bloqueó el fact-check de providers en P3.1A.1: `api.anthropic.com` sí
está permitido por el proxy de este sandbox, pero la
`ANTHROPIC_API_KEY`/`OPENAI_API_KEY` reales viven solo en Vercel, no en
este entorno. Los 3 scores reales quedaron con `ai_status: "NOT_ATTEMPTED"`,
`ai_adjustment: 0` — el score final es puramente determinístico, válido
por diseño (`ai_adjustment=0` es un no-op exacto por la fórmula de la
sección 4). Contrato completo probado con respuestas simuladas
inyectadas (tests E-K, V) — nunca contra el proveedor real.

## 9. Real event results

| event_id | headline (resumen) | FINANCIAL_SCALE | STRATEGIC_RELEVANCE | TIMELINE_URGENCY | SOURCE_STRENGTH | deterministic | ai_adjustment | **final** | **level** | confidence |
|---|---|---|---|---|---|---|---|---|---|---|
| 4 | "Intel, Amkor, Nova, Qualcomm... Trade Up" | UNKNOWN | 40 | UNKNOWN | 50 | 45 | 0 (NOT_ATTEMPTED) | **45** | **MEDIUM** | 43 |
| 5 | "Applied Materials, AMD, Broadcom... Skyrocket" | UNKNOWN | 40 | UNKNOWN | 50 | 45 | 0 (NOT_ATTEMPTED) | **45** | **MEDIUM** | 43 |
| 6 | "S&P 500, Dow End Lower... QCOM... In Focus" | UNKNOWN | 40 | UNKNOWN | 50 | 45 | 0 (NOT_ATTEMPTED) | **45** | **MEDIUM** | 43 |

**Los 3 terminaron en el mismo score** — no por casualidad ni por
forzar variedad: los 3 comparten exactamente el mismo perfil de
evidencia (mismo tier de fuente, mismo tipo de headline genérico de
mercado, mismo día, misma posición). Es un resultado honesto, no
diseñado — el sprint pedía explícitamente no forzar variedad
("Si los 3 terminan LOW... ESO ES UN BUEN RESULTADO"); aquí terminaron
MEDIUM porque `STRATEGIC_RELEVANCE`+`SOURCE_STRENGTH` (lo único
calculable) reflejan realmente "es tu posición, con una fuente
razonable" — ni ruido puro, ni evento confirmado importante.

**Limitación real encontrada durante este cómputo**: el overlap de
keyword de `STRATEGIC_RELEVANCE` compara `tema`/`sector` (en español:
"Semiconductores IA") contra el headline (en inglés) — **nunca hizo
match** en los 3 casos reales (mismatch de idioma). El componente igual
sumó 40/100 por los otros 2 hechos verificables (posición activa +
clasificación), pero el overlap de keyword como señal adicional quedó
sin ejercitarse con datos reales. Documentado como limitación honesta,
no oculto.

## 10. QCOM real result

Los 3 eventos usados son reales de QCOM (`asset_id=29`), encontrados
por Finnhub en P3.1A.2 — **no se usó el ejemplo hipotético QCOM/Amazon**
(nunca apareció en los datos reales, confirmado en P3.1A.2). El motor
correctamente distingue: *"esto es noticia real de QCOM, pero no
necesariamente material"* — score MEDIUM (45), no HIGH, precisamente
porque son titulares de resumen de mercado (`event_type=OTHER`), no un
hecho corporativo específico. Exactamente el filtro de ruido que el
sprint pedía demostrar.

## 11. Append-only/versioning

Verificado real contra Postgres (transacción nunca comprometida):
`UPDATE`/`DELETE` sobre una fila real de `materiality_scores` →
bloqueados (`"Tabla append-only (materiality_scores): UPDATE/DELETE no
permitido"`). Re-score legítimo (nueva fila, mismo `material_event_id`)
→ permitido, verificado. `engine_version`, `scoring_policy_version`,
`evidence_refs` persistidos en las 3 filas reales
(`materiality-engine-v1.0.0`, `scoring-v1.0.0`,
`{material_event_id, primary_source_id, asset_id, ticker}`).
`model_provider`/`model_name` = `null` (honesto, AI no se intentó).

## 12. Temporal safety

`scored_at` (momento del scoring) verificado **real** `>=`
`processed_at` del evento subyacente en las 3 filas — consultado
directo en Postgres, no solo en un test unitario. Nueva función pura
`validateScoreOrdering()` (`lib/materialityFormula.js`) operacionaliza
la regla "nunca backfill retrospectivo" en código, no solo como
comentario.

## 13. Rate-limit behavior

Este sprint no hizo ningún llamado nuevo a Finnhub/FMP — el scoring
corrió sobre `facts` ya persistidos en P3.1A.2. Sin loops nuevos que
gasten cuota.

## 14. Tests A-V

| Test | Resultado |
|---|---|
| A - 4 componentes conocidos | PASS |
| B - 1 UNKNOWN renormaliza | PASS |
| C - varios UNKNOWN renormalizan | PASS |
| D - todos UNKNOWN → DATA_UNAVAILABLE, no 0 | PASS |
| E - AI neutral → deterministic intacto | PASS |
| F - AI +15 | PASS |
| G - AI -15 | PASS |
| H - clamp 100 | PASS |
| I - clamp 0 | PASS |
| J - adjustment fuera de rango → reject | PASS |
| K - adjustment sin reason → reject | PASS |
| L - HIGH materiality + LOW confidence válido | PASS |
| M - LOW materiality + HIGH confidence válido | PASS |
| N - freshness != urgency | PASS |
| O - Tier 1 mejora source strength | PASS |
| P - wire duplicado no infla corroboration | PASS (reusa test de P3.1A, misma función) |
| Q - provider failure ≠ no-event | PASS (nivel provider: P3.1A.2; nivel materiality: DATA_UNAVAILABLE ≠ LOW, este sprint) |
| R - historical ordering usa processed_at | PASS (unit + verificado real contra Postgres) |
| S - rescore append-only | PASS (verificado real contra Postgres) |
| T - 3 eventos reales sin inventar facts | PASS (verificado real, persistido) |
| U - QCOM real procesado | PASS (los 3 son QCOM real) |
| V - fallo AI conserva deterministic score | PASS |

## 15. Full regression

**273/273** (`node --test tests/*.test.js`) — 268 previos a este punto
+ 5 nuevos (L, M, R×3). Breakdown del sprint: 43 tests nuevos totales
(`materialityFormula.test.js`, `materialityEngine.test.js`,
`materialityAiAdjustment.test.js`).

## 16. Build

Limpio. Bundle de navegador sin cambio de tamaño — todo el motor de
materialidad es server-side/lib puro, nunca importado por `src/`.

## 17. PRE/POST financiero

| Tabla | Antes | Después |
|---|---|---|
| `positions` | 39 | 39 |
| `transactions` | 85 | 85 |
| `cash_movements` | 5 | 5 |
| `account_snapshots` | 4 | 4 |
| `account_snapshot_balances` | 4 | 4 |
| `derivative_positions` | 2 | 2 |
| `derivative_position_snapshots` | 3 | 3 |
| `smart_imports` | 30 | 30 |
| `materiality_scores` | 0 | 3 (reales) |

Cero cambio financiero.

## 18. Bugs encontrados

Ninguno de lógica nueva. **Nota, no bug**: `event_sources` creció de 4
a 7 durante este sprint sin acción mía — investigado y confirmado como
una re-corrida real del benchmark de Finnhub (P3.1A.2) por el usuario,
correctamente deduplicada por el pipeline (las 3 filas nuevas quedaron
como `CORROBORATING_SOURCE` de los mismos 3 clusters, cero
`material_events` nuevo) — evidencia adicional, no planeada, de que el
dedupe/idempotencia de P3.1A sigue funcionando correctamente bajo uso
real repetido.

## 19. Limitaciones reales

1. **AI adjustment no ejercitado contra el proveedor real** — mismo
   motivo que bloqueó providers en P3.1A.1 (`ANTHROPIC_API_KEY` vive
   solo en Vercel). Contrato completo probado con inyección, no en
   vivo. Los 3 scores reales son puramente determinísticos
   (`ai_status: NOT_ATTEMPTED`), válidos por diseño.
2. **Overlap de keyword de STRATEGIC_RELEVANCE nunca se ejercitó
   positivamente con datos reales** — mismatch de idioma (tema en
   español, headlines en inglés) en los 3 casos disponibles.
3. **FINANCIAL_SCALE y TIMELINE_URGENCY sin ejercitar con datos reales
   distintos de UNKNOWN** — ninguno de los 3 eventos reales trae los
   campos numéricos que esas fórmulas necesitan (esperado, dado que son
   titulares de resumen de mercado, no anuncios corporativos
   específicos con montos).
4. Los multiplicadores de `FINANCIAL_SCALE` (500, 400, 300, 1000) son
   un punto de partida razonable, no una calibración empírica —
   tuneables vía `scoring_policy_version`.

## 20. Manual capability note

```
CAPABILITY: Material Event Scoring
WHAT IT DOES: Distingue eventos potencialmente importantes de ruido.
WHAT USER WILL SEE: Materiality score + level + confidence + explicacion
  (cuando exista UI -- todavia no en este sprint).
WHAT IT MEANS: Score alto = evento potencialmente importante. Confidence
  alto = evidencia solida. Son conceptos distintos -- pueden combinarse
  de las 4 formas (alto/alto, alto/bajo, bajo/alto, bajo/bajo), todas
  validas.
WHAT CAN GO WRONG: Fuentes incompletas (UNKNOWN inputs), AI no
  disponible (score queda puramente determinístico, nunca se rompe),
  provider delays.
WHAT USER SHOULD DO: Usarlo como priorizacion de atencion, nunca como
  señal automatica de compra/venta -- este sprint explicitamente NO
  responde esa pregunta.
STATUS: INTERNAL -- sin superficie de usuario todavia.
```

## 21. Commit

Ver SHA en el reporte del chat.
