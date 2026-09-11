# Sprint P4.1 — Responsive Mobile Foundation

> Documento de registro. Hace usable/ordenado/profesional Moni Capital en
> mobile SIN rediseño visual completo y SIN PWA/app nativa todavía — eso
> queda para un sprint P4.2 posterior. Solo frontend/layout/estructura
> responsive: cero cambios a fórmulas financieras, RPCs, esquema Supabase,
> RLS, grants, lógica de AI, News Intelligence o Conviction Engine.

## Problema

La app usaba estilos inline casi exclusivamente, cero archivos CSS, cero
`@media` queries. En mobile: navegación desktop apretada, tabla de
posiciones desbordando horizontalmente, botones de confirmación
pequeños/difíciles de tocar, y el orden de la vista "resumen" no seguía
una jerarquía mobile-first (Patrimonio Total → cambio/PnL → freshness →
qué cambió → oportunidades → portafolio → cuentas).

## Diseño implementado

- **`src/responsive.css`** (nuevo, único archivo CSS del proyecto): un
  solo breakpoint (767px), variables CSS que replican las constantes de
  color de `src/App.jsx` (nunca duplicadas con valores distintos),
  utilidades de visibilidad (`.mc-mobile-only`/`.mc-desktop-only`),
  bottom nav fijo, clases de reorden (`.mc-mobile-order-1..7`) para
  reflow sin duplicar el DOM, `.mc-card-list`/`.mc-card-row` para la
  alternativa mobile a `<table>`, y `.mc-touch-target` (min 44px).
- **`src/main.jsx`**: un solo `import './responsive.css'` agregado.
- **`src/App.jsx`**:
  - `useIsMobile()` — hook basado en `window.matchMedia`, controla
    render condicional (tabla vs. cards), nunca fetch de datos distinto.
  - `MobileBottomNav` — 5 destinos (Home/Portfolio/Smart Import/Moni
    AI/Más), navegación desktop (`ALL_TABS`, 15 tabs) queda intacta y
    oculta en mobile vía `mc-desktop-only`.
  - Vista "resumen": 7 secciones envueltas en `mc-mobile-order-N` para
    reordenar solo en mobile (Patrimonio Total ya es la primera card del
    DOM; se reordenan las secciones bajo ella).
  - `RichPositionsTable`: mismo prop `rows`, mismo dato — en mobile
    renderiza `.mc-card-list` de cards táctiles (ticker, valor, PnL,
    allocation, precio, tap abre detalle); en desktop, la tabla original
    sin cambios. "Responsive rendering, no dos datasets."
  - Ajustes menores de touch/scroll: grid de Futures con columnas más
    angostas, ticker-tape con scroll horizontal explícito en vez de
    overflow oculto, 3 botones "Confirmar" con `min-height:44px` y
    padding/tipografía más grandes.
- **Smart Import backend**: cero cambios — `api/smart-import.js`,
  `lib/smartImportConfirm.js`, `lib/futuresConfirm.js` intactos. Solo se
  ajustó legibilidad/touch en la UI de revisión ya existente.
- **PWA**: NO implementado en este sprint (explícitamente fuera de
  alcance) — la estructura (bottom nav, jerarquía mobile-first) queda
  lista para ese trabajo futuro sin refactor adicional.

## Bugs encontrados y corregidos (vía screenshots reales)

1. **Bottom nav visible en desktop (1440px)**: `.mc-bottom-nav` dependía
   de `.mc-mobile-only` para su visibilidad, pero definía su propio
   `display:flex` incondicional más abajo en el archivo — con igual
   especificidad, la regla que aparece último en el archivo gana sin
   importar el viewport. Fix: `.mc-bottom-nav` autocontenido con su
   propio `display:none` base + su propio `@media(max-width:767px)`.
2. **Panel "Riesgo" saltando al inicio en mobile (375px)**: quedó sin
   clase de orden explícita, y el default de CSS `order` es `0`, que
   ordena antes que cualquier hermano con `order` explícito (1-6). Fix:
   agregada `.mc-mobile-order-7` + envolver el panel.

Ambos verificados por re-captura de screenshot tras el fix.

## Validación de viewports

Capturado con Playwright (`npx --yes playwright screenshot`) contra
`npm run dev` local, sin datos reales de Supabase disponibles en este
entorno (la app muestra el error esperado "No se pudo cargar el
portafolio" — comportamiento de red del sandbox, no un bug de layout;
ver Sprint P0.1 para el manejo de ese caso).

| Viewport | Resultado |
|---|---|
| 375×812 | OK tras fix — bottom nav correcto, orden hero correcto, sin scroll horizontal |
| 390×844 | OK — bottom nav con "Home" activo, hero en columna única, sin overflow |
| 430×932 | OK — bottom nav correcto, KPIs en columna única, nav desktop oculto |
| 768×1024 | OK — tratado como desktop/tablet: fila de tabs completa (2 líneas), sin bottom nav |
| 1440×900 (desktop) | OK tras fix — sin bottom nav, layout desktop sin cambios |

**Limitación documentada explícitamente**: la validación de Smart Import
mobile y Futures mobile se hizo por captura estática de carga inicial +
revisión de código (los componentes `FuturesAccountSnapshotReview`,
`FuturesPositionSnapshotReview`, `mc-touch-target` en los 3 botones
Confirmar), NO por click-through interactivo automatizado, porque este
entorno no tiene datos reales de Supabase para poblar esas pantallas con
contenido, y no se escribió un script Playwright interactivo (solo
capturas de carga inicial). Revisión de código confirma que ninguna
lógica de esas pantallas fue tocada — solo tamaño/padding de botones y
las clases de layout ya descritas.

## Regresión

- `node --test tests/*.test.js`: **123/123 pass**.
- `npm run build`: build limpio (warning preexistente de chunk size,
  no relacionado a este sprint).
- `git diff --stat`: solo `src/App.jsx`, `src/main.jsx`,
  `src/responsive.css` — cero cambios en `lib/`, `api/`, migraciones o
  esquema Supabase. Revisión línea por línea del diff de `App.jsx`
  confirma que los únicos cambios cerca de código financiero son
  reindentación por el envoltorio JSX de las clases de orden — ningún
  valor, fórmula ni llamada a Supabase/RPC fue modificado.

## NO TOCAR — verificado intacto

Fórmulas financieras, Patrimonio Base, Patrimonio Total, Futures Equity,
`cash_movements`, `positions`, `transactions`, `cost_basis`, Smart Import
backend, RPCs, esquema Supabase, RLS, grants, lógica de AI, News
Intelligence, Conviction Engine, BTC #65/#66.
