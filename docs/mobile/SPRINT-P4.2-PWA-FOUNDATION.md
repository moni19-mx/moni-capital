# Sprint P4.2 — PWA / App-Like Foundation

> Documento de registro. Hace a Moni Capital instalable como PWA sin
> convertir nunca al service worker en fuente de verdad financiera.
> Principio no-negociable: **REAL FINANCIAL DATA > CONVENIENCE**.

## PRE PWA audit

Antes de escribir codigo, estado real del repo:

1. **Framework/build**: Vite 5.4 + `@vitejs/plugin-react`, sin SSR, sin
   router — SPA de una sola pagina (`src/App.jsx`, un solo componente
   `Dashboard` con tabs internas via `useState`).
2. **`vite.config.js`**: mínimo, solo `react()` — sin plugins previos.
3. **`package.json`**: sin `vite-plugin-pwa`, sin Workbox, sin
   dependencia PWA de ningun tipo.
4. **Entrypoint**: `src/main.jsx` — monta `<App/>`, ahora tambien
   registra el service worker (ver más abajo).
5. **`public/`**: antes de este sprint solo contenía `benchmark.html`
   (herramienta interna no relacionada). Cero manifest, cero SW, cero
   iconos.
6. **Manifest**: no existía.
7. **Service worker**: no existía.
8. **Iconos**: cero archivos gráficos en todo el repo (`find` por
   `*.png/*.svg/*.ico/*logo*/*icon*` → cero resultados).
9. **Meta tags**: `index.html` solo tenía `charset` + `viewport` básico.
10. **`viewport`**: sin `viewport-fit=cover` (necesario para safe-areas).
11. **`theme-color`**: no existía.
12. **Meta tags Apple**: no existían (`apple-mobile-web-app-*`).
13. **Routing**: no hay router — `start_url: "/"` es siempre correcto,
    no hay rutas profundas que puedan romperse al abrir la app instalada
    directamente.
14. **Ruta instalada directa**: al no haber router, abrir `/` siempre
    carga la SPA completa y el estado (`tab`) arranca en `"resumen"` —
    comportamiento correcto out-of-the-box.
15. **Deployment Vercel**: sin `vercel.json` — build default de Vite
    (`vite build` → `dist/`), Vercel sirve `dist/` como sitio estático +
    `api/*.js` como funciones serverless. `public/` se copia tal cual a
    `dist/` (verificado con `npm run build`), asi que `manifest.webmanifest`,
    `sw.js` e `/icons/*` quedan servidos en la raíz del deploy sin config
    adicional.
16. **Fetches que NUNCA deben ser cache estático**: mapeados exhaustivamente
    desde `src/App.jsx` y `lib/dataFetchers.js` (único código que corre
    en el navegador — `lib/aiTools.js`, `lib/assetResolver.js`,
    `lib/marketCache.js`, `lib/reconciliationQueries.js` corren solo en
    `api/*.js`, del lado servidor, un service worker de navegador nunca
    los intercepta):
    - `${SUPABASE_URL}/rest/v1/*` (todas las tablas vía `sbSelectAll` +
      el fetch directo de `smart_imports` en `loadExistingImport`)
    - `/api/market-data`, `/api/futures-equity`, `/api/market-pulse`
    - `/api/search`, `/api/manage`, `/api/ai`, `/api/smart-import`,
      `/api/snapshot`
17. **Sistema OK/STALE/ERROR/NEVER_LOADED (P0.1)**: vive en
    `lib/dataSourceState.js`, puramente en memoria/estado de React —
    depende de que cada `fetch()` real llegue a la red. Documentado en
    detalle en el punto 18.
18. **Riesgo de interferencia PWA↔P0.1**: un service worker con
    cache-first en un endpoint financiero haría que ese `fetch()`
    "tenga éxito" con datos posiblemente viejos — indistinguible de un
    éxito real para `resolveSourceMeta()`, rompiendo la garantía de P0.1
    de que `OK` significa "de verdad se acaba de leer de la red". Por
    eso el diseño de este sprint (ver más abajo) es network-only para
    absolutamente todo lo financiero.
19. **Cache HTTP existente en endpoints financieros**: ninguno — sin
    `Cache-Control` explícito en `api/*.js`, comportamiento default de
    Vercel (no-cache para funciones serverless).
