// Single source of truth for the Overview dashboard's widget system.
//
// This is a thin BARREL. To keep the module focused and small, the former
// 900+ LOC monolith was split into two cohesive siblings — the barrel
// re-exports their entire public surface unchanged, so every importer that
// reads from `@/components/overview/widgetCatalog` (or `./widgetCatalog`)
// keeps working with no change:
//
//   1. `widgetRegistries.ts` — the DATA layer: the persisted widget model,
//      icons, render types, and the five PURE mapping registries
//      (STAT_METRICS / DONUT_BREAKDOWNS / BARS_RANKINGS / LIST_FEEDS /
//      TIMESERIES_SERIES) + their id→def lookup maps. No network, no Vue, so
//      the whole catalog stays unit-testable without mounting anything.
//   2. `widgetCatalogLogic.ts` — the LOGIC layer DERIVED from those
//      registries: source resolution (sourceForWidget/neededSources), the
//      add-widget preset catalog (CATALOG_PRESETS), instance builders,
//      genId, and the seeded defaultLayout.
//
// The design still separates FETCHING (`useDashboardData.ts`, which knows how
// to GET each `/admin-api/*` source and caches by `DashboardSourceId`) from
// MAPPING (the registries here).
//
// A "widget" is a `WidgetInstance` (persisted in localStorage): a viz kind
// (`stat`/`timeseries`/`donut`/`bars`/`list`/`note`), a grid span (`w`/`h`), and
// an `options` bundle that binds it to one registry entry. Builtin widgets and
// user-built "custom" widgets are the SAME shape — a custom widget is just an
// options bundle the user authored via the config dialog instead of a preset.
//
// INVARIANT (enforced by widgetCatalog.test.ts): every registry entry's
// `source` must be one the demo mock (`admin-ui/src/demo/demo.ts`) serves, so
// no widget renders empty in the public GitHub Pages demo.

export * from "./widgetRegistries";
export * from "./widgetCatalogLogic";
