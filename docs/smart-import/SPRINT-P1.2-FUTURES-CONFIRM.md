# Sprint P1.2 — Smart Import Futures Confirm End-to-End

> Documento de registro. Cierra el gap documentado desde la auditoría de
> Fase 1: `api/smart-import.js` nunca conectaba el "confirm" con los 2
> RPCs de Futures ya existentes y probados.

## Gap exacto

`document_type` nunca fue columna de `smart_imports` — solo vive en
`raw_extraction.document_type` (persistido, inmutable por trigger). El
handler de `extract` para los 3 tipos de snapshot (SPOT/FUTURES_ACCOUNT/
FUTURES_POSITION) siempre escribía `proposed_changes: []` a nivel de
`smart_imports`, con el warning `FUTURES_PERSISTENCE_NOT_YET_IMPLEMENTED`.
`handleConfirm()` solo sabía procesar la forma de `transaction`. Los 2
RPCs (`confirm_smart_import_futures_account_snapshot`,
`..._position_snapshot`) existían en Postgres, bien construidos, pero
cero código los invocaba.

## Diseño implementado

- `lib/futuresConfirm.js` (nuevo, puro): clasificación de balances
  (reutiliza `classifyBalanceForPersistence`/`isEconomicallyIrrelevant`
  de `futuresImportNormalize.js` — no las duplica), decisión de
  confirmación de posición (`resolvePositionConfirmDecision` — solo
  `NEW_POSITION`/`MATCH_EXISTING_HIGH` permiten confirmar), fallback de
  `observed_at`, y los constructores exactos de parámetros para ambos RPCs.
- `lib/smartImportConfirm.js`: `validateUserEditKeys(edits, whitelist)`
  ahora acepta una whitelist como parámetro (default el existente
  `USER_EDIT_WHITELIST`, comportamiento del flujo de compra/venta
  100% igual) — se agrega `FUTURES_USER_EDIT_WHITELIST = ["account_id"]`,
  el único campo editable en Futures.
- `api/smart-import.js`: `handleConfirm()` despacha por `document_type`
  (leído de `raw_extraction`, nunca confiado del cliente) hacia
  `handleConfirmFuturesAccountSnapshot` / `handleConfirmFuturesPositionSnapshot`,
  ambas nuevas. Cada una re-resuelve cuenta/asset contra Supabase EN VIVO
  (nunca confía en lo persistido en `normalized_extraction` para
  identidad), re-corre `matchDerivativePositionIdentity` contra
  `derivative_positions` actual para posiciones, y llama exclusivamente
  al RPC correspondiente — cero INSERT directo a
  `account_snapshots`/`account_snapshot_balances`/`derivative_positions`/
  `derivative_position_snapshots` desde JS.
- `src/App.jsx`: `SmartImportFlow` ahora rama por `document_type` en
  `REVIEW` hacia dos componentes nuevos (`FuturesAccountSnapshotReview`,
  `FuturesPositionSnapshotReview`) con su propio preview/confirm/success
  — la rama de compra/venta existente queda completamente intacta.
  `loadExistingImport()` (cargar por ID) ahora también deriva
  `document_type` desde `raw_extraction`, gap que hacía perder la
  distinción al recargar un import de Futures.

## Contrato de errores

Los pre-checks en JS y las respuestas del RPC reutilizan vocabulario
existente donde ya existía (`UNKNOWN_ACCOUNT`, `UNKNOWN_ASSET`,
`ACCOUNT_TYPE_MISMATCH`, `INVALID_IMPORT_STATE`, `CONFIRMATION_NOT_ALLOWED`
con `reason` = decisión real del engine, `STALE_POSITION_MATCH`,
`COIN_M_NOTIONAL_NOT_SUPPORTED`, `ALREADY_CONFIRMED`,
`RPC_UNEXPECTED_ERROR` en vez de duplicar como `RPC_ERROR`). No se
introdujo `AMBIGUOUS_POSITION_MATCH` — se reutiliza el vocabulario propio
del motor (`POSITION_IDENTITY_AMBIGUOUS`, `MATCH_EXISTING_MEDIUM`,
`INSUFFICIENT_DATA`) como `reason` bajo `CONFIRMATION_NOT_ALLOWED`.
`INVALID_APPROVED_INDICES` queda como vocabulario reservado, sin uso en
Futures — no hay un array de `proposed_changes` real que indexar (siempre
hay exactamente una cosa que confirmar por import).

## Verificación

Ver el reporte del sprint en la conversación para: PRE contract map,
tests A-P, verificación en vivo contra los 2 RPCs reales (con fixtures
en transacciones nunca comprometidas — cero huella permanente),
invariantes financieros PRE/POST, y suite completa.
