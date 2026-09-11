# Sprint P0.1 — Reliable Data Loading / No UI Data Loss

> Documento de registro. No mezcla otros hallazgos del roadmap — solo el
> ciclo de vida de fetch de `App.jsx::loadAll()`.

## Causa raíz (PRE)

`loadAll()` (`src/App.jsx`) corre en un `setInterval` cada 60 segundos,
automáticamente, además de en el mount y tras cualquier acción manual
(botón "Actualizar precios", cerrar el formulario de agregar posición,
cerrar Smart Import). Antes de este sprint:

- 11 de las 12 lecturas directas a Supabase (`sb("watchlist")`,
  `sb("cash_movements")`, etc.) tenían `.catch(() => [])` — un fallo
  transitorio de red reemplazaba datos válidos ya en pantalla por un
  arreglo vacío.
- `fetchFuturesEquity()` atrapaba **cualquier** fallo (red o HTTP) y
  devolvía `{total_value_usd: 0, ...}` — indistinguible de una cuenta
  Futures que genuinamente vale $0. Era la instancia más severa del bug:
  un hiccup de CoinGecko podía borrar visualmente miles de dólares de
  Futures Equity del Patrimonio Total.
- `fetchMarketPulse()` hacía lo mismo con `null`.
- `fetchMarketData()` estaba con `await` directo dentro del `try`
  principal — si fallaba, la excepción saltaba al `catch` general y
  **`fetchFuturesEquity()` nunca llegaba a intentarse siquiera** en ese
  ciclo (dependencia de orden no intencional entre dos fuentes que no
  tienen relación entre sí).
- Sin protección de concurrencia: el botón manual solo se deshabilita
  visualmente (`disabled={loading}`), pero no impide que el `setInterval`
  dispare un segundo `loadAll()` mientras el primero sigue en vuelo. Dos
  ejecuciones solapadas podían resolver en cualquier orden y la más
  vieja podía sobrescribir el estado de la más nueva.

## Diseño implementado

- `lib/dataSourceState.js` (nuevo, puro): clasifica cada fuente en
  `NEVER_LOADED | OK | STALE | ERROR` dado el resultado de un intento
  (misma forma que `Promise.allSettled`) y el estado anterior. Nunca
  decide el dato en sí — decidir "conservar el último valor bueno" es
  simplemente no llamar al setter de React en la rama `rejected`.
- `lib/dataFetchers.js` (nuevo): `sbSelectAll`, `fetchMarketDataBatch`,
  `fetchFuturesEquity`, `fetchMarketPulse` — los mismos 4 fetchers,
  extraídos de `App.jsx` para poder probarlos con `fetch` mockeado.
  Ninguno se traga un fallo: todos propagan el error como rejection.
- `App.jsx::loadAll()`: reescrito para usar `Promise.allSettled` en las
  12 lecturas de Supabase Y en el trío
  market-pulse/market-data/futures-equity (antes secuencial con
  dependencia de orden accidental). Cada setter de React solo se llama
  en la rama `fulfilled`. Guard de concurrencia con un contador
  monotónico (`latestRequestIdRef`) — la request más reciente en
  iniciar es la única que puede comprometer estado; cualquier request
  más vieja que siga en vuelo se descarta entera en cuanto se detecta
  que fue superada.
- Estado de frescura por fuente (`sourceMeta`, 15 fuentes) preparado y
  poblado en cada ciclo — sin UI nueva todavía (fuera de alcance de este
  sprint, es la base para P1.1).

## Archivos modificados

- `src/App.jsx` (126 inserciones, 74 eliminaciones — solo el bloque de
  fetchers + `loadAll()` + estado nuevo; cero cambios en fórmulas
  financieras, componentes visuales, u otras 4,200+ líneas del archivo).
- `lib/dataSourceState.js` (nuevo).
- `lib/dataFetchers.js` (nuevo).
- `tests/dataSourceState.test.js` (nuevo, 21 tests).
- `tests/dataFetchers.test.js` (nuevo, incluido en el conteo de arriba).

## Fórmulas financieras — sin cambios

`App.jsx:346-348` (`patrimonioBase`, `futuresEquityUsd`, `patrimonio`) —
verificado línea por línea, texto idéntico antes y después de este
sprint. Ningún archivo de `lib/reconciliationEngine.js`,
`lib/financialMath.js`, `api/*`, ni el schema de Supabase fue tocado.
