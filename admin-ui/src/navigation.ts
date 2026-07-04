import type { Component } from "vue";
import {
  Server,
  Boxes,
  Combine,
  KeyRound,
  ShieldCheck,
  Users2,
  LayoutDashboard,
  Activity,
  ArrowLeftRight,
  Radar,
  ClipboardCheck,
  BellRing,
  Clock,
  ScrollText,
  UserCog,
  UsersRound,
  Settings2,
  LayoutGrid,
  Cable,
  Waypoints,
  Fingerprint,
  UserCircle,
} from "lucide-vue-next";

/**
 * Single source of truth for the ~24 static, param-free pages — previously
 * hand-maintained independently in router/index.ts's routes array, App.vue's
 * sidebar markup, and CommandPalette.vue's PAGES constant, which had already
 * drifted (the /sso route existed in the router and the sidebar but was
 * missing from the command palette). The ~5 dynamic routes (server-detail,
 * tool-guard, bundle-detail, composite-detail, trace-detail) plus /, /login
 * and the not-found catch-all were never part of any of those three lists
 * either (no fixed label/icon to share), so they stay hand-written directly
 * in router/index.ts.
 *
 * `group` drives the sidebar's section headers in App.vue (Servers/Access/
 * Observability/Administration/none). CommandPalette.vue ignores it and
 * buckets every entry here under a single "Pages" group instead, to stay
 * distinct from its live-fetched "Servers"/"Bundles"/"API keys" groups.
 */
export type NavGroup = "Servers" | "Access" | "Observability" | "Administration" | null;

export interface NavEntry {
  path: string;
  name: string;
  label: string;
  hint: string;
  group: NavGroup;
  icon: Component;
  component: () => Promise<{ default: Component }>;
  meta?: { role?: "admin" };
}

export const navEntries: NavEntry[] = [
  // Servers
  {
    path: "/servers",
    name: "servers",
    label: "Servers",
    hint: "List and manage upstream servers",
    group: "Servers",
    icon: Server,
    component: () => import("./pages/DashboardPage.vue"),
  },
  {
    path: "/register-server",
    name: "register-server",
    label: "Add server",
    hint: "Register a new upstream",
    group: "Servers",
    icon: Server,
    component: () => import("./pages/RegisterServerPage.vue"),
  },
  {
    path: "/catalog",
    name: "catalog",
    label: "Catalog",
    hint: "Browse & one-click install servers",
    group: "Servers",
    icon: LayoutGrid,
    component: () => import("./pages/CatalogPage.vue"),
  },
  {
    path: "/bundles",
    name: "bundles",
    label: "Bundles",
    hint: "Cross-client tool selections",
    group: "Servers",
    icon: Boxes,
    component: () => import("./pages/BundlesPage.vue"),
  },
  {
    path: "/composites",
    name: "composites",
    label: "Composites",
    hint: "Chained tool calls",
    group: "Servers",
    icon: Combine,
    component: () => import("./pages/CompositesPage.vue"),
  },
  {
    path: "/ws-proxies",
    name: "ws-proxies",
    label: "WS proxies",
    hint: "Live WebSocket passthrough targets",
    group: "Servers",
    icon: Cable,
    component: () => import("./pages/WsProxyTargetsPage.vue"),
  },
  // Access
  {
    path: "/keys",
    name: "keys",
    label: "API keys",
    hint: "MCP client credentials",
    group: "Access",
    icon: KeyRound,
    component: () => import("./pages/KeysPage.vue"),
  },
  {
    path: "/policies",
    name: "policies",
    label: "Policies",
    hint: "Reusable rate-limit/timeout presets",
    group: "Access",
    icon: ShieldCheck,
    component: () => import("./pages/PoliciesPage.vue"),
  },
  {
    path: "/consumers",
    name: "consumers",
    label: "Consumers",
    hint: "Quota-tracked key owners",
    group: "Access",
    icon: Users2,
    component: () => import("./pages/ConsumersPage.vue"),
  },
  {
    path: "/approvals",
    name: "approvals",
    label: "Approvals",
    hint: "Human-in-the-loop approval queue",
    group: "Access",
    icon: ClipboardCheck,
    component: () => import("./pages/ApprovalsPage.vue"),
  },
  // Observability
  {
    path: "/overview",
    name: "overview",
    label: "Overview",
    hint: "Bridge instance snapshot",
    group: "Observability",
    icon: LayoutDashboard,
    component: () => import("./pages/OverviewPage.vue"),
  },
  {
    path: "/usage",
    name: "usage",
    label: "Usage",
    hint: "Call volume and latency",
    group: "Observability",
    icon: Activity,
    component: () => import("./pages/UsagePage.vue"),
  },
  {
    path: "/traffic",
    name: "traffic",
    label: "Traffic",
    hint: "Captured request/response calls",
    group: "Observability",
    icon: ArrowLeftRight,
    component: () => import("./pages/TrafficPage.vue"),
  },
  {
    path: "/traces",
    name: "traces",
    label: "Traces",
    hint: "Per-call spans and waterfalls",
    group: "Observability",
    icon: Waypoints,
    component: () => import("./pages/TracesPage.vue"),
  },
  {
    path: "/monitors",
    name: "monitors",
    label: "Monitors",
    hint: "Synthetic uptime + schema-drift checks",
    group: "Observability",
    icon: Radar,
    component: () => import("./pages/MonitorsPage.vue"),
  },
  {
    path: "/alerts",
    name: "alerts",
    label: "Alerts",
    hint: "Webhook alert rules",
    group: "Observability",
    icon: BellRing,
    component: () => import("./pages/AlertsPage.vue"),
  },
  {
    path: "/schedules",
    name: "schedules",
    label: "Schedules",
    hint: "Cron enable/disable jobs",
    group: "Observability",
    icon: Clock,
    component: () => import("./pages/SchedulesPage.vue"),
  },
  {
    path: "/audit-log",
    name: "audit-log",
    label: "Audit log",
    hint: "Hash-chained admin actions",
    group: "Observability",
    icon: ScrollText,
    component: () => import("./pages/AuditLogPage.vue"),
  },
  // Administration (admin-only)
  {
    path: "/users",
    name: "users",
    label: "Users",
    hint: "Admin accounts",
    group: "Administration",
    icon: UserCog,
    component: () => import("./pages/UsersPage.vue"),
    meta: { role: "admin" },
  },
  {
    path: "/teams",
    name: "teams",
    label: "Teams",
    hint: "Server ownership groups",
    group: "Administration",
    icon: UsersRound,
    component: () => import("./pages/TeamsPage.vue"),
    meta: { role: "admin" },
  },
  {
    path: "/config",
    name: "config",
    label: "Config",
    hint: "Export, import, snapshots",
    group: "Administration",
    icon: Settings2,
    component: () => import("./pages/ConfigPage.vue"),
    meta: { role: "admin" },
  },
  {
    path: "/sso",
    name: "sso",
    label: "SSO",
    hint: "OIDC single sign-on settings",
    group: "Administration",
    icon: Fingerprint,
    component: () => import("./pages/SsoSettingsPage.vue"),
    meta: { role: "admin" },
  },
  // Palette-only — Account has its own bespoke treatment in the sidebar footer, not a nav-group entry.
  {
    path: "/account",
    name: "account",
    label: "Account",
    hint: "Your profile, password, and sessions",
    group: null,
    icon: UserCircle,
    component: () => import("./pages/AccountPage.vue"),
  },
];
