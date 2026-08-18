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
 * `group` drives the sidebar's section headers in TheSidebar.vue (Servers/
 * Access/Observability/Administration/none). CommandPalette.vue ignores it and
 * buckets every entry here under a single "Pages" group instead, to stay
 * distinct from its live-fetched "Servers"/"Bundles"/"API keys" groups.
 *
 * i18n: `labelKey`/`hintKey` resolve through vue-i18n at render time via
 * `useNavEntries()` in `composables/useNavEntries.ts`. The router consumes
 * this module too but only reads path/name/component/meta — translations
 * are irrelevant there.
 */
export type NavGroup = "Servers" | "Access" | "Observability" | "Administration" | null;

/**
 * How prominent an entry is on a fresh instance. `core` is the set a user needs
 * before they have any traffic at all — register a server, expose it, hand out a
 * key, see whether calls land, and manage the people who can do that. Everything
 * else is `advanced`: real features, but ones that answer a question nobody has
 * on day 1, so TheSidebar.vue parks them behind a collapsed disclosure.
 *
 * The field is REQUIRED rather than defaulted so the compiler asks the question
 * for a new page instead of quietly enlarging the first-run list — every entry
 * added since this split would otherwise have landed in it.
 *
 * The tier is a presentation hint for the sidebar ONLY. Routing (router/index.ts)
 * and the command palette (CommandPalette.vue) both read this module whole and
 * stay tier-blind: an advanced page is always routable and always searchable,
 * which is what makes hiding it by default safe.
 */
export type NavTier = "core" | "advanced";

