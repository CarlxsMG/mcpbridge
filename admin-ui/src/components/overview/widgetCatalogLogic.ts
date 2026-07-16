// Overview dashboard — LOGIC layer of the widget system (split out of the former
// monolithic widgetCatalog.ts; re-exported unchanged via that barrel).
//
// Everything here is DERIVED from the pure registries in `widgetRegistries.ts`:
// source lookups for a widget, the add-widget preset catalog, per-viz instance
// builders, and the seeded default layout. This module imports from the data
// module one-directionally (the data module never imports back), so the
// registries are fully evaluated before any of the logic below runs.

import type { Component } from "vue";
import { Hash, LineChart, PieChart, BarChart3, ListChecks, StickyNote } from "lucide-vue-next";
import { tk } from "@/i18n";
import {
  resolveIcon,
  STAT_METRICS,
  DONUT_BREAKDOWNS,
  BARS_RANKINGS,
  LIST_FEEDS,
  TIMESERIES_SERIES,
  STAT_BY_ID,
  DONUT_BY_ID,
  BARS_BY_ID,
  LIST_BY_ID,
  SERIES_BY_ID,
  type DashboardSourceId,
  type WidgetInstance,
  type WidgetViz,
  type WidgetGroup,
  type StatMetricDef,
  type DonutBreakdownDef,
  type BarsRankingDef,
  type ListFeedDef,
  type TimeseriesSeriesDef,
} from "./widgetRegistries";

/* ------------------------------------------------------------------ *
 * Widget → source resolution.
 * ------------------------------------------------------------------ */

/** The bound registry entry's data source for a widget, or null (e.g. note). */
export function sourceForWidget(w: WidgetInstance): DashboardSourceId | null {
  switch (w.type) {
    case "stat":
      return STAT_BY_ID.get(w.options.metric ?? "")?.source ?? null;
    case "donut":
      return DONUT_BY_ID.get(w.options.breakdown ?? "")?.source ?? null;
    case "bars":
      return BARS_BY_ID.get(w.options.ranking ?? "")?.source ?? null;
    case "list":
      return LIST_BY_ID.get(w.options.feed ?? "")?.source ?? null;
    case "timeseries":
      return SERIES_BY_ID.get(w.options.series ?? "")?.source ?? null;
    case "note":
      return null;
  }
}

/** All distinct sources the current board needs — drives `useDashboardData`. */
export function neededSources(widgets: WidgetInstance[]): DashboardSourceId[] {
  const set = new Set<DashboardSourceId>();
  for (const w of widgets) {
    const src = sourceForWidget(w);
    if (src) set.add(src);
  }
  return [...set];
}

/* ------------------------------------------------------------------ *
 * Add-widget catalog: presets grouped by domain, derived from the
 * registries above so the two never drift.
 * ------------------------------------------------------------------ */

export interface WidgetPreset {
  key: string;
  viz: WidgetViz;
  group: WidgetGroup;
  /** i18n key path (GROUP_LABELS pattern) — resolve with `t()` at render time, not raw text. */
  label: string;
  /** i18n key path (GROUP_LABELS pattern) — resolve with `t()` at render time, not raw text. */
  description: string;
  icon: Component;
  /** Builds a fresh instance (new id) for this preset. */
  create: () => WidgetInstance;
}

const DEFAULT_SIZE: Record<WidgetViz, { w: number; h: number }> = {
  stat: { w: 3, h: 1 },
  timeseries: { w: 8, h: 2 },
  donut: { w: 4, h: 2 },
  bars: { w: 6, h: 2 },
  list: { w: 6, h: 2 },
  note: { w: 4, h: 1 },
};

let idSeq = 0;
export function genId(): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid) return uuid;
  // Fallback for environments without crypto.randomUUID (older jsdom, etc.).
  idSeq += 1;
  return `w-${idSeq}-${Math.floor(Math.random() * 1e9).toString(36)}`;
}

// `def.label` is an i18n KEY PATH (see the GROUP_LABELS precedent above), not
// display text — these instance builders resolve it to real text via `tk()`
// *once*, at creation time, so the persisted `options.title` is a normal
// editable string (shown as-is in WidgetConfigDialog's title input and in
// each widget's card header) rather than a raw key path. Like any
// user-editable title, it does not retroactively re-translate on a later
// locale switch — same behavior as a custom title the user typed themselves.
function statInstance(def: StatMetricDef, id = genId()): WidgetInstance {
  return {
    id,
    type: "stat",
    ...DEFAULT_SIZE.stat,
    options: {
      title: tk(def.label),
      metric: def.id,
      icon: def.icon,
      unit: def.unit,
      tone: def.tone ?? "default",
      thresholds: def.thresholds,
    },
  };
}
function donutInstance(def: DonutBreakdownDef, id = genId()): WidgetInstance {
  return { id, type: "donut", ...DEFAULT_SIZE.donut, options: { title: tk(def.label), breakdown: def.id } };
}
function barsInstance(def: BarsRankingDef, id = genId()): WidgetInstance {
  return { id, type: "bars", ...DEFAULT_SIZE.bars, options: { title: tk(def.label), ranking: def.id } };
}
function listInstance(def: ListFeedDef, id = genId()): WidgetInstance {
  return { id, type: "list", ...DEFAULT_SIZE.list, options: { title: tk(def.label), feed: def.id } };
}
function seriesInstance(def: TimeseriesSeriesDef, id = genId()): WidgetInstance {
  return { id, type: "timeseries", ...DEFAULT_SIZE.timeseries, options: { title: tk(def.label), series: def.id } };
}
export function noteInstance(id = genId()): WidgetInstance {
  return {
    id,
    type: "note",
    ...DEFAULT_SIZE.note,
    options: {
      title: tk("components.overview.widgets.note_default_title"),
      text: tk("components.overview.widgets.note_default_text"),
    },
  };
}

