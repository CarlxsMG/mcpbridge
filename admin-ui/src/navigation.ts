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
 *
 * i18n: `labelKey`/`hintKey` resolve through vue-i18n at render time via
 * `useNavEntries()` in `composables/useNavEntries.ts`. The router consumes
 * this module too but only reads path/name/component/meta — translations
 * are irrelevant there.
 */
export type NavGroup = "Servers" | "Access" | "Observability" | "Administration" | null;

export interface NavEntry {
  path: string;
  name: string;
  labelKey: string;
  hintKey: string;
  group: NavGroup;
  icon: Component;
  component: () => Promise<{ default: Component }>;
  meta?: { role?: "admin" };
  // Some entries also own a "/new" create-route (e.g. /bundles/new) — router/index.ts
  // derives its path from `path` and reuses `meta`, so only name/component live here.
  newPage?: { name: string; component: () => Promise<{ default: Component }> };
}

// Stable label/hint key prefixes — entry.name is the canonical slug, so the
// resolvable key is always `nav.${entry.name}.label` / `.hint`. Group labels
// resolve to `nav.groups.${group}`.
function l(name: string) {
  return `nav.${name}.label`;
}
function h(name: string) {
  return `nav.${name}.hint`;
}
const GL = (g: Exclude<NavGroup, null>) => `nav.groups.${g}`;