export interface NavEntry {
  path: string;
  name: string;
  labelKey: string;
  hintKey: string;
  group: NavGroup;
  tier: NavTier;
  icon: Component;
  component: () => Promise<{ default: Component }>;
  meta?: { role?: "admin" };
  // Some entries also own a "/new" create-route (e.g. /bundles/new) — router/index.ts
  // derives its path from `path` and reuses `meta`, so only name/component live here.
  //
  // `titleKey` is the i18n key the page already renders in its own PageHeader. The
  // router needs it because a create route has no `nav.<name>.label` to fall back
  // on, and without it resolvePageTitle humanized the route slug instead — giving
  // every create flow an untranslated, ungrammatical document title and aria-live
  // announcement ("Bundle new", "Key new", "Policy new") even at locale=es. It is
  // spelled out per entry rather than derived as `pages.<name>.new.title` because
  // two pages don't follow that shape (alerts, register-server).
  newPage?: { name: string; titleKey: string; component: () => Promise<{ default: Component }> };
  // Some entries also own an "/:id/edit" route. Same deal as `newPage` — the
  // router derives the path from `path` and reuses `meta`, and `titleKey` is
  // spelled out because an edit route has no `nav.<name>.label` to fall back
  // on either.
  //
  // `component` is deliberately the SAME component the entry's `newPage`
  // points at: create and edit render one dual-mode form page that switches
  // on the presence of the `id` route param. Pointing them at two files is
  // what let the consumers create-page and the consumers inline edit-form
  // drift into two implementations of the same three fields with two parallel
  // sets of i18n keys — don't reintroduce that here.
  editPage?: { name: string; titleKey: string; component: () => Promise<{ default: Component }> };
  // Entry names, in tab order, that THIS page renders as tabs instead of the
  // sidebar rendering them as rows of their own. router/index.ts turns each into
  // a child route of this entry — so the tab strip survives a tab switch and the
  // selected tab is a real, linkable URL — and this entry's own path lands on
  // the first tab.
  //
  // Each tab still keeps a full entry below, carrying `group: null` so only the
  // parent reaches the sidebar. That is deliberate: an entry is also how a page
  // gets into the command palette, and "every page stays one Ctrl-K away" is the
  // escape hatch that makes folding pages together safe in the first place.
  tabs?: string[];
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
    tier: "core",
    icon: Server,
    component: () => import("./pages/ServersPage.vue"),
    // Registering a server is an ACTION, and it used to hold a permanent
    // sidebar slot of its own — the only create form in the app that did.
    // Folding it into the `newPage` pattern every other entity uses puts it
    // where a user already looks for "add one" (the button on the list page)
    // and gives the sidebar back a row.
    newPage: {
      name: "register-server",
      titleKey: "pages.register_server.title",
      component: () => import("./pages/RegisterServerPage.vue"),
    },
  },
  {
    path: "/catalog",
    name: "catalog",
    labelKey: l("catalog"),
    hintKey: h("catalog"),
    group: "Servers",
    tier: "advanced",
    icon: LayoutGrid,
    component: () => import("./pages/CatalogPage.vue"),
    newPage: {
      name: "catalog-new",
      titleKey: "pages.catalog.new.title",
      component: () => import("./pages/CatalogEntryFormPage.vue"),
    },
    editPage: {
      name: "catalog-edit",
      titleKey: "pages.catalog.edit.title",
      component: () => import("./pages/CatalogEntryFormPage.vue"),
    },
  },
  {
    path: "/bundles",
    name: "bundles",
    labelKey: l("bundles"),
    hintKey: h("bundles"),
    group: "Servers",
    tier: "core",
    icon: Boxes,
    component: () => import("./pages/BundlesPage.vue"),
    newPage: {
      name: "bundle-new",
      titleKey: "pages.bundles.new.title",
      component: () => import("./pages/NewBundlePage.vue"),
    },
  },
  {
    path: "/composites",
    name: "composites",
    labelKey: l("composites"),
    hintKey: h("composites"),
    group: "Servers",
    tier: "advanced",
    icon: Combine,
    component: () => import("./pages/CompositesPage.vue"),
    newPage: {
      name: "composite-new",
      titleKey: "pages.composites.new.title",
      component: () => import("./pages/NewCompositePage.vue"),
    },
  },
  {
    path: "/ws-proxies",
    name: "ws-proxies",
    labelKey: l("ws-proxies"),
    hintKey: h("ws-proxies"),
    group: "Servers",
    tier: "advanced",
    icon: Cable,
    component: () => import("./pages/WsProxyTargetsPage.vue"),
    newPage: {
      name: "ws-proxy-new",
      titleKey: "pages.ws_proxy_targets.new.title",
      component: () => import("./pages/WsProxyTargetFormPage.vue"),
    },
    editPage: {
      name: "ws-proxy-edit",
      titleKey: "pages.ws_proxy_targets.edit.title",
      component: () => import("./pages/WsProxyTargetFormPage.vue"),
    },
  },
  // Access
  {
    path: "/keys",
    name: "keys",
    labelKey: l("keys"),
    hintKey: h("keys"),
    group: "Access",
    tier: "core",
    icon: KeyRound,
    component: () => import("./pages/KeysPage.vue"),
    newPage: {
      name: "key-new",
      titleKey: "pages.keys.new.title",
      component: () => import("./pages/NewApiKeyPage.vue"),
    },
  },
  {
    path: "/policies",
    name: "policies",
    labelKey: l("policies"),
    hintKey: h("policies"),
    group: "Access",
    tier: "advanced",
    icon: ShieldCheck,
    component: () => import("./pages/PoliciesPage.vue"),
    newPage: {
      name: "policy-new",
      titleKey: "pages.policies.new.title",
      component: () => import("./pages/PolicyFormPage.vue"),
    },
    editPage: {
      name: "policy-edit",
      titleKey: "pages.policies.edit.title",
      component: () => import("./pages/PolicyFormPage.vue"),
    },
  },
  {
    path: "/consumers",
    name: "consumers",
    labelKey: l("consumers"),
    hintKey: h("consumers"),
    group: "Access",
    tier: "advanced",
    icon: Users2,
    component: () => import("./pages/ConsumersPage.vue"),
    newPage: {
      name: "consumer-new",
      titleKey: "pages.consumers.new.title",
      component: () => import("./pages/ConsumerFormPage.vue"),
    },
    editPage: {
      name: "consumer-edit",
      titleKey: "pages.consumers.edit.title",
      component: () => import("./pages/ConsumerFormPage.vue"),
    },
  },
  {
    path: "/approvals",
    name: "approvals",
    labelKey: l("approvals"),
    hintKey: h("approvals"),
    group: "Access",
    tier: "advanced",
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
    tier: "core",
    icon: LayoutDashboard,
    component: () => import("./pages/OverviewPage.vue"),
  },
  // Usage, Traffic and Traces answer three neighbouring questions — how much was
  // called, what exactly was called, where did one call spend its time — and as
  // three sidebar rows they forced the user to guess which one holds the answer
  // before opening anything. They are one page with three tabs now; the sidebar
  // asks for "Activity" and the tab strip makes the three views adjacent instead
  // of alternatives.
  {
    path: "/activity",
    name: "activity",
    labelKey: l("activity"),
    hintKey: h("activity"),
    group: "Observability",
    tier: "core",
    icon: Activity,
    component: () => import("./pages/ActivityPage.vue"),
    tabs: ["usage", "traffic", "traces"],
  },
  // The three tabs. `group: null` is what keeps them out of the sidebar — the
  // Activity row above is the only one — while the entries themselves still feed
  // the command palette and router/index.ts's child routes. `tier` is inert for a
  // tab (the sidebar filters on `group` before it ever reads the tier), so it
  // records the honest answer: none of the three is a day-1 destination alone.
  {
    path: "/activity/usage",
    name: "usage",
    labelKey: l("usage"),
    hintKey: h("usage"),
    group: null,
    tier: "advanced",
    icon: Activity,
    component: () => import("./pages/UsagePage.vue"),
  },
  {
    path: "/activity/traffic",
    name: "traffic",
    labelKey: l("traffic"),
    hintKey: h("traffic"),
    group: null,
    tier: "advanced",
    icon: ArrowLeftRight,
    component: () => import("./pages/TrafficPage.vue"),
  },
  {
    path: "/activity/traces",
    name: "traces",
    labelKey: l("traces"),
    hintKey: h("traces"),
    group: null,
    tier: "advanced",
    icon: Waypoints,
    component: () => import("./pages/TracesPage.vue"),
  },
  {
    path: "/monitors",
    name: "monitors",
    labelKey: l("monitors"),
    hintKey: h("monitors"),
    group: "Observability",
    tier: "advanced",
    icon: Radar,
    component: () => import("./pages/MonitorsPage.vue"),
  },
  {
    path: "/alerts",
    name: "alerts",
    labelKey: l("alerts"),
    hintKey: h("alerts"),
    group: "Observability",
    tier: "advanced",
    icon: BellRing,
    component: () => import("./pages/AlertsPage.vue"),
    newPage: {
      name: "alert-new",
      titleKey: "pages.alerts.new_title",
      component: () => import("./pages/NewAlertPage.vue"),
    },
  },
  {
    path: "/schedules",
    name: "schedules",
    labelKey: l("schedules"),
    hintKey: h("schedules"),
    group: "Observability",
    tier: "advanced",
    icon: Clock,
    component: () => import("./pages/SchedulesPage.vue"),
    newPage: {
      name: "schedule-new",
      titleKey: "pages.schedules.new.title",
      component: () => import("./pages/NewSchedulePage.vue"),
    },
  },
  {
    path: "/audit-log",
    name: "audit-log",
    labelKey: l("audit-log"),
    hintKey: h("audit-log"),
    group: "Observability",
    tier: "core",
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
    tier: "core",
    icon: UserCog,
    component: () => import("./pages/UsersPage.vue"),
    meta: { role: "admin" },
    newPage: {
      name: "user-new",
      titleKey: "pages.users.new.title",
      component: () => import("./pages/NewUserPage.vue"),
    },
  },
  {
    path: "/teams",
    name: "teams",
    labelKey: l("teams"),
    hintKey: h("teams"),
    group: "Administration",
    tier: "advanced",
    icon: UsersRound,
    component: () => import("./pages/TeamsPage.vue"),
    meta: { role: "admin" },
    newPage: {
      name: "team-new",
      titleKey: "pages.teams.new.title",
      component: () => import("./pages/NewTeamPage.vue"),
    },
  },
  {
    path: "/config",
    name: "config",
    labelKey: l("config"),
    hintKey: h("config"),
    group: "Administration",
    tier: "core",
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
    tier: "advanced",
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
    tier: "core",
    icon: UserCircle,
    component: () => import("./pages/AccountPage.vue"),
  },
];

