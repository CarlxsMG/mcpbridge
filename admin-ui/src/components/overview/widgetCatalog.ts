// Single source of truth for the Overview dashboard's widget system.
//
// The design separates two concerns cleanly:
//   1. FETCHING lives in `useDashboardData.ts` — it knows how to GET each
//      `/admin-api/*` source and caches the result keyed by `DashboardSourceId`.
//   2. MAPPING lives here — every registry entry is a PURE function
//      `(stores: DashboardStores) => renderable | null`. No network, no Vue, so
//      the whole catalog is unit-testable without mounting anything.
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

import type { Component } from "vue";
import {
  Server,
  Wrench,
  GitBranch,
  ShieldCheck,
  Activity,
  AlertTriangle,
  Percent,
  Timer,
  Gauge,
  Users2,
  KeyRound,
  ClipboardCheck,
  Cable,
  Radar,
  ScrollText,
  ArrowLeftRight,
  HeartPulse,
  LineChart,
  PieChart,
  BarChart3,
  ListChecks,
  StickyNote,
  Hash,
} from "lucide-vue-next";
import { pct } from "@/utils/format";
import { tk } from "@/i18n";
import type {
  OverviewStats,
  UsageSummary,
  UsageTimeseries,
  TopToolRow,
  UsageByKeyRow,
  ClientSummary,
  MonitorRecord,
  ApprovalRecord,
  TrafficRecord,
  AuditLogEntry,
  ConsumerWithUsage,
  WsProxyTarget,
} from "@/types/api";

/* ------------------------------------------------------------------ *
 * Data stores — the shape `useDashboardData` fills, one key per source.
 * ------------------------------------------------------------------ */

export interface DashboardStores {
  overview: OverviewStats | null;
  usageSummary: UsageSummary | null;
  usageTimeseries: UsageTimeseries | null;
  topTools: TopToolRow[];
  byKey: UsageByKeyRow[];
  clients: ClientSummary[];
  monitors: MonitorRecord[];
  approvals: ApprovalRecord[];
  traffic: TrafficRecord[];
  auditLog: AuditLogEntry[];
  consumers: ConsumerWithUsage[];
  wsProxyTargets: WsProxyTarget[];
}

export type DashboardSourceId = keyof DashboardStores;

export function emptyStores(): DashboardStores {
  return {
    overview: null,
    usageSummary: null,
    usageTimeseries: null,
    topTools: [],
    byKey: [],
    clients: [],
    monitors: [],
    approvals: [],
    traffic: [],
    auditLog: [],
    consumers: [],
    wsProxyTargets: [],
  };
}

/* ------------------------------------------------------------------ *
 * Widget instance model (persisted).
 * ------------------------------------------------------------------ */

export type WidgetViz = "stat" | "timeseries" | "donut" | "bars" | "list" | "note";
export type WidgetGroup = "overview" | "usage" | "health" | "access" | "activity" | "custom";
export type WidgetTone = "auto" | "default" | "ok" | "warning" | "danger";

export interface WidgetOptions {
  title: string;
  /** Registry entry id for the chosen binding (per viz). Unused by `note`. */
  metric?: string; // stat
  breakdown?: string; // donut
  ranking?: string; // bars
  feed?: string; // list
  series?: string; // timeseries
  /** stat display */
  unit?: string;
  icon?: WidgetIconId;
  tone?: WidgetTone;
  thresholds?: { warn?: number; danger?: number };
  /** note */
  text?: string;
}

export interface WidgetInstance {
  id: string;
  type: WidgetViz;
  w: number; // column span, 1..GRID_COLUMNS
  h: number; // row span, 1..MAX_H
  options: WidgetOptions;
}

export const GRID_COLUMNS = 12;
export const MAX_H = 4;

/* ------------------------------------------------------------------ *
 * Icons — options store a serializable string id; renderers resolve it.
 * ------------------------------------------------------------------ */