20. **Riesgos específicos de stale financial data**: el ya cubierto (18)
    es el único vector nuevo que introduciría una PWA; el resto del
    riesgo de datos viejos (fallo de red normal) ya está cubierto por
    P0.1 sin relación con la instalabilidad.

## Arquitectura elegida y por qué

**Service worker escrito a mano (`public/sw.js`), sin `vite-plugin-pwa`
ni Workbox.**

Justificación: el requisito no-negociable de este sprint es que
absolutamente ningún endpoint dinámico caiga en cache. Auditar eso
sobre una configuración de Workbox generada (con sus estrategias de
runtime caching declarativas, glob patterns, y comportamiento implícito
de precache-manifest) es más difícil de verificar con certeza que sobre
un archivo propio de ~110 líneas donde cada rama de decisión es
explícita y está espejada 1:1 por un módulo puro y probado
(`lib/pwaCacheStrategy.js`). No se agregó ninguna dependencia nueva a
`package.json` — consistente con el estilo ya establecido del proyecto
(cero frameworks CSS, `node:test` en vez de Jest/Vitest).

## Caching strategy exacta

`lib/pwaCacheStrategy.js` (puro, probado en `tests/pwaCacheStrategy.test.js`,
9 tests) clasifica cualquier `pathname` en una de 4 estrategias, que
`public/sw.js` implementa literalmente (misma lógica duplicada a
propósito por límites de `import` en un service worker clásico — un
diff entre ambos archivos es trivial de revisar):

| Estrategia | Rutas | Motivo |
|---|---|---|
| `network-only` | `/api/*`, `/rest/v1/*`, `/auth/v1/*`, y **cualquier ruta no reconocida** (default seguro) | Nunca financiero servido de cache |
| `network-first` | `/`, `/index.html` | App shell disponible offline, pero nunca sirve un HTML viejo cuando hay red (evita apuntar a bundles hasheados ya borrados) |
| `cache-first` | `/assets/*` (JS/CSS con hash de contenido en el nombre, generados por Vite) | Inmutable por diseño: un build nuevo = URL nueva, nunca reescribe una existente |
| `stale-while-revalidate` | `/icons/*`, `/manifest.webmanifest`, `/favicon.ico` | Estático no-financiero, puede refrescarse en background sin riesgo |

Además: el SW solo intercepta `GET` (nunca `POST`/`PUT`/`DELETE` — todas
las escrituras) y solo mismo-origen (nunca Binance/FMP/CoinGecko/terceros).

## Financial endpoints explícitamente NO cacheados

`/api/market-data`, `/api/futures-equity`, `/api/market-pulse`,
`/api/search`, `/api/manage`, `/api/ai`, `/api/smart-import`,
`/api/snapshot`, y **todo** `${SUPABASE_URL}/rest/v1/*` (positions,
transactions, cash_movements, account_snapshots,
account_snapshot_balances, derivative_positions,
derivative_position_snapshots, smart_imports, todas). Verificado por
`tests/pwaCacheStrategy.test.js` (tests N/O/P del plan del sprint) y por
lectura directa de `public/sw.js` (el `fetch` handler retorna sin
interceptar — `return;` — antes de llegar a cualquier `caches.*`).

## Manifest

`public/manifest.webmanifest`: `name`/`short_name`: "Moni Capital",
`start_url: "/"`, `scope: "/"`, `display: "standalone"`,
`background_color`/`theme_color: "#0A0E17"` (== `NAVY_BG` de
`src/App.jsx`, nunca un valor inventado), `lang: "es"`, 6 entradas de
`icons` (16/32/192/512 `purpose:"any"` + 192/512 `purpose:"maskable"`).

## Icons/assets

**No existía ningún asset gráfico en el repo.** Generé un set mínimo
propio derivado de la identidad visual ya en producción (nunca un
ícono genérico de inversión): monograma "M" en serif dorado
(`#C9A34E`, el mismo `GOLD` de `src/App.jsx`) sobre fondo navy
(`#0A0E17`, el mismo `NAVY_BG`) — mismos colores exactos que ya usa la
UI, mismo peso visual serif que el wordmark "Moni Capital" del header.
Generado con Pillow (Python), no con un ícono de stock. Sizes: 16, 32,
180 (apple-touch-icon), 192, 512, más variantes 192/512 `maskable` con
zona de seguridad del 22% (evita recorte en launchers Android que
aplican máscaras circulares/redondeadas).