const NAV_TAB_NAMES = new Set(navEntries.flatMap((entry) => entry.tabs ?? []));

/** True for an entry rendered as a tab inside another page rather than as a page of its own. */
export function isNavTab(name: string): boolean {
  return NAV_TAB_NAMES.has(name);
}

/**
 * The page that renders `name` as one of its tabs, or null when `name` is not a
 * tab. Lets a consumer treat "moved to another tab" as "still on the same page",
 * which is what it is.
 */
export function navTabParent(name: string): string | null {
  return navEntries.find((entry) => entry.tabs?.includes(name))?.name ?? null;
}

/**
 * The entries `name`'s page renders as tabs, in tab order — empty for every page
 * that has none. The router (which builds one child route per tab) and the tab
 * strip itself both read this, so neither can end up disagreeing with the other
 * about which tabs exist, in what order, or where a tab's label comes from.
 */
export function navTabsOf(name: string): NavEntry[] {
  const parent = navEntries.find((entry) => entry.name === name);
  return (parent?.tabs ?? []).flatMap((tabName) => {
    const tab = navEntries.find((entry) => entry.name === tabName);
    return tab ? [tab] : [];
  });
}

export const NAV_GROUP_KEYS: Record<Exclude<NavGroup, null>, string> = {
  Servers: GL("Servers"),
  Access: GL("Access"),
  Observability: GL("Observability"),
  Administration: GL("Administration"),
};