export const navEntries: NavEntry[] = [
  // Servers
  {
    path: "/servers",
    name: "servers",
    labelKey: l("servers"),
    hintKey: h("servers"),
    group: "Servers",
    icon: Server,
    component: () => import("./pages/ServersPage.vue"),
  },
  {
    path: "/register-server",
    name: "register-server",
    labelKey: l("register-server"),
    hintKey: h("register-server"),
    group: "Servers",
    icon: Server,
    component: () => import("./pages/RegisterServerPage.vue"),
  },
  {
    path: "/catalog",
    name: "catalog",
    labelKey: l("catalog"),
    hintKey: h("catalog"),
    group: "Servers",
    icon: LayoutGrid,
    component: () => import("./pages/CatalogPage.vue"),
    newPage: { name: "catalog-new", component: () => import("./pages/NewCatalogEntryPage.vue") },
  },
  {
    path: "/bundles",
    name: "bundles",
    labelKey: l("bundles"),
    hintKey: h("bundles"),
    group: "Servers",
    icon: Boxes,
    component: () => import("./pages/BundlesPage.vue"),
    newPage: { name: "bundle-new", component: () => import("./pages/NewBundlePage.vue") },
  },
  {
    path: "/composites",
    name: "composites",
    labelKey: l("composites"),
    hintKey: h("composites"),
    group: "Servers",
    icon: Combine,
    component: () => import("./pages/CompositesPage.vue"),
    newPage: { name: "composite-new", component: () => import("./pages/NewCompositePage.vue") },
  },
  {
    path: "/ws-proxies",
    name: "ws-proxies",
    labelKey: l("ws-proxies"),
    hintKey: h("ws-proxies"),
    group: "Servers",
    icon: Cable,
    component: () => import("./pages/WsProxyTargetsPage.vue"),
    newPage: { name: "ws-proxy-new", component: () => import("./pages/NewWsProxyTargetPage.vue") },
  },
  // Access
  {
    path: "/keys",
    name: "keys",
    labelKey: l("keys"),
    hintKey: h("keys"),
    group: "Access",
    icon: KeyRound,
    component: () => import("./pages/KeysPage.vue"),
    newPage: { name: "key-new", component: () => import("./pages/NewApiKeyPage.vue") },
  },
  {
    path: "/policies",
    name: "policies",
    labelKey: l("policies"),
    hintKey: h("policies"),
    group: "Access",
    icon: ShieldCheck,
    component: () => import("./pages/PoliciesPage.vue"),
    newPage: { name: "policy-new", component: () => import("./pages/NewPolicyPage.vue") },
  },
  {
    path: "/consumers",
    name: "consumers",
    labelKey: l("consumers"),
    hintKey: h("consumers"),
    group: "Access",
    icon: Users2,
    component: () => import("./pages/ConsumersPage.vue"),
    newPage: { name: "consumer-new", component: () => import("./pages/NewConsumerPage.vue") },
  },
  {
    path: "/approvals",
    name: "approvals",
    labelKey: l("approvals"),
    hintKey: h("approvals"),
    group: "Access",
    icon: ClipboardCheck,
    component: () => import("./pages/ApprovalsPage.vue"),
  },
  // Observability
  {
    path: "/overview",
    name: "overview",
    labelKey: l("overview"),
    hintKey: h("overview"),
    group: "Observability",
    icon: LayoutDashboard,
    component: () => import("./pages/OverviewPage.vue"),
  },
  {
    path: "/usage",
    name: "usage",
    labelKey: l("usage"),
    hintKey: h("usage"),
    group: "Observability",
    icon: Activity,
    component: () => import("./pages/UsagePage.vue"),
  },
  {
    path: "/traffic",
    name: "traffic",
    labelKey: l("traffic"),
    hintKey: h("traffic"),
    group: "Observability",
    icon: ArrowLeftRight,
    component: () => import("./pages/TrafficPage.vue"),
  },
  {
    path: "/traces",
    name: "traces",
    labelKey: l("traces"),
    hintKey: h("traces"),
    group: "Observability",
    icon: Waypoints,
    component: () => import("./pages/TracesPage.vue"),
  },
  {
    path: "/monitors",
    name: "monitors",
    labelKey: l("monitors"),
    hintKey: h("monitors"),
    group: "Observability",
    icon: Radar,
    component: () => import("./pages/MonitorsPage.vue"),
  },
  {
    path: "/alerts",
    name: "alerts",
    labelKey: l("alerts"),
    hintKey: h("alerts"),
    group: "Observability",
    icon: BellRing,
    component: () => import("./pages/AlertsPage.vue"),
    newPage: { name: "alert-new", component: () => import("./pages/NewAlertPage.vue") },
  },
  {
    path: "/schedules",
    name: "schedules",
    labelKey: l("schedules"),
    hintKey: h("schedules"),
    group: "Observability",
    icon: Clock,
    component: () => import("./pages/SchedulesPage.vue"),
    newPage: { name: "schedule-new", component: () => import("./pages/NewSchedulePage.vue") },
  },
  {
    path: "/audit-log",
    name: "audit-log",
    labelKey: l("audit-log"),
    hintKey: h("audit-log"),
    group: "Observability",
    icon: ScrollText,
    component: () => import("./pages/AuditLogPage.vue"),
  },
  // Administration (admin-only)
  {
    path: "/users",
    name: "users",
    labelKey: l("users"),
    hintKey: h("users"),
    group: "Administration",
    icon: UserCog,
    component: () => import("./pages/UsersPage.vue"),
    meta: { role: "admin" },
    newPage: { name: "user-new", component: () => import("./pages/NewUserPage.vue") },
  },
  {
    path: "/teams",
    name: "teams",
    labelKey: l("teams"),
    hintKey: h("teams"),
    group: "Administration",
    icon: UsersRound,
    component: () => import("./pages/TeamsPage.vue"),
    meta: { role: "admin" },
    newPage: { name: "team-new", component: () => import("./pages/NewTeamPage.vue") },
  },
  {
    path: "/config",
    name: "config",
    labelKey: l("config"),
    hintKey: h("config"),
    group: "Administration",
    icon: Settings2,
    component: () => import("./pages/ConfigPage.vue"),
    meta: { role: "admin" },
  },
  {
    path: "/sso",
    name: "sso",
    labelKey: l("sso"),
    hintKey: h("sso"),
    group: "Administration",
    icon: Fingerprint,
    component: () => import("./pages/SsoSettingsPage.vue"),
    meta: { role: "admin" },
  },
  // Palette-only — Account has its own bespoke treatment in the sidebar footer, not a nav-group entry.
  {
    path: "/account",
    name: "account",
    labelKey: l("account"),
    hintKey: h("account"),
    group: null,
    icon: UserCircle,
    component: () => import("./pages/AccountPage.vue"),
  },
];

export const NAV_GROUP_KEYS: Record<Exclude<NavGroup, null>, string> = {
  Servers: GL("Servers"),
  Access: GL("Access"),
  Observability: GL("Observability"),
  Administration: GL("Administration"),
};
