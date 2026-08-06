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
  {
    path: "/login",
    name: "login",
    component: () => import("../pages/LoginPage.vue"),
    meta: { public: true, titleKey: "pages.login.title" },
  },
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
  // The 12 "/x/new" create routes also come from navEntries (each entry's optional
  // `newPage`), for the same reason as the static routes above — see navigation.ts.
  // `titleKey` rides along in `meta` so resolvePageTitle can name a create page:
  // it has no `nav.<name>.label` of its own to fall back on.
  ...navEntries.flatMap((entry) =>
    entry.newPage
      ? [
          {
            path: `${entry.path}/new`,
            name: entry.newPage.name,
            component: entry.newPage.component,
            meta: { ...entry.meta, titleKey: entry.newPage.titleKey },
          },
        ]
      : [],
  ),
  // The "/x/:id/edit" routes, same derivation as the create routes above. The
  // page component is shared with `newPage` and switches mode on `id`, which
  // arrives as a prop (`props: true`) rather than being read off useRoute() so
  // the component stays trivially testable with a plain mount({ props }).
  ...navEntries.flatMap((entry) =>
    entry.editPage
      ? [
          {
            path: `${entry.path}/:id/edit`,
            name: entry.editPage.name,
            component: entry.editPage.component,
            props: true,
            meta: { ...entry.meta, titleKey: entry.editPage.titleKey },
          },
        ]
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
    meta: { public: true, titleKey: "pages.not_found.title" },
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
 * Prefers an explicit `meta.titleKey` (create routes, login, not-found — the
 * pages with no nav entry of their own), then the shared, translated nav label
 * (`nav.<name>.label`, same keys the sidebar uses), then a meaningful route
 * param (server/bundle name, trace id). Localizes correctly at locale=es
 * because all of those keys do.
 *
 * The last resort humanizes the route slug. Nothing reaches it today, and it is
 * a poor title when anything does: it yielded "Bundle new" / "Key new" /
 * "Policy new" — untranslated and ungrammatical — for every create route back
 * when they had no titleKey, in an app that was rendering Spanish. Keep it only
 * as a guard against an empty <title>, not as a naming strategy.
 */
function resolvePageTitle(to: RouteLocationNormalized): string {
  const name = typeof to.name === "string" ? to.name : "";

  const titleKey = typeof to.meta.titleKey === "string" ? to.meta.titleKey : "";
  if (titleKey) {
    const explicit = tk(titleKey);
    if (explicit !== titleKey) return explicit;
  }

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