// Visual order of the sidebar's section headers. It lives here rather than in
// TheSidebar.vue because the sidebar now renders the groups TWICE — once for the
// always-visible entries and once inside the Advanced disclosure — and the two
// passes must not be able to disagree about the order.
export const NAV_GROUP_ORDER = ["Servers", "Access", "Observability", "Administration"] as const;

/**
 * The nav entry a router path belongs to, by longest matching path prefix, so
 * `/servers/payments/tools/list` and `/servers/new` both answer "servers".
 *
 * The sidebar uses it to keep the ACTIVE page's entry visible even when its tier
 * would park it inside the collapsed Advanced section: landing on a page with no
 * row in the nav leaves nothing highlighted and no obvious way back, which is
 * exactly the disorientation the disclosure is supposed to avoid. It is the only
 * thing that moves a row between the two sections — the tier split itself is the
 * same for every user and every browser. Returns null for paths outside the
 * static nav (`/login`, an unknown URL).
 */
export function navEntryNameForPath(path: string): string | null {
  let best: NavEntry | null = null;
  for (const entry of navEntries) {
    // A tab is not a sidebar row, so /activity/usage belongs to the Activity
    // entry. Leaving the tab entries in the scan would answer "usage" — a name
    // the sidebar renders nothing for — and the row of the page the user is
    // actually on would not be promoted out of the Advanced disclosure.
    if (isNavTab(entry.name)) continue;
    if (path !== entry.path && !path.startsWith(`${entry.path}/`)) continue;
    if (best === null || entry.path.length > best.path.length) best = entry;
  }
  return best === null ? null : best.name;
}