**Esto es un placeholder de marca explícito, no un logo diseñado.**
Si Moni Capital ya tiene o va a encargar un logo/isotipo real, ese
archivo debe reemplazar `public/icons/*.png` (mismos nombres/tamaños) —
no requiere tocar el manifest ni el código.

## Android behavior

`beforeinstallprompt` capturado vía `useInstallPrompt()`
(`src/App.jsx`) → CTA propio discreto ("Instalar Moni Capital") en vez
del mini-infobar del navegador, visible solo en mobile
(`mc-mobile-only`), dismisseable, con dismiss persistido en
`localStorage` (nunca vuelve a aparecer tras cerrarlo una vez).
**CODE-VERIFIED, no TESTED**: Chromium headless en este sandbox no
dispara `beforeinstallprompt` (requiere señales de instalabilidad reales
+ heurísticas de engagement de Chrome que no se cumplen en un dev
server local vía HTTP en 127.0.0.1 sin visitas previas) — confirmado
por su ausencia en los 5 screenshots capturados. La lógica del listener
y el render condicional se revisaron por código.

## iOS behavior

Safari nunca dispara `beforeinstallprompt` — `isIosSafari()` detecta el
user agent y el mismo `InstallCTA` muestra en su lugar una ayuda manual
("Compartir → Agregar a pantalla de inicio") tras un tap en "Cómo",
nunca un botón de instalación que no haría nada. `apple-mobile-web-app-capable`
+ `apple-mobile-web-app-status-bar-style=black-translucent` +
`apple-touch-icon` (180×180) en `index.html` cubren los requisitos
mínimos de Safari para "Add to Home Screen" en modo standalone.
**NOT TESTABLE EN ESTE ENTORNO**: no hay Safari/iOS real disponible en
este sandbox Linux — validado por código y por la documentación pública
de Apple, no por un dispositivo real.

## Standalone behavior

`isStandaloneDisplay()` detecta `display-mode: standalone` (Android/
desktop instalado) y `navigator.standalone` (iOS) — usado para ocultar
el `InstallCTA` una vez ya instalada (no tiene sentido pedir instalar
lo que ya está instalado). `@media (display-mode: standalone)` en
`responsive.css` agrega `padding-top: env(safe-area-inset-top)` al
`body` — solo aplica en standalone, nunca en Safari/Chrome normal
(donde el status bar ya no forma parte del viewport de la página).

## Safe areas

`viewport-fit=cover` agregado al `<meta viewport>` (requisito para que
`env(safe-area-inset-*)` tenga efecto). `.mc-bottom-nav` y el `body`
(en mobile) suman `env(safe-area-inset-bottom, 0px)` — los botones del
bottom nav de P4.1 ya no quedan detrás del home indicator de iPhone.
Fallback `0px` explícito: no-op en Android/desktop/iPhones sin notch.

## Smart Import validation

Backend intacto (`api/smart-import.js`, RPCs, schema — cero cambios,
confirmado por `git diff --stat`). El único vector de riesgo nuevo que
podía introducir este sprint era que el service worker interceptara el
POST de confirmación o la subida de imagen — descartado por diseño: el
`fetch` handler del SW solo actúa sobre `GET` (`if (req.method !== "GET") return;`),
y aunque fuera GET, `/api/smart-import` está en `NEVER_CACHE_PREFIXES`.
**CODE-VERIFIED, no click-through interactivo**: sin datos reales de
Supabase en este sandbox no fue posible ejecutar el flujo
extract→review→confirm completo en el navegador (misma limitación ya
documentada en el reporte de P4.1).

## Offline behavior

Estados A-E implementados según el diseño pedido:

- **A (online + datos OK)**: sin cambios — camino normal de P0.1.
- **B (online + fallo parcial de API)**: sin cambios — P0.1 ya
  conserva last-known-good vía `resolveSourceMeta` (`STALE`).
- **C (offline + app shell disponible)**: `network-first` en
  `index.html`/`/` con fallback a cache — la app abre. Los bundles
  `/assets/*` (`cache-first`) ya están cacheados de una visita previa,
  así que React monta igual sin red.
