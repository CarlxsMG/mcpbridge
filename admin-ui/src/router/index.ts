import { ref, nextTick } from "vue";
import { createRouter, createWebHashHistory, createWebHistory, type RouteLocationNormalized } from "vue-router";
import { useAuth } from "@/composables/useAuth";
import { tk } from "@/i18n";
import { navEntries } from "../navigation";

// The ~24 static, param-free routes come from navEntries (shared with App.vue's
// sidebar and CommandPalette.vue) — see admin-ui/src/navigation.ts. Routes with
// params, or with no fixed label/icon to share, stay hand-written here.
const routes = [
  { path: "/", redirect: "/servers" },
  { path: "/login", name: "login", component: () => import("../pages/LoginPage.vue"), meta: { public: true } },
  ...navEntries.map((entry) => ({ path: entry.path, name: entry.name, component: entry.component, meta: entry.meta })),
  {
    path: "/servers/:name",
    name: "server-detail",
    component: () => import("../pages/ServerDetailPage.vue"),
    props: true,
  },
  {
    path: "/servers/:name/tools/:tool",
    name: "tool-guard",
    component: () => import("../pages/ServerDetailPage.vue"),
    props: true,
  },
  {
    path: "/bundles/:name",
    name: "bundle-detail",
    component: () => import("../pages/BundleDetailPage.vue"),
    props: true,
  },
  {
    path: "/composites/:name",
    name: "composite-detail",
    component: () => import("../pages/CompositeDetailPage.vue"),
    props: true,
  },
  // The 11 "/x/new" create routes also come from navEntries (each entry's optional
  // `newPage`), for the same reason as the static routes above — see navigation.ts.
  ...navEntries.flatMap((entry) =>
    entry.newPage
      ? [{ path: `${entry.path}/new`, name: entry.newPage.name, component: entry.newPage.component, meta: entry.meta }]
      : [],
  ),
  {
    path: "/traces/:traceId",
    name: "trace-detail",
    component: () => import("../pages/TraceDetailPage.vue"),
    props: true,
  },
  {
    path: "/:pathMatch(.*)*",
    name: "not-found",
    component: () => import("../pages/NotFoundPage.vue"),
    meta: { public: true },
  },
];

// The base comes from Vite (`import.meta.env.BASE_URL`) so history stays in lockstep
// with the build's base path: "/admin/" for the product, "/<repo>/demo/" for the
// public demo. The demo is a static SPA on GitHub Pages, so it uses hash history to
// avoid needing server-side rewrites for deep links / refreshes.
const isDemo = import.meta.env.VITE_DEMO === "true";
export const router = createRouter({
  history: isDemo ? createWebHashHistory(import.meta.env.BASE_URL) : createWebHistory(import.meta.env.BASE_URL),
  routes,
});

router.beforeEach(async (to) => {
  const { state, checkSession } = useAuth();
  if (!state.checked) {
    await checkSession();
  }

  // Already signed in? Don't show the login form again — send the user
  // where they were headed (or the default landing page).
  if (to.name === "login") {
    if (!state.user) return true;
    return typeof to.query.redirect === "string" ? to.query.redirect : "/servers";
  }

  if (to.meta.public) return true;

  if (!state.user) {
    return { name: "login", query: { redirect: to.fullPath } };
  }

  if (to.meta.role === "admin" && state.user.role !== "admin") {
    return { name: "servers" };
  }
  return true;
});

// Text announced to assistive tech after a client-side navigation, rendered
// into App.vue's polite aria-live region. Set only on real page changes (see
// afterEach below) so pagination/filter/drawer param updates stay silent.
export const routeAnnouncement = ref("");

/**
 * A human, localized page title for the browser tab + the route announcement.
 * Prefers the shared, translated nav label (`nav.<name>.label`, same keys the
 * sidebar uses), then a meaningful route param (server/bundle name, trace id),
 * then a humanized slug so login / not-found / "*-new" routes still read well.
 * Localizes correctly at locale=es because the nav labels do.
 */
function resolvePageTitle(to: RouteLocationNormalized): string {
  const name = typeof to.name === "string" ? to.name : "";

  const labelKey = `nav.${name}.label`;
  const label = tk(labelKey);
  if (label !== labelKey) return label;

  const param = to.params.name ?? to.params.traceId;
  if (typeof param === "string" && param) return param;

  if (name) return name.replace(/-/g, " ").replace(/^./, (c) => c.toUpperCase());
  return "MCP Bridge";
}

// The guard-editor drawer is a route-param change on the *same* page
// (server-detail ⇄ tool-guard), which manages its own focus — collapse the two
// names so navigating into/out of the drawer isn't treated as a page change.
function pageKey(name: unknown): string {
  if (typeof name !== "string") return "";
  return name === "tool-guard" ? "server-detail" : name;
}

router.afterEach((to, from) => {
  const title = resolvePageTitle(to);
  document.title = title === "MCP Bridge" ? title : `${title} — MCP Bridge`;

  // Focus + announcement only on a genuine page change. Same-page param/query
  // updates (pagination, filters, opening the drawer) must not steal focus from
  // the control the user just operated, nor re-announce the same page.
  if (pageKey(to.name) === pageKey(from.name)) return;

  routeAnnouncement.value = title;
  // Land keyboard focus on the main region once the new page has rendered, so
  // keyboard/AT users start at the top of the new content (WCAG 2.4.3). No-ops
  // gracefully on the pre-login shell where #main-content isn't mounted.
  void nextTick(() => document.getElementById("main-content")?.focus());
});
