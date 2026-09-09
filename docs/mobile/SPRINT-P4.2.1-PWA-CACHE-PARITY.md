# Sprint P4.2.1 — Service Worker Cache Policy Parity

> Cierre pendiente de P4.2. Elimina la duplicación real entre
> `lib/pwaCacheStrategy.js` (classifier puro) y `public/sw.js`
> (implementación ejecutada por el navegador), y agrega un test que
> ejecuta el `public/sw.js` REAL para probar su comportamiento, no una
> reimplementación de su lógica.

## 1. ¿Había duplicación real?

**Sí.** `public/sw.js` (Sprint P4.2) reimplementaba a mano —
"literalmente", según su propio comentario — las mismas constantes
(`NEVER_CACHE_PREFIXES`) y funciones (`isNeverCachePath`,
`isAppShellPath`, `isImmutableBuildAsset`, `isStaticShellAsset`) que ya
existían en `lib/pwaCacheStrategy.js`. Los 9 tests de
`tests/pwaCacheStrategy.test.js` (Sprint P4.2) solo probaban el
classifier puro — nunca ejecutaban `public/sw.js`. Nada impedía que
alguien editara un archivo sin tocar el otro.

## 2. Cómo quedó eliminada

**Opción 1 del pedido (config única), no opción 2 (solo test).** Un
archivo nuevo, `public/pwa-cache-policy.js`, es ahora la única fuente
de verdad de la política de cache. Escrito sin `import`/`export` (IIFE
que publica `globalThis.MoniPwaPolicy`) para poder cargarse
literalmente igual en los 2 contextos que lo necesitan:

- **`public/sw.js`** (service worker real, clásico — sin
  `type:"module"`, necesario para soporte confiable en iOS Safari) lo
  carga con `importScripts("/pwa-cache-policy.js")` — la forma nativa
  de un worker clásico de compartir código, soportada por todos los
  navegadores desde siempre. El `fetch` handler de `sw.js` ya no
  decide nada por sí mismo: llama a
  `self.MoniPwaPolicy.resolveCacheStrategy(pathname, {mode})` y solo
  despacha a `networkFirst`/`cacheFirst`/`staleWhileRevalidate` según
  el string que reciba, o deja pasar la request si es `"network-only"`.
- **`lib/pwaCacheStrategy.js`** ahora es un shim de ~15 líneas: importa
  `public/pwa-cache-policy.js` por efecto lateral (bajo `"type":"module"`
  de `package.json`, un `.js` sin `import`/`export` sigue siendo un
  módulo ES válido) y re-exporta `globalThis.MoniPwaPolicy` con nombres.
  Cero lógica propia — nada que pueda desincronizarse.

Resultado: **cambiar la política de cache financiera hoy requiere
editar un solo archivo** (`public/pwa-cache-policy.js`). Ni
`lib/pwaCacheStrategy.js` ni `public/sw.js` vuelven a tener una copia
propia de `NEVER_CACHE_PREFIXES` ni de ninguna función de clasificación.

### Extra: se cerró un gap real de "navigation fallback"

