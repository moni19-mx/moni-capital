# Sprint P3.1A — Event Ingestion Foundation

> Primer sprint de implementación de Moni Intelligence. Solo la base de
> ingestión de Material Events: RAW SOURCE → NORMALIZED → DEDUPE/CLUSTER
> → FACTS → PROVENANCE → FRESHNESS → EVENT PERSISTED. Sin materiality AI,
> sin conviction, sin opportunities, sin alerts, sin UI de noticias, sin
> Daily Brief intelligence — eso es P3.1B en adelante.

## 0. Provider fact-check — BLOQUEADO EN ESTE ENTORNO

**No se pudo verificar empíricamente el acceso real a FMP/Finnhub/SEC
EDGAR desde esta sesión.** No es un hallazgo de "plan insuficiente" —
es una restricción de red del sandbox, confirmada por 2 vías
independientes:

1. `curl` directo a `data.sec.gov` → `CONNECT tunnel failed, response
   403` (política de egress del proxy del entorno).
2. `WebFetch` a `data.sec.gov` y a `financialmodelingprep.com` → ambos
   devuelven `EGRESS_BLOCKED` explícito.

El proxy de este entorno solo permite un allowlist fijo (API de
Anthropic, registries de npm/pypi/crates/etc.) — ningún proveedor
financiero externo es alcanzable, con o sin API key real.

**Este repo ya tiene la herramienta exacta para hacer este fact-check
de verdad**: `api/fmp-benchmark-temp.js` (clasifica cada endpoint FMP,
incluidos `news/stock`, `earnings`, `analyst-estimates`,
`price-target-consensus`, como `AVAILABLE`/`PLAN_BLOCKED`/`UNAVAILABLE`/
`LIMITED`/`ERROR`) y `api/sec-benchmark-temp.js`, ambos ya desplegables
en Vercel con las keys reales de producción, fuera de esta restricción
de red.

**Acción recomendada para cerrar este punto**: correr, contra el
deployment real de Vercel:
```
GET /api/fmp-benchmark-temp?pin=<MONI_PIN>&tickers=QCOM,AAPL
```
y compartir las filas de clasificación para `news_stock`, `earnings`,
`analyst_estimates`, `price_target_consensus`. No requiere código
nuevo — el endpoint ya existe y ya sabe distinguir plan-gating de
disponibilidad real.

**Consecuencia para este sprint**: todo lo que sigue (normalización,
dedupe, source hierarchy, contrato temporal, versioning, confidence,
schema, seguridad) está construido y probado con fixtures realistas
(basados en las formas de respuesta documentadas de FMP/SEC, no
inventadas) — pero el *wiring* real de `fetch()` contra los proveedores
en vivo **no se construyó ni se probó en esta sesión**, precisamente
para no declarar "funciona" algo que nunca se pudo ejecutar contra la
red real. Ver sección "Real provider examples" más abajo.

## 1-2. Schema elegido y migrations

Ejecutado (migración `material_events_ingestion_foundation`, seguida de
`material_events_functions_search_path_hardening`). Ver
`docs/intelligence/P3.1A-migration.sql` para el SQL completo mostrado
antes de ejecutar.

Solo 2 tablas, exactamente como se pidió: `material_events`,
`event_sources`. **No** se crearon `thesis_dimensions`,
`conviction_history`, ni `opportunities` — confirmado, fuera de alcance.

## 3. Source hierarchy implementada

`lib/materialEventSources.js`: `assignSourceRoles()` (asigna
`DISCOVERY_SOURCE`/`PRIMARY_EVIDENCE_SOURCE`/`CORROBORATING_SOURCE` por
tier + orden de llegada), `reassignRolesWithNewSource()` (promoción
cuando llega una fuente de mayor tier — probado en vivo contra Postgres
real, ver sección 11), `countIndependentSources()` (anti-inflación de
corroboración por `attributed_wire`).

**Regla de empate**: si 2 fuentes tienen el mismo tier, gana como
primary la que llegó primero — nunca ambiguo (Test E, cubierto).

## 4. Temporal contract implementado

`lib/materialEventTemporal.js`, con las 2 precisiones del GO
incorporadas:

- `resolveDecisionAvailableAt({processed_at})` — función nombrada
  explícita, no un alias implícito de `processed_at`. Si en el futuro
  `decision_available_at` necesita diferir de `processed_at` (ej. delay
  de revisión humana), este es el único lugar a cambiar.
