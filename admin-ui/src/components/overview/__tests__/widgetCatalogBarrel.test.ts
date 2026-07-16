// Regression guard for FINDING #37: widgetCatalog.ts was split into
// `widgetRegistries.ts` (data) + `widgetCatalogLogic.ts` (logic), with
// widgetCatalog.ts kept as a thin barrel. These tests lock in that the barrel
// still re-exports EVERY previously-public symbol, and that the two split
// modules load in a cycle-free order (a bad split would crash at import when a
// lookup map or CATALOG_PRESETS reads a not-yet-initialized registry).

import { describe, expect, it } from "vitest";
import * as catalog from "../widgetCatalog";
// Type-only re-exports can't be probed at runtime; importing them here fails to
// compile (isolatedModules) if the barrel ever stops re-exporting a type.
import type {
  DashboardStores,
  DashboardSourceId,
  WidgetViz,
  WidgetGroup,
  WidgetTone,
  WidgetOptions,
  WidgetInstance,
  WidgetIconId,
  Segment,
  BarRow,
  CellTone,
  FeedCell,
  FeedResult,
  StatResult,
  TimeseriesResult,
  StatMetricDef,
  DonutBreakdownDef,
  BarsRankingDef,
  ListFeedDef,
  TimeseriesSeriesDef,
  WidgetPreset,
} from "../widgetCatalog";

// Every value export the module had before the split.
const EXPECTED_VALUE_EXPORTS = [
  "emptyStores",
  "GRID_COLUMNS",
  "MAX_H",
  "WIDGET_ICONS",
  "resolveIcon",
  "cellToneColor",
  "STAT_METRICS",
  "DONUT_BREAKDOWNS",
  "BARS_RANKINGS",
  "LIST_FEEDS",
  "TIMESERIES_SERIES",
  "STAT_BY_ID",
  "DONUT_BY_ID",
  "BARS_BY_ID",
  "LIST_BY_ID",
  "SERIES_BY_ID",
  "WINDOWED_SOURCES",
  "sourceForWidget",
  "neededSources",
  "genId",
  "noteInstance",
  "CATALOG_PRESETS",
  "GROUP_LABELS",
  "GROUP_ORDER",
  "defaultLayout",
] as const;

describe("widgetCatalog barrel (FINDING #37)", () => {
  it("re-exports every previously-public value symbol", () => {
    for (const name of EXPECTED_VALUE_EXPORTS) {
      expect(catalog, `missing export: ${name}`).toHaveProperty(name);
      expect((catalog as Record<string, unknown>)[name]).toBeDefined();
    }
  });

  it("loads the data + logic modules cycle-free (registries wired before derived logic)", () => {
    // If the split reintroduced a load-order cycle, one of these derived
    // structures would be built from an undefined registry and be empty/throw.
    expect(catalog.STAT_METRICS.length).toBeGreaterThan(0);
    expect(catalog.STAT_BY_ID.size).toBe(catalog.STAT_METRICS.length);
    expect(catalog.CATALOG_PRESETS.length).toBeGreaterThan(catalog.STAT_METRICS.length);
    const layout = catalog.defaultLayout();
    expect(layout.length).toBeGreaterThan(0);
  });

  it("keeps cross-module wiring intact (logic reads data lookup maps)", () => {
    const [first] = catalog.defaultLayout();
    // sourceForWidget lives in the logic module; STAT_BY_ID in the data module.
    expect(catalog.sourceForWidget(first)).toBe("overview");
    expect(catalog.neededSources(catalog.defaultLayout()).length).toBeGreaterThan(0);
  });

  it("preserves the WINDOWED_SOURCES set exactly", () => {
    expect([...catalog.WINDOWED_SOURCES].sort()).toEqual(
      ["byKey", "topTools", "usageSummary", "usageTimeseries"].sort(),
    );
  });
});

// Compile-time only: force the barrel's type re-exports to be referenced so the
// suite fails to build if any is dropped. Never executed.
export function __typeReexportProbe(): void {
  type _Probe = [
    DashboardStores,
    DashboardSourceId,
    WidgetViz,
    WidgetGroup,
    WidgetTone,
    WidgetOptions,
    WidgetInstance,
    WidgetIconId,
    Segment,
    BarRow,
    CellTone,
    FeedCell,
    FeedResult,
    StatResult,
    TimeseriesResult,
    StatMetricDef,
    DonutBreakdownDef,
    BarsRankingDef,
    ListFeedDef,
    TimeseriesSeriesDef,
    WidgetPreset,
  ];
  void 0 as unknown as _Probe;
}