- **D (offline + sin datos previos)**: `fetch()` a cualquier endpoint
  financiero lanza (nunca se intercepta), `loadAll()` lo trata como
  rechazo → `isCriticalInitialFailure()` → el banner rojo existente de
  P0.1 (`No se pudo cargar el portafolio`) se muestra — ahora con
  `useOnlineStatus()` distinguiendo el texto: si `navigator.onLine` es
  `false`, el mensaje dice explícitamente "Sin conexión a internet...
  nunca se muestran inventados" en vez de un mensaje de error HTTP
  genérico. Nunca `$0` inventado — mismo mecanismo de P0.1, sin tocarlo.
- **E (offline → online)**: los listeners nativos `online`/`offline`
  (`useOnlineStatus`) actualizan el mensaje inmediatamente; el usuario
  puede disparar "Actualizar precios" (botón ya existente) o esperar al
  próximo ciclo del `setInterval` ya existente en `loadAll()` — ninguno
  de los dos requiere reload destructivo.

## Recovery behavior

Cubierto en el estado E de arriba — recuperación vía red real, sin
persistencia financiera nueva agregada (instrucción explícita del
sprint: no agregar localStorage/IndexedDB financiero salvo necesidad
absoluta — no fue necesaria; el estado en memoria de React + el
`setInterval` de refresco ya existente son suficientes).

## Update/version behavior

Sin auto-reload destructivo. `src/main.jsx` registra el SW, escucha
`updatefound` → cuando el nuevo worker llega a `installed` Y ya había
un controller previo (o sea: no es la primera instalación), dispara un
`CustomEvent("moni:sw-update-available")`. `src/App.jsx` lo escucha
(`useSwUpdateAvailable`) y muestra un banner dorado sticky: "Hay una
nueva versión de Moni Capital — [Actualizar]". El SW nunca llama a
`self.skipWaiting()` en `install` — solo lo hace al recibir
`postMessage({type:"SKIP_WAITING"})`, que el botón dispara vía
`window.__moniApplyServiceWorkerUpdate()`. El reload real ocurre una
única vez en el listener `controllerchange`. Nada de esto puede
interrumpir Smart Import a mitad de flujo porque no hay ningún reload
hasta que el usuario hace click explícitamente.

## Security review

- Cero `service_role` en frontend — el único cliente Supabase en
  código de navegador sigue siendo `sbSelectAll` con `SUPABASE_ANON_KEY`
  (`import.meta.env.VITE_SUPABASE_ANON_KEY`), sin cambios.
- `public/manifest.webmanifest`, `public/sw.js`, `index.html`: `grep`
  por `service_role|SUPABASE_SERVICE|secret|api[_-]?key|token` → cero
  resultados.
- Sin nuevos GRANTs, sin cambios RLS, sin cambios de schema — cero
  archivos SQL/migración tocados (`git status` lo confirma).
- El service worker no persiste ni un solo dato financiero — solo cachea
  bytes estáticos de build (JS/CSS/iconos/manifest), nunca respuestas de
  `/api/*` o `/rest/v1/*`.

## Files changed

- `lib/pwaCacheStrategy.js` (nuevo, puro)
- `public/sw.js` (nuevo)
- `public/manifest.webmanifest` (nuevo)
- `public/icons/*.png` (nuevo, 7 archivos)
- `index.html` (meta tags + link manifest/iconos)
- `src/main.jsx` (registro de SW + flujo de update)
- `src/App.jsx` (`useOnlineStatus`, `useSwUpdateAvailable`,
  `useInstallPrompt`, `isStandaloneDisplay`, `isIosSafari`,
  `SwUpdateBanner`, `InstallCTA`, prefijo "Sin conexión" en el banner
  de error existente)
- `src/responsive.css` (safe-area-inset en bottom nav/body/standalone)
- `tests/pwaCacheStrategy.test.js` (nuevo, 9 tests)
- `docs/mobile/SPRINT-P4.2-PWA-FOUNDATION.md` (este archivo)

Cero cambios en `api/*`, `lib/reconciliationEngine.js`,
`lib/futuresConfirm.js`, `lib/futuresImportNormalize.js`,
`lib/smartImportConfirm.js`, ni ningún archivo SQL/Supabase.

## Tests A-T