const VIZ_ICON: Record<WidgetViz, Component> = {
  stat: Hash,
  timeseries: LineChart,
  donut: PieChart,
  bars: BarChart3,
  list: ListChecks,
  note: StickyNote,
};

// Curated presets (one per registry entry) + a "custom" group whose entries
// create a blank-ish widget and open the config dialog as a builder.
//
// `label`/`description` are i18n KEY PATHS here too (same GROUP_LABELS
// precedent) — AddWidgetDialog.vue resolves them via `t()` at render time, so
// this module-level array (evaluated once at import) never bakes in a locale.
export const CATALOG_PRESETS: WidgetPreset[] = [
  ...STAT_METRICS.map<WidgetPreset>((d) => ({
    key: `stat:${d.id}`,
    viz: "stat",
    group: d.group,
    label: d.label,
    description: "components.overview.widgets.descriptions.stat",
    icon: resolveIcon(d.icon),
    create: () => statInstance(d),
  })),
  ...TIMESERIES_SERIES.map<WidgetPreset>((d) => ({
    key: `ts:${d.id}`,
    viz: "timeseries",
    group: d.group,
    label: d.label,
    description: "components.overview.widgets.descriptions.timeseries",
    icon: VIZ_ICON.timeseries,
    create: () => seriesInstance(d),
  })),
  ...DONUT_BREAKDOWNS.map<WidgetPreset>((d) => ({
    key: `donut:${d.id}`,
    viz: "donut",
    group: d.group,
    label: d.label,
    description: "components.overview.widgets.descriptions.donut",
    icon: VIZ_ICON.donut,
    create: () => donutInstance(d),
  })),
  ...BARS_RANKINGS.map<WidgetPreset>((d) => ({
    key: `bars:${d.id}`,
    viz: "bars",
    group: d.group,
    label: d.label,
    description: "components.overview.widgets.descriptions.bars",
    icon: VIZ_ICON.bars,
    create: () => barsInstance(d),
  })),
  ...LIST_FEEDS.map<WidgetPreset>((d) => ({
    key: `list:${d.id}`,
    viz: "list",
    group: d.group,
    label: d.label,
    description: "components.overview.widgets.descriptions.list",
    icon: VIZ_ICON.list,
    create: () => listInstance(d),
  })),
  {
    key: "note",
    viz: "note",
    group: "custom",
    label: "components.overview.widgets.note_preset_label",
    description: "components.overview.widgets.descriptions.note",
    icon: VIZ_ICON.note,
    create: () => noteInstance(),
  },
];

// Values are i18n key paths, NOT translated strings — the consuming
// components pass them straight to t(). Previously this was a Record
// of plain English ("Overview", "Usage", ...), which looked like a
// translation lookup but was actually a raw key match — the user saw
// the literal word instead of the localized string. See
// components.overview.widget_groups.* in en.json / es.json.
export const GROUP_LABELS: Record<WidgetGroup, string> = {
  overview: "components.overview.widget_groups.overview",
  usage: "components.overview.widget_groups.usage",
  health: "components.overview.widget_groups.health",
  access: "components.overview.widget_groups.access",
  activity: "components.overview.widget_groups.activity",
  custom: "components.overview.widget_groups.custom",
};

export const GROUP_ORDER: WidgetGroup[] = ["overview", "usage", "health", "access", "activity", "custom"];

/* ------------------------------------------------------------------ *
 * The seeded default layout — dense and useful out of the box, using
 * the richest demo-backed sources. Fixed ids so reset is deterministic.
 * ------------------------------------------------------------------ */

export function defaultLayout(): WidgetInstance[] {
  return [
    statInstance(STAT_BY_ID.get("clients.live")!, "seed-clients-live"),
    statInstance(STAT_BY_ID.get("tools.total")!, "seed-tools-total"),
    statInstance(STAT_BY_ID.get("breakers.open")!, "seed-breakers-open"),
    statInstance(STAT_BY_ID.get("approvals.pending")!, "seed-approvals-pending"),
    seriesInstance(SERIES_BY_ID.get("calls.errors")!, "seed-calls-errors"),
    donutInstance(DONUT_BY_ID.get("clients.health")!, "seed-server-health"),
    barsInstance(BARS_BY_ID.get("topTools")!, "seed-top-tools"),
    listInstance(LIST_BY_ID.get("audit.recent")!, "seed-recent-activity"),
  ];
}