export const WIDGET_ICONS = {
  server: Server,
  wrench: Wrench,
  breaker: GitBranch,
  shield: ShieldCheck,
  activity: Activity,
  alert: AlertTriangle,
  percent: Percent,
  timer: Timer,
  gauge: Gauge,
  users: Users2,
  key: KeyRound,
  approvals: ClipboardCheck,
  cable: Cable,
  radar: Radar,
  audit: ScrollText,
  traffic: ArrowLeftRight,
  health: HeartPulse,
  hash: Hash,
} satisfies Record<string, Component>;

export type WidgetIconId = keyof typeof WIDGET_ICONS;

export function resolveIcon(id: WidgetIconId | undefined): Component {
  return (id && WIDGET_ICONS[id]) || Hash;
}

/* ------------------------------------------------------------------ *
 * Shared render types + tone helper.
 * ------------------------------------------------------------------ */

export interface Segment {
  label: string;
  value: number;
  color: string;
}
export interface BarRow {
  label: string;
  value: number;
  hint?: string;
  danger?: boolean;
}
export type CellTone = "ok" | "warn" | "bad" | "neutral";
export interface FeedCell {
  text: string;
  mono?: boolean;
  tone?: CellTone;
}
export interface FeedResult {
  head: string[];
  rows: { key: string; cells: FeedCell[] }[];
  empty: string;
}
export interface StatResult {
  value: number;
  display: string;
  detail?: string;
  segments?: Segment[];
}
export interface TimeseriesResult {
  points: { t: number; v: number }[];
  secondaryPoints?: { t: number; v: number }[];
  primaryLabel: string;
  secondaryLabel?: string;
  bucketMs: number;
  valueFormat?: (n: number) => string;
}

export function cellToneColor(tone: CellTone | undefined): string {
  switch (tone) {
    case "ok":
      return "var(--ok)";
    case "warn":
      return "var(--canary)";
    case "bad":
      return "var(--breach)";
    default:
      return "var(--text-secondary)";
  }
}

// Semantic colors reused across donut breakdowns (kept in sync with the tokens
// used on the standalone Overview/Monitors/Approvals pages).
const C_OK = "var(--ok)";
const C_WARN = "var(--canary)";
const C_BAD = "var(--breach)";
const C_MUTED = "var(--text-muted)";
const C_NEUTRAL = "var(--border-strong)";

/* ------------------------------------------------------------------ *
 * STAT metrics — a single big number (+ optional detail / segments).
 * ------------------------------------------------------------------ */

export interface StatMetricDef {
  id: string;
  label: string;
  group: WidgetGroup;
  source: DashboardSourceId;
  icon: WidgetIconId;
  unit?: string;
  tone?: WidgetTone;
  thresholds?: { warn?: number; danger?: number };
  get: (s: DashboardStores) => StatResult | null;
}

function healthSegments(o: OverviewStats): Segment[] {
  // Reuses `badges.status_*` — same "Healthy"/"Degraded"/"Unreachable" concept
  // already translated for the server-status badge elsewhere in the UI.
  return [
    { label: tk("badges.status_healthy"), value: o.clients.healthy, color: C_OK },
    { label: tk("badges.status_degraded"), value: o.clients.degraded, color: C_WARN },
    { label: tk("badges.status_unreachable"), value: o.clients.unreachable, color: C_BAD },
  ].filter((s) => s.value > 0);
}

