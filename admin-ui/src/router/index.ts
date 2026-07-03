import { createRouter, createWebHashHistory, createWebHistory } from "vue-router";
import { useAuth } from "../composables/useAuth";

const routes = [
  { path: "/", redirect: "/servers" },
  { path: "/login", name: "login", component: () => import("../pages/LoginPage.vue"), meta: { public: true } },
  { path: "/servers", name: "servers", component: () => import("../pages/DashboardPage.vue") },
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
  { path: "/register-server", name: "register-server", component: () => import("../pages/RegisterServerPage.vue") },
  { path: "/catalog", name: "catalog", component: () => import("../pages/CatalogPage.vue") },
  { path: "/ws-proxies", name: "ws-proxies", component: () => import("../pages/WsProxyTargetsPage.vue") },
  { path: "/bundles", name: "bundles", component: () => import("../pages/BundlesPage.vue") },
  {
    path: "/bundles/:name",
    name: "bundle-detail",
    component: () => import("../pages/BundleDetailPage.vue"),
    props: true,
  },
  { path: "/composites", name: "composites", component: () => import("../pages/CompositesPage.vue") },
  {
    path: "/composites/:name",
    name: "composite-detail",
    component: () => import("../pages/CompositeDetailPage.vue"),
    props: true,
  },
  { path: "/keys", name: "keys", component: () => import("../pages/KeysPage.vue") },
  { path: "/policies", name: "policies", component: () => import("../pages/PoliciesPage.vue") },
  { path: "/consumers", name: "consumers", component: () => import("../pages/ConsumersPage.vue") },
  { path: "/users", name: "users", component: () => import("../pages/UsersPage.vue"), meta: { role: "admin" } },
  { path: "/teams", name: "teams", component: () => import("../pages/TeamsPage.vue"), meta: { role: "admin" } },
  { path: "/config", name: "config", component: () => import("../pages/ConfigPage.vue"), meta: { role: "admin" } },
  { path: "/audit-log", name: "audit-log", component: () => import("../pages/AuditLogPage.vue") },
  { path: "/account", name: "account", component: () => import("../pages/AccountPage.vue") },
  { path: "/overview", name: "overview", component: () => import("../pages/OverviewPage.vue") },
  { path: "/usage", name: "usage", component: () => import("../pages/UsagePage.vue") },
  { path: "/traffic", name: "traffic", component: () => import("../pages/TrafficPage.vue") },
  { path: "/monitors", name: "monitors", component: () => import("../pages/MonitorsPage.vue") },
  { path: "/approvals", name: "approvals", component: () => import("../pages/ApprovalsPage.vue") },
  { path: "/alerts", name: "alerts", component: () => import("../pages/AlertsPage.vue") },
  { path: "/schedules", name: "schedules", component: () => import("../pages/SchedulesPage.vue") },
  { path: "/traces", name: "traces", component: () => import("../pages/TracesPage.vue") },
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