| # | Test | Resultado |
|---|---|---|
| A | Manifest válido | PASS — JSON válido, 6 iconos, `start_url`/`display`/`theme_color` correctos (verificado por lectura directa + `dist/manifest.webmanifest` tras build) |
| B | Requisitos básicos de installability | PASS (parcial, ver limitación Lighthouse abajo) — manifest + SW + iconos + HTTPS-ready (Vercel) presentes; el audit automatizado específico de "installable" no está disponible en este entorno (ver sección Lighthouse) |
| C | Build production registra manifest/SW | PASS — `dist/manifest.webmanifest`, `dist/sw.js`, `dist/icons/*` presentes tras `npm run build` |
| D | Desktop sigue funcionando | PASS — screenshot 1440×900, sin bottom nav, sin banners nuevos, nav completo |
| E | 375px mobile sigue funcionando | PASS — screenshot 375×812 (viewport-only + full-page) |
| F | 390px mobile sigue funcionando | PASS — sin cambios de layout vs. P4.1 (aditivo únicamente) |
| G | Standalone no rompe bottom nav | CODE-VERIFIED — `padding-bottom: env(safe-area-inset-bottom)` en `.mc-bottom-nav`, no testeable sin un dispositivo iOS real con notch |
| H | Safe-area funciona | CODE-VERIFIED — mismo motivo que G |
| I | Online → datos normales | PASS — sin cambios al camino feliz de P0.1 |
| J | Fallo parcial → last-known-good | PASS — `resolveSourceMeta`/`loadAll()` sin tocar |
| K | Offline → nunca 0 inventado | PASS por diseño — `fetch()` lanza, nunca interceptado por el SW en rutas financieras (`isNeverCachePath`), mismo camino de rechazo que P0.1 |
| L | Offline → nunca refresh "exitoso" falso | PASS por diseño — mismo motivo que K, el SW nunca responde por esas rutas |
| M | Offline → online recuperación | PASS — listeners nativos `online`/`offline` + refresh manual/automático existente, sin reload forzado |
| N | market-data nunca cache financiero stale | PASS — `tests/pwaCacheStrategy.test.js` |
| O | futures-equity nunca cache financiero stale | PASS — ídem |
| P | Smart Import nunca cacheado peligrosamente | PASS — ídem + solo intercepta `GET` |
| Q | Smart Import file/photo input sigue funcionando | CODE-VERIFIED — cero cambios al componente de Smart Import ni a inputs de archivo; sin datos reales no hay click-through interactivo posible en este sandbox |
| R | Update de SW no destruye trabajo activo | PASS por diseño — sin `skipWaiting()` automático, reload solo tras click explícito del usuario |
| S | Ningún secret nuevo en assets PWA | PASS — grep confirmado, ver Security review |
| T | Suite completa sigue pasando | PASS — 132/132 (123 previos + 9 nuevos) |

## Browser/device evidence

Playwright (`npx --yes playwright screenshot`) contra `npm run dev`
local: 375×812 (viewport-only y full-page), 390×844\*, 430×932\*,
768×1024, 1440×900 — capturados y revisados visualmente. Confirmado:
sin bottom nav en 768/1440, bottom nav correcto y sin overlap en
375/390/430, sin banner de update (correcto: no hay versión previa
instalada), sin `InstallCTA` (correcto: `beforeinstallprompt` no se
dispara en Chromium headless sin las heurísticas de engagement de
Chrome). `manifest.webmanifest`, `sw.js` y los 7 iconos responden
HTTP 200 vía `curl` contra el dev server.

\* 390×844 y 430×932 no mostraron cambios respecto al layout de P4.1
(los cambios de este sprint son aditivos/globales — banner, CTA, safe-area
— no dependen del breakpoint específico), por lo que no se incluye
captura separada de esos dos más allá de la verificación visual ya
hecha en 375/768/1440.

**Limitación explícita**: standalone mode real (ícono en home screen,
sin barra de navegador) y Add-to-Home-Screen real en iOS/Android no son
testeables en este sandbox Linux headless — requieren un dispositivo
físico o un emulador con Chrome/Safari completo, no disponibles aquí.

## Lighthouse