export const STAT_METRICS: StatMetricDef[] = [
  {
    id: "clients.live",
    label: "components.overview.widgets.stat.clients_live.label",
    group: "overview",
    source: "overview",
    icon: "server",
    get: (s) =>
      s.overview && {
        value: s.overview.clients.live,
        display: String(s.overview.clients.live),
        detail: tk("components.overview.widgets.stat.clients_live.detail", { count: s.overview.clients.disabled }),
        segments: healthSegments(s.overview),
      },
  },
  {
    id: "tools.total",
    label: "components.overview.widgets.stat.tools_total.label",
    group: "overview",
    source: "overview",
    icon: "wrench",
    get: (s) =>
      s.overview && {
        value: s.overview.tools.total,
        display: String(s.overview.tools.total),
        detail: tk("components.overview.widgets.stat.tools_total.detail", { count: s.overview.tools.disabled }),
      },
  },
  {
    id: "breakers.open",
    label: "components.overview.widgets.stat.breakers_open.label",
    group: "overview",
    source: "overview",
    icon: "breaker",
    tone: "auto",
    thresholds: { danger: 1 },
    get: (s) =>
      s.overview && {
        value: s.overview.circuit_breakers.open,
        display: String(s.overview.circuit_breakers.open),
        detail: tk("components.overview.widgets.stat.breakers_open.detail", {
          count: s.overview.circuit_breakers.half_open,
        }),
      },
  },
  {
    id: "admins",
    label: "components.overview.widgets.stat.admins.label",
    group: "overview",
    source: "overview",
    icon: "shield",
    get: (s) => s.overview && { value: s.overview.admin_users, display: String(s.overview.admin_users) },
  },
  {
    id: "usage.calls",
    label: "components.overview.widgets.stat.usage_calls.label",
    group: "usage",
    source: "usageSummary",
    icon: "activity",
    get: (s) => s.usageSummary && { value: s.usageSummary.calls, display: s.usageSummary.calls.toLocaleString() },
  },
  {
    id: "usage.errors",
    label: "components.overview.widgets.stat.usage_errors.label",
    group: "usage",
    source: "usageSummary",
    icon: "alert",
    tone: "auto",
    thresholds: { warn: 1 },
    get: (s) => s.usageSummary && { value: s.usageSummary.errors, display: s.usageSummary.errors.toLocaleString() },
  },
  {
    id: "usage.errorRate",
    label: "components.overview.widgets.stat.usage_error_rate.label",
    group: "usage",
    source: "usageSummary",
    icon: "percent",
    tone: "auto",
    thresholds: { warn: 0.05, danger: 0.1 },
    get: (s) => s.usageSummary && { value: s.usageSummary.errorRate, display: pct(s.usageSummary.errorRate) },
  },
  {
    id: "usage.avgMs",
    label: "components.overview.widgets.stat.usage_avg_ms.label",
    group: "usage",
    source: "usageSummary",
    icon: "timer",
    get: (s) => s.usageSummary && { value: s.usageSummary.avgMs, display: `${s.usageSummary.avgMs}ms` },
  },
  {
    id: "usage.maxMs",
    label: "components.overview.widgets.stat.usage_max_ms.label",
    group: "usage",
    source: "usageSummary",
    icon: "gauge",
    get: (s) => s.usageSummary && { value: s.usageSummary.maxMs, display: `${s.usageSummary.maxMs}ms` },
  },
  {
    id: "usage.tools",
    label: "components.overview.widgets.stat.usage_tools.label",
    group: "usage",
    source: "usageSummary",
    icon: "wrench",
    get: (s) => s.usageSummary && { value: s.usageSummary.tools, display: String(s.usageSummary.tools) },
  },
  {
    id: "usage.keys",
    label: "components.overview.widgets.stat.usage_keys.label",
    group: "usage",
    source: "usageSummary",
    icon: "key",
    get: (s) => s.usageSummary && { value: s.usageSummary.keys, display: String(s.usageSummary.keys) },
  },
  {
    id: "approvals.pending",
    label: "components.overview.widgets.stat.approvals_pending.label",
    group: "access",
    source: "approvals",
    icon: "approvals",
    tone: "auto",
    thresholds: { warn: 1 },
    get: (s) => {
      const n = s.approvals.filter((a) => a.status === "pending").length;
      return { value: n, display: String(n) };
    },
  },
  {
    id: "ws.connections",
    label: "components.overview.widgets.stat.ws_connections.label",
    group: "access",
    source: "wsProxyTargets",
    icon: "cable",
    get: (s) => {
      const n = s.wsProxyTargets.reduce((sum, t) => sum + (t.activeConnections ?? 0), 0);
      return {
        value: n,
        display: String(n),
        detail: tk("components.overview.widgets.stat.ws_connections.detail", { count: s.wsProxyTargets.length }),
      };
    },
  },
];

/* ------------------------------------------------------------------ *
 * DONUT breakdowns — a proportion ring from real counts.
 * ------------------------------------------------------------------ */