Al centralizar la política se aprovechó para agregar la rama que el
sprint pedía demostrar con tests (sección "Navigation fallback" más
abajo): `resolveCacheStrategy(pathname, { mode })` ahora acepta el
`request.mode` del Fetch API y, si nada más matchea Y `mode ===
"navigate"` (navegación real de pestaña, nunca un `fetch()`/XHR de
datos), devuelve `"network-first"` — el mismo tratamiento que `/`. Esto
va estrictamente DESPUÉS del check `isNeverCachePath` en el orden de
evaluación, así que un financiero nunca puede "ganarle" al fallback.
Antes de este cambio, una navegación directa a una ruta que no fuera
exactamente `/` no tenía ningún camino de app-shell offline — un gap
real, no solo teórico, para el objetivo propio de P4.2 ("C. OFFLINE +
APP SHELL DISPONIBLE").

## 3. Evidencia sobre `public/sw.js` REAL

Nuevo `tests/helpers/swHarness.js`: ejecuta el **archivo real**
`public/sw.js` (que a su vez ejecuta el **archivo real**
`public/pwa-cache-policy.js` vía un mock de `importScripts` que lee el
mismo archivo de disco) dentro de un `vm.createContext` de Node, con
`self`/`caches`/`fetch` mockeados. Expone `dispatchFetch({path, method,
mode})`, que dispara un `FetchEvent` sintético contra los listeners
REALES registrados por el código REAL, y reporta si
`event.respondWith()` fue invocado.

**Verificación de que el harness realmente prueba algo** (no
documentada como test permanente, hecha manualmente antes de commitear):
mutar `public/sw.js` para ignorar `resolveCacheStrategy()` y hardcodear
`strategy = "cache-first"` hizo que **23 de 43 tests fallaran
inmediatamente** (los 8 endpoints financieros nombrados pasaron a
"interceptarse", rompiendo el invariante fail-closed) — confirma que el
harness ejecuta el código real y detecta una regresión real, no una
tautología. Revertido antes de continuar (`diff` contra el original:
idéntico).

## 4. Navigation fallback tests

`tests/swReal.test.js`, sección "NAVIGATION FALLBACK":

- `GET /` con `mode: "navigate"` → app-shell (network-first). ✓
- `GET /portfolio` (ruta SPA hipotética, esta app no tiene router hoy)
  con `mode: "navigate"` → SÍ recibe app-shell fallback. ✓
- `GET /api/lo-que-sea` con `mode: "navigate"` → JAMÁS app-shell, sigue
  siendo network-only (el check financiero tiene prioridad absoluta). ✓
- `GET /rest/v1/positions` con `mode: "navigate"` → JAMÁS app-shell. ✓
- Un `fetch()`/XHR normal (`mode: "cors"`) a una ruta desconocida → NO
  recibe app-shell (el fallback es exclusivo de navegación real). ✓
- Una respuesta financiera con error HTTP (mock de `fetch` devolviendo
  `{ok:false, status:500}`) nunca es interceptada/transformada por el
  SW — el SW se hace a un lado por completo en rutas financieras, así
  que un 500/404 real llega intacto al código de la app, nunca se
  disfraza de "página HTML exitosa". ✓

## 5. Cross-origin / Supabase tests

`tests/swReal.test.js`, sección "CROSS-ORIGIN" — contra el `sw.js`
real, no el classifier:

- `https://sjnobxdzlzcqnfjodxri.supabase.co/rest/v1/positions` →
  nunca interceptada (aunque el pathname luzca como Supabase REST, el
  check de origen es incondicional y va primero). ✓
- La misma prueba con un pathname de asset estático
  (`.../icons/icon-512.png`) en el dominio de Supabase → tampoco se
  intercepta, confirmando que el check de origen no depende del
  pathname en absoluto. ✓
- Binance, FMP, CoinGecko, Google Fonts → nunca interceptados. ✓
- Control positivo: la misma ruta de asset (`/assets/...`) en el
  origen propio SÍ se intercepta — confirma que el mock de origen
  funciona correctamente en ambas direcciones, no que todo pase
  siempre. ✓

## 6. Drift test

Sección "PARIDAD/DRIFT" de `tests/swReal.test.js`: 15 casos de ruta ×
modo (incluye rutas hipotéticas/futuras como
`/api/futuro-endpoint-financiero`) donde, para cada uno, se llama a
`resolveCacheStrategy()` (vía el shim `lib/pwaCacheStrategy.js`) Y se
dispara un `dispatchFetch` contra el **SW real**, comparando
`estrategia !== "network-only"` contra `event.responded`. Con la
política ya centralizada (punto 2), este tipo de drift es
estructuralmente imposible en los DATOS de la política — pero el test
sigue protegiendo el **cableado**: si en el futuro alguien edita el
`fetch` handler de `sw.js` para dejar de llamar a
`resolveCacheStrategy()`, hardcodear una rama, o invertir el orden de
los checks, este test lo detecta (demostrado en el punto 3). No son dos
suites independientes que "hoy casualmente" esperan lo mismo: una mitad
de cada assertion ejecuta el archivo real que sirve el navegador.

## 7. Suite final

`node --test tests/*.test.js` → **175/175 PASS** (132 previos +
**43 nuevos**, todos en `tests/swReal.test.js` — fail-closed sobre los 8
endpoints financieros nombrados, Supabase REST/RPC/Auth, los 4 métodos
de escritura, POST `/api/smart-import`, cross-origin/Supabase, y
navigation fallback, más 15 casos de paridad ruta×modo y 1 test de
sanidad del harness). Verificado corriendo `tests/swReal.test.js` en
aislamiento (`# tests 43 / # pass 43 / # fail 0`).

## 8. Build

`npm run build` → limpio. `dist/pwa-cache-policy.js` y `dist/sw.js`
presentes (el primero es nuevo respecto a P4.2, ambos servidos
correctamente — verificado con `curl` contra el dev server:
`sw.js: 200`, `pwa-cache-policy.js: 200`). El bundle de React
(`dist/assets/index-*.js`) no cambió de tamaño (741.93 kB, idéntico a
P4.2) — `lib/pwaCacheStrategy.js` nunca fue importado por
`src/App.jsx`/`src/main.jsx`, así que este cambio no toca en absoluto
el código que corre en el navegador fuera del propio service worker.

## 9. Archivos modificados

- `lib/pwaCacheStrategy.js` (reescrito como shim, -60 líneas netas de
  lógica propia)
- `public/sw.js` (reescrito para usar `importScripts` + delegar en
  `resolveCacheStrategy`, -44 líneas netas de lógica propia)
- `public/pwa-cache-policy.js` (nuevo — única fuente de verdad)
- `tests/helpers/swHarness.js` (nuevo — ejecuta el SW real en `vm`)
- `tests/swReal.test.js` (nuevo — 43 tests)
- `docs/mobile/SPRINT-P4.2.1-PWA-CACHE-PARITY.md` (este archivo)

Cero cambios a `src/App.jsx`, `public/manifest.webmanifest`,
`public/icons/*`, cualquier archivo financiero, RPC, o Supabase — todos
fuera del scope de este sprint y verificado por `git status`.

## 10. Commit SHA

Ver mensaje de commit — pusheado sobre `6ce9463` en
`claude/supabase-moni-capital-bggymh`.