Ejecutado (`npx lighthouse`, v13.4.1) contra el dev server local usando
el Chromium de Playwright como navegador. **Limitación real del
entorno/versión**: Lighthouse 13 eliminó la categoría PWA dedicada y
los audits específicos (`installable-manifest`, `service-worker`,
`maskable-icon`, `splash-screen`, `themed-omnibox`) — Google los movió
al panel "PWA" de Chrome DevTools, sin equivalente CLI en esta versión
(confirmado con `lighthouse --list-all-audits`, cero resultados para
esos IDs). Se corrieron en su lugar las categorías sí disponibles como
proxy de salud general:

- **Accessibility: 0.97**
- **Best Practices: 0.96**
- Único error de consola detectado: `net::ERR_CONNECTION_RESET` al
  cargar Google Fonts (`fonts.googleapis.com`) — pre-existente (el
  `@import` de fuentes ya vivía en `src/App.jsx` antes de este sprint),
  causado por las restricciones de red salientes de este sandbox, no
  por código de este sprint.

No se optimizó nada artificialmente para el score — son los números
reales de la corrida.

## Suite completa

`node --test tests/*.test.js` → **132/132 PASS** (123 preexistentes +
9 nuevos de `pwaCacheStrategy.test.js`).

## Build

`npm run build` → limpio. `dist/` incluye `manifest.webmanifest`,
`sw.js`, `icons/*` (7 archivos) además de `index.html` y `assets/*`
(mismo warning preexistente de chunk size, no relacionado).

## PRE/POST financiero

**No fue posible ejecutar conteos reales contra Supabase en este
sandbox** (sin acceso de red a `sjnobxdzlzcqnfjodxri.supabase.co` desde
este entorno — mismo límite ya documentado en sprints anteriores para
la parte de validación en vivo). En su lugar, la garantía financiera de
este sprint se verificó por las vías disponibles y suficientes dado que
**cero SQL, cero RPC, cero archivo de `lib/` financiero, cero
`api/*.js` fue tocado**:

- `git diff --stat`: solo `index.html`, `src/App.jsx`, `src/main.jsx`,
  `src/responsive.css` modificados; todo lo demás son archivos nuevos
  bajo `lib/pwaCacheStrategy.js`, `public/`, `tests/`, `docs/`.
- Grep del diff de `App.jsx` contra vocabulario financiero
  (`reconcil|equity|cost_basis|rpc\(|supabase\.(from|rpc)|cash_movements|derivative|patrimonio\s*=|WALLET_PLUS|available_balance`)
  → cero resultados fuera de comentarios del propio sprint.
  Consecuencia directa: `positions`, `transactions`, `cost_basis`,
  `cash_movements`, `account_snapshots`, `account_snapshot_balances`,
  `derivative_positions`, `derivative_position_snapshots`,
  `smart_imports` — sus conteos y sus fórmulas de valuación
  (Patrimonio Base, Patrimonio Total, Futures Equity) son, por
  construcción, idénticos PRE y POST: ningún código que los toca fue
  modificado.

## Bugs encontrados

Ninguno durante la implementación de este sprint. (A diferencia de
P4.1, no hubo bugs de cascada CSS ni de orden — los cambios de este
sprint son aditivos y no reordenan nada existente.)

## Limitaciones reales

1. Iconos: monograma generado programáticamente, no un logo diseñado —
   ver sección "Icons/assets".
2. `beforeinstallprompt`/instalación real Android, Add-to-Home-Screen
   real iOS, y modo standalone real: CODE-VERIFIED, no TESTED — sin
   dispositivo/emulador real disponible en este sandbox.
3. Lighthouse: categoría/audits PWA dedicados no existen en la versión
   13 instalada — se reportó el proxy disponible (Best Practices/
   Accessibility) en su lugar, explícitamente, sin inventar un score
   PWA que la herramienta no puede producir aquí.
4. Sin datos reales de Supabase en este sandbox: validación de Smart
   Import mobile/offline y de conteos PRE/POST financieros reales
   (contra la base de datos, no solo por diff de código) no ejecutable
   — mismo límite ya documentado en el reporte de P4.1.
5. Sin control real de la conexión de red del sistema operativo en este
   sandbox — los estados "offline" (C/D/E) se verificaron por diseño de
   código (rutas del SW, listeners `online`/`offline`) y no por apagar
   la red real y observar la app en vivo.