export interface DonutBreakdownDef {
  id: string;
  label: string;
  group: WidgetGroup;
  source: DashboardSourceId;
  get: (s: DashboardStores) => Segment[];
}

type MonitorState = "healthy" | "drift" | "failing" | "never" | "disabled";
// Status and drift are independent axes (a monitor can be ok AND drifted), so
// rank into one bucket: failing > drift > never > healthy. Mirrors MonitorsPage.
function monitorState(m: MonitorRecord): MonitorState {
  if (!m.enabled) return "disabled";
  if (m.lastStatus === "fail") return "failing";
  if (m.lastStatus === null) return "never";
  return m.driftDetected ? "drift" : "healthy";
}

export const DONUT_BREAKDOWNS: DonutBreakdownDef[] = [
  {
    id: "clients.health",
    label: "components.overview.widgets.donut.clients_health.label",
    group: "health",
    source: "overview",
    get: (s) => (s.overview ? healthSegments(s.overview) : []),
  },
  {
    id: "breakers",
    label: "components.overview.widgets.donut.breakers.label",
    group: "health",
    source: "overview",
    // Reuses `badges.status_*` — same "Closed"/"Half-open"/"Open" concept
    // already translated for the circuit-breaker badge elsewhere in the UI.
    get: (s) =>
      s.overview
        ? [
            { label: tk("badges.status_closed"), value: s.overview.circuit_breakers.closed, color: C_OK },
            { label: tk("badges.status_half_open"), value: s.overview.circuit_breakers.half_open, color: C_WARN },
            { label: tk("badges.status_open"), value: s.overview.circuit_breakers.open, color: C_BAD },
          ].filter((x) => x.value > 0)
        : [],
  },
  {
    id: "monitors.status",
    label: "components.overview.widgets.donut.monitors_status.label",
    group: "health",
    source: "monitors",
    // Reuses `pages.monitors.state.*` — same state labels the Monitors page itself uses.
    get: (s) => {
      const counts: Record<MonitorState, number> = { healthy: 0, drift: 0, failing: 0, never: 0, disabled: 0 };
      for (const m of s.monitors) counts[monitorState(m)]++;
      return [
        { label: tk("pages.monitors.state.healthy"), value: counts.healthy, color: C_OK },
        { label: tk("pages.monitors.state.drift"), value: counts.drift, color: C_WARN },
        { label: tk("pages.monitors.state.failing"), value: counts.failing, color: C_BAD },
        { label: tk("pages.monitors.state.never"), value: counts.never, color: C_MUTED },
        { label: tk("pages.monitors.state.disabled"), value: counts.disabled, color: C_NEUTRAL },
      ].filter((x) => x.value > 0);
    },
  },
  {
    id: "approvals.status",
    label: "components.overview.widgets.donut.approvals_status.label",
    group: "access",
    source: "approvals",
    // Reuses `pages.approvals.status.*` — same status labels the Approvals page itself uses.
    get: (s) => {
      const by = (st: string) => s.approvals.filter((a) => a.status === st).length;
      return [
        { label: tk("pages.approvals.status.pending"), value: by("pending"), color: C_WARN },
        { label: tk("pages.approvals.status.approved"), value: by("approved"), color: C_OK },
        { label: tk("pages.approvals.status.rejected"), value: by("rejected"), color: C_BAD },
      ].filter((x) => x.value > 0);
    },
  },
];

/* ------------------------------------------------------------------ *
 * BARS rankings — ranked horizontal bars (top-N by count).
 * ------------------------------------------------------------------ */

export interface BarsRankingDef {
  id: string;
  label: string;
  group: WidgetGroup;
  source: DashboardSourceId;
  get: (s: DashboardStores) => BarRow[];
}

