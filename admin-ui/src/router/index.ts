import { createRouter, createWebHashHistory, createWebHistory } from "vue-router";
import { useAuth } from "../composables/useAuth";
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
  { path: "/traces/:traceId", name: "trace-detail", component: () => import("../pages/TracesPage.vue"), props: true },
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

// Derives a readable page title from the route name (e.g. "server-detail" -> "Server detail")
// so the browser tab reflects where the user actually is, not a static index.html title.
router.afterEach((to) => {
  if (typeof to.name !== "string") return;
  const readable = to.name.replace(/-/g, " ").replace(/^./, (c) => c.toUpperCase());
  document.title = `${readable} — MCP Bridge`;
});