- `classifyFreshness()` corregido durante este sprint (ver "Bugs
  encontrados"): `RECENT` depende solo de `occurred_at`, nunca de
  `discovered_at` como alternativa — un evento de 60 días descubierto
  hoy es `STALE`, no `RECENT`.
- Regla dura documentada en el schema (`comment on column
  decision_available_at`): cualquier análisis retrospectivo futuro debe
  filtrar por esta columna, nunca por `occurred_at`.

## 5. Versioning implementado

`lib/materialEventVersioning.js` — fuente única de `engine_version`,
`normalization_policy_version`, `confidence_policy_version`, y los
pesos/umbrales que cada policy describe (`CONFIDENCE_WEIGHTS`,
`FRESHNESS_THRESHOLDS`), versionados **juntos** con su policy
correspondiente (precisión 2 del GO). Persistidos en cada fila de
`material_events` — confirmado en la prueba en vivo (sección 11).

`source_provider`/`source_endpoint`/`ingestion_run_id`: **no
agregados** a este sprint — sin wiring real de proveedor (sección 0),
agregar estos campos ahora habría sido metadata especulativa sin nada
real que poblarla. Se agregan en el sprint donde el fetch real se
construya.

## 6. Source quality

Persistido: `event_sources.source_tier` (1-4, CHECK constraint),
`material_events.source_confidence` (deriva del tier de la
`PRIMARY_EVIDENCE_SOURCE` vía `tierScore()`). No se inventó ningún
Tier 2 ficticio — el diseño documenta explícitamente que "Tier 2" en
este sistema es wire indirecto vía FMP/Finnhub, nunca una fuente directa
propia.

## 7. Confidence breakdown

`lib/materialEventConfidence.js` — 4 factores nombrados
(`SOURCE_CONFIDENCE`/`DATA_COMPLETENESS`/`FRESHNESS_CONFIDENCE`/
`CORROBORATION_CONFIDENCE`) + `overall_confidence` ponderado, todos
persistidos junto con `confidence_policy_version`. Sin magic number
invisible — cada corrida es reproducible byte a byte con el mismo input
(Test I).

## 8. Dedupe

`lib/materialEventDedupe.js` — heurística sin embeddings: `asset_id` +
`event_type` + ventana de 24h + similitud de facts (tolerancia 5% en
montos, nunca compara contra `UNKNOWN`). Los 4 requisitos del sprint
verificados por test: múltiples sources al mismo cluster (Test C),
misma wire republicada no infla corroboración (Test D),
`primary_source_id` promocionable después (Test E), eventos distintos
mismo ticker/día no se fusionan falsamente (Test F).

## 9. Append-only / audit — no encajó el patrón existente tal cual

**Explicación honesta, tal como se pidió**: ni `prevent_snapshot_mutation`
(bloqueo total de UPDATE/DELETE, usado en `account_snapshots`) ni
`protect_raw_extraction` (bloqueo de una sola columna, usado en
`smart_imports`) encajaban sin modificación. `material_events`/
`event_sources` necesitan **ambos** comportamientos a la vez en
columnas distintas: `facts`/timestamps/versioning/confidence deben ser
inmutables (como `account_snapshots`), pero `status`/`primary_source_id`/
`requires_review`/`is_current`/`source_role` deben poder cambiar (como
la idea de `protect_raw_extraction`, generalizada a múltiples columnas
en vez de una sola).

**Solución**: 2 funciones trigger nuevas (`protect_material_event_facts`,
`protect_event_source_facts`), cada una con una allowlist explícita de
columnas mutables — cualquier cambio fuera de esa lista lanza excepción
citando el `id` de la fila. El `DELETE` sí reutiliza literalmente
`prevent_snapshot_mutation` (esa función no distingue columnas, así que
aplicarla solo al evento `DELETE` — nunca a `UPDATE` — es una reutilización
real y correcta, no forzada).

**Reprocesamiento**: si llega evidencia que contradice `facts` ya
persistidos, el diseño es crear una fila nueva con
`supersedes_event_id` apuntando a la anterior y `is_current=true` en la
nueva (`is_current=false` en la vieja) — la fila vieja nunca se toca.
La lógica de *cuándo* disparar un reproceso completo (vs. solo una
promoción de `primary_source_id`, que no requiere fila nueva) queda
para cuando exista un motor de re-extracción real — el schema ya lo
soporta, la orquestación completa es trabajo de una fase posterior.

## 10. Event types

Los 13 tipos exactos de la taxonomía aprobada, ninguno más — verificado
por test (`todos los 13 tipos... ninguno adicional se coló`). `OTHER`
siempre con `requires_review=true` a nivel de aplicación (normalizador)
y disponible como CHECK constraint a nivel de base.

## 11. Fact extraction — determinístico, sin LLM

`lib/materialEventNormalize.js`. Extracción real, sin AI, en 2 niveles
honestos:

- **`structured_field`**: cuando el proveedor ya distingue el dato (ej.
  FMP `/earnings` trae `epsActual` como número real) → se extrae
  directo.
- **`rule_based_keyword`**: para texto libre (titulares de noticias),
  clasifica `event_type` por palabras clave — nunca extrae
  `deal_value`/`counterparty` de prosa (eso requeriría NLP/LLM, fuera
  de alcance). Esos campos quedan `UNKNOWN` explícito.
- **`unclassified`**: ninguna regla aplicó → `OTHER` +
  `requires_review=true`, nunca un tipo forzado.

SEC filings sin número de Item (la forma básica de
`submissions/CIK{cik}.json` no lo trae) se clasifican honestamente como
`OTHER` — adivinar el tipo desde el form genérico (`8-K` solo) sería
inventar, no extraer.

## 12. Real provider examples — NO EJECUTADO

**No se generaron ejemplos reales.** Por la misma razón de la sección
0 (egress bloqueado), no fue posible traer 3-5 casos reales de
earnings/news/filing/duplicado multi-fuente. Los fixtures usados en
tests están basados en las formas de respuesta *documentadas* de FMP
(confirmadas por los nombres de campo que ya usa
`api/fmp-benchmark-temp.js` en este mismo repo) — nunca presentados
como datos reales capturados en esta sesión.

## 13-15. Tests, suite completa, security regression

**220/220 tests** (`node --test tests/*.test.js`) — 175 previos + 45
nuevos (`materialEventNormalize.test.js`,
`materialEventSources.test.js`, `materialEventDedupe.test.js`,
`materialEventTemporal.test.js`, `materialEventConfidence.test.js`).

| Test | Resultado |
|---|---|
| A - source válido → event normalizado | PASS |
| B - unknown field → UNKNOWN, nunca inventado | PASS |
| C - 2 providers mismo evento → 1 cluster | PASS |
| D - misma wire republicada 5 veces → corroboration no se infla | PASS |
| E - Tier 3 primero, Tier 1 después → promoción correcta | PASS (unit + verificado en vivo contra Postgres real) |
| F - eventos distintos mismo ticker/día → no dedupe falso | PASS |
| G - evento antiguo descubierto hoy → no se marca FRESH incorrectamente | PASS (bug real encontrado y corregido, ver abajo) |
| H - timestamps preservados correctamente | PASS |
| I - confidence breakdown reproducible | PASS |
| J - confidence_policy_version persistido | PASS (unit + verificado en fila real de Postgres) |
| K - engine/scoring version persistidos | PASS (verificado en fila real de Postgres) |
| L - rerun/idempotencia | PASS (a nivel de diseño de dedupe; la garantía real depende de que la capa de persistencia consulte candidatos antes de insertar — documentado explícitamente) |
| M - fallo parcial provider → no corrupción | PASS |
| N - fuente sin URL/timestamp → degraded confidence, no fake data | PASS |
| O - security/grants | PASS (ver sección 14) |
| P - regression suite completa | PASS — 220/220 |

**Security regression (O)**: `mcp__Supabase__get_advisors` (security)
corrido antes y después de la migración. RLS enabled + cero policy en
ambas tablas nuevas (deny-all real, no solo grants) — confirmado
también empíricamente: un `SET LOCAL ROLE anon; SELECT * FROM
material_events` dentro de la transacción de prueba (nunca comprometida)
devolvió `permission denied for table material_events`. `anon`/
`authenticated` sin ningún grant (`revoke all` explícito ejecutado —
ver hallazgo de seguridad abajo). Los 2 warnings nuevos de
`function_search_path_mutable` que introdujo la migración se corrigieron
en la misma sesión (`set search_path = public` en ambas funciones
nuevas) — quedan 2 warnings pre-existentes (`protect_raw_extraction`,
`prevent_snapshot_mutation`) fuera de alcance de este sprint.

## Hallazgo de seguridad adicional (fuera del alcance original, reportado igual)

Confirmado empíricamente vía `pg_default_acl`: **los "default
privileges" del schema `public` todavía otorgan a `anon`/`authenticated`
los 7 privilegios completos (incluido `TRUNCATE`, que RLS no cubre)
sobre CUALQUIER tabla nueva** creada por el rol `postgres`. Fase 0
corrigió los grants de las 27 tablas que existían en ese momento, pero
nunca corrigió el default — así que, sin el `revoke all` explícito que
esta migración sí incluyó, `material_events`/`event_sources` habrían
reabierto silenciosamente el mismo agujero que Fase 0 cerró.

**Mitigado para estas 2 tablas** (revoke explícito en la migración,
verificado). **No mitigado a nivel de schema** — cualquier tabla futura
que no incluya su propio `revoke all` seguirá naciendo vulnerable. Esto
es una decisión de seguridad más amplia (afecta a todas las tablas
futuras del proyecto, no solo a Moni Intelligence) — recomiendo un
sprint de seguridad dedicado para corregir el `ALTER DEFAULT
PRIVILEGES` a nivel de schema, no lo hice unilateralmente aquí por
respeto a "no expandas el scope" de este sprint.

## 16. Docs / manual capability note

```
USER-FACING CAPABILITY: Material Event ingestion foundation
WHAT IT DOES: Normaliza y deduplica eventos de mercado (earnings,
  contratos, guidance, etc.) desde proveedores de datos, con
  clasificación de fuente y confidence score -- sin interpretación de
  IA todavia.
WHAT THE USER SEES NOW: Nada -- no hay superficie de UI en este
  sprint. Las tablas existen en Supabase, sin ningun endpoint ni
  pantalla que las muestre.
WHAT IT MEANS: Es la base de datos/logica sobre la que se construira
  Moni Intelligence (Daily Brief con eventos, thesis impact, conviction
  changes) en sprints posteriores.
WHAT CAN GO WRONG: N/A todavia -- sin ingestion real en vivo conectada
  (ver seccion 0), no hay forma de que esto afecte al usuario hoy.
WHAT THE USER SHOULD DO: Nada por ahora.
STATUS: INTERNAL -- ni siquiera BETA, cero superficie de usuario.
```

## 17. Bugs encontrados

**Bug real en `classifyFreshness()`** (encontrado por Test G, no
cosmético): la condición original de `RECENT` era `discoveredDaysAgo
<= 7 OR occurredDaysAgo <= 30` — con el `OR`, un evento ocurrido hace
60 días pero descubierto hoy calificaba como `RECENT` solo por la
recencia del descubrimiento, exactamente el tipo de "noticia vieja
disfrazada de nueva" que este módulo existe para prevenir. Corregido:
`RECENT` depende únicamente de `occurredDaysAgo` — `discoveredDaysAgo`
ya no participa como alternativa independiente. `recentDiscoveredWithinDays`
eliminado de `FRESHNESS_THRESHOLDS` (config muerta que ya no controlaba
nada). Verificado con test explícito antes y después del fix.

## 18. Limitaciones reales

1. **Provider fact-check y real provider examples no ejecutados** —
   bloqueado por política de egress del sandbox (sección 0), no por
   falta de plan de FMP/Finnhub (eso sigue sin verificarse). Acción
   concreta recomendada en la sección 0.
2. **Sin wiring de fetch real contra proveedores** — todo el pipeline
   está probado con fixtures, nunca contra HTTP real en esta sesión.
3. **`source_provider`/`source_endpoint`/`ingestion_run_id`** no
   agregados al schema — se agregarán junto con el wiring real, no
   antes.
4. **Idempotencia real depende de disciplina de la capa de
   persistencia** (consultar candidatos existentes antes de insertar)
   — el módulo de dedupe está probado y es correcto, pero no hay
   todavía una función de persistencia orquestadora que lo invoque
   automáticamente (esa orquestación requiere el wiring de fetch real,
   fuera de alcance por la razón de la sección 0).

## 19-20. Commit / decisión

Ver reporte del sprint (mensaje de chat) para SHA y decisión GO/BLOCKED
final.