export const BARS_RANKINGS: BarsRankingDef[] = [
  {
    id: "topTools",
    label: "components.overview.widgets.bars.top_tools.label",
    group: "usage",
    source: "topTools",
    get: (s) =>
      s.topTools.slice(0, 8).map((t) => ({
        label: `${t.client}/${t.tool}`,
        value: t.calls,
        hint: t.errors ? tk("components.overview.widgets.bars.top_tools.hint_errors", { count: t.errors }) : undefined,
        danger: t.errorRate > 0.1,
      })),
  },
  {
    id: "byKey",
    label: "components.overview.widgets.bars.by_key.label",
    group: "usage",
    source: "byKey",
    get: (s) => s.byKey.slice(0, 8).map((k) => ({ label: k.label, value: k.calls })),
  },
  {
    id: "consumers.quota",
    label: "components.overview.widgets.bars.consumers_quota.label",
    group: "access",
    source: "consumers",
    // Reuses `pages.consumers.unlimited` — same wording the Consumers page uses.
    get: (s) =>
      s.consumers.slice(0, 8).map((c) => ({
        label: c.name,
        value: c.usedThisMonth,
        hint:
          c.monthlyQuota != null
            ? tk("components.overview.widgets.bars.consumers_quota.hint_of_quota", { quota: c.monthlyQuota })
            : tk("pages.consumers.unlimited"),
        danger: c.monthlyQuota != null && c.usedThisMonth >= c.monthlyQuota,
      })),
  },
];

/* ------------------------------------------------------------------ *
 * LIST feeds — a compact recent-activity / status table.
 * ------------------------------------------------------------------ */

export interface ListFeedDef {
  id: string;
  label: string;
  group: WidgetGroup;
  source: DashboardSourceId;
  get: (s: DashboardStores) => FeedResult;
}

function relTime(ms: number | null | undefined): string {
  if (ms == null) return "—";
  const diff = Date.now() - ms;
  if (diff < 0) return tk("components.overview.widgets.relative_time.just_now");
  const m = Math.floor(diff / 60_000);
  if (m < 1) return tk("components.overview.widgets.relative_time.just_now");
  if (m < 60) return tk("components.overview.widgets.relative_time.minutes_ago", { m });
  const h = Math.floor(m / 60);
  if (h < 24) return tk("components.overview.widgets.relative_time.hours_ago", { h });
  return tk("components.overview.widgets.relative_time.days_ago", { d: Math.floor(h / 24) });
}

export const LIST_FEEDS: ListFeedDef[] = [
  {
    id: "audit.recent",
    label: "components.overview.widgets.list.audit_recent.label",
    group: "activity",
    source: "auditLog",
    get: (s) => ({
      head: [
        tk("components.overview.widgets.list.audit_recent.head_action"),
        tk("components.overview.widgets.list.audit_recent.head_target"),
        tk("components.overview.widgets.list.audit_recent.head_when"),
      ],
      empty: tk("components.overview.widgets.list.audit_recent.empty"),
      rows: s.auditLog.slice(0, 8).map((e) => ({
        key: String(e.id),
        cells: [
          { text: e.action, mono: true },
          { text: e.target || "—" },
          { text: relTime(e.createdAt), tone: "neutral" },
        ],
      })),
    }),
  },
  {
    id: "traffic.recent",
    label: "components.overview.widgets.list.traffic_recent.label",
    group: "activity",
    source: "traffic",
    // Reuses `pages.traffic.table.status_error` / `status_ok` — same wording
    // the Traffic page itself uses for the identical error/OK distinction.
    get: (s) => ({
      head: [
        tk("components.overview.widgets.list.traffic_recent.head_tool"),
        tk("components.overview.widgets.list.traffic_recent.head_status"),
        tk("components.overview.widgets.list.traffic_recent.head_duration"),
        tk("components.overview.widgets.list.traffic_recent.head_when"),
      ],
      empty: tk("components.overview.widgets.list.traffic_recent.empty"),
      rows: s.traffic.slice(0, 8).map((t) => ({
        key: String(t.id),
        cells: [
          { text: t.mcpToolName, mono: true },
          {
            text: t.isError ? tk("pages.traffic.table.status_error") : tk("pages.traffic.table.status_ok"),
            tone: t.isError ? "bad" : "ok",
          },
          { text: `${t.durationMs}ms` },
          { text: relTime(t.createdAt), tone: "neutral" },
        ],
      })),
    }),
  },
  {
    id: "approvals.pending",
    label: "components.overview.widgets.list.approvals_pending.label",
    group: "access",
    source: "approvals",
    get: (s) => {
      const pending = s.approvals.filter((a) => a.status === "pending");
      return {
        head: [
          tk("components.overview.widgets.list.approvals_pending.head_tool"),
          tk("components.overview.widgets.list.approvals_pending.head_requested"),
        ],
        empty: tk("components.overview.widgets.list.approvals_pending.empty"),
        rows: pending.slice(0, 8).map((a) => ({
          key: String(a.id),
          cells: [
            { text: `${a.clientName}/${a.toolName}`, mono: true },
            { text: relTime(a.createdAt), tone: "neutral" },
          ],
        })),
      };
    },
  },
  {
    id: "clients.unhealthy",
    label: "components.overview.widgets.list.clients_unhealthy.label",
    group: "health",
    source: "clients",
    get: (s) => {
      const bad = s.clients.filter((c) => c.status && c.status !== "healthy");
      return {
        head: [
          tk("components.overview.widgets.list.clients_unhealthy.head_server"),
          tk("components.overview.widgets.list.clients_unhealthy.head_status"),
        ],
        empty: tk("components.overview.widgets.list.clients_unhealthy.empty"),
        rows: bad.slice(0, 8).map((c) => ({
          key: c.name,
          cells: [
            { text: c.name, mono: true },
            {
              text: c.status ?? tk("components.overview.widgets.list.clients_unhealthy.unknown_status"),
              tone: c.status === "unreachable" ? "bad" : "warn",
            },
          ],
        })),
      };
    },
  },
];

