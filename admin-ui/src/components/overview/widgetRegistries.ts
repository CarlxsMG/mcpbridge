// Overview dashboard — DATA layer of the widget system (split out of the former
// monolithic widgetCatalog.ts; re-exported unchanged via that barrel).
//
// This module holds the declarative model + the pure mapping registries: every
// registry entry is a PURE function `(stores: DashboardStores) => renderable |
// null`. No network, no Vue, so the whole catalog stays unit-testable without
// mounting anything. The derived catalog/layout LOGIC (presets, instance
// builders, seeded layout, lookup-driven helpers) lives in
// `widgetCatalogLogic.ts`, which imports from here (one-directional — this
// module must never import from the logic module, to avoid a load-order cycle).
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

/** True if the source's numbers depend on the global time window (`from=`). */
export const WINDOWED_SOURCES: ReadonlySet<DashboardSourceId> = new Set<DashboardSourceId>([
  "usageSummary",
  "usageTimeseries",
  "topTools",
  "byKey",
]);