/* ------------------------------------------------------------------ *
 * TIMESERIES series — a line/area over the usage timeseries buckets.
 * ------------------------------------------------------------------ */

export interface TimeseriesSeriesDef {
  id: string;
  label: string;
  group: WidgetGroup;
  source: DashboardSourceId;
  get: (s: DashboardStores) => TimeseriesResult | null;
}

export const TIMESERIES_SERIES: TimeseriesSeriesDef[] = [
  {
    id: "calls.errors",
    label: "components.overview.widgets.series.calls_errors.label",
    group: "usage",
    source: "usageTimeseries",
    get: (s) =>
      s.usageTimeseries && {
        points: s.usageTimeseries.points.map((p) => ({ t: p.t, v: p.calls })),
        secondaryPoints: s.usageTimeseries.points.map((p) => ({ t: p.t, v: p.errors })),
        primaryLabel: tk("components.overview.widgets.series.calls_errors.primary"),
        secondaryLabel: tk("components.overview.widgets.series.calls_errors.secondary"),
        bucketMs: s.usageTimeseries.bucketMs,
      },
  },
  {
    id: "latency",
    label: "components.overview.widgets.series.latency.label",
    group: "usage",
    source: "usageTimeseries",
    get: (s) =>
      s.usageTimeseries && {
        points: s.usageTimeseries.points.map((p) => ({ t: p.t, v: p.avgMs })),
        primaryLabel: tk("components.overview.widgets.series.latency.primary"),
        bucketMs: s.usageTimeseries.bucketMs,
        valueFormat: (n: number) => `${n}ms`,
      },
  },
];

/* ------------------------------------------------------------------ *
 * Registry lookup helpers (used by renderers + the data layer).
 * ------------------------------------------------------------------ */

export const STAT_BY_ID = new Map(STAT_METRICS.map((d) => [d.id, d]));
export const DONUT_BY_ID = new Map(DONUT_BREAKDOWNS.map((d) => [d.id, d]));
export const BARS_BY_ID = new Map(BARS_RANKINGS.map((d) => [d.id, d]));
export const LIST_BY_ID = new Map(LIST_FEEDS.map((d) => [d.id, d]));
export const SERIES_BY_ID = new Map(TIMESERIES_SERIES.map((d) => [d.id, d]));

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

/** True if the source's numbers depend on the global time window (`from=`). */
export const WINDOWED_SOURCES: ReadonlySet<DashboardSourceId> = new Set<DashboardSourceId>([
  "usageSummary",
  "usageTimeseries",
  "topTools",
  "byKey",
]);

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
