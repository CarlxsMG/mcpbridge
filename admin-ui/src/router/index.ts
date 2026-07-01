import { createRouter, createWebHistory } from "vue-router";
import { useAuth } from "../composables/useAuth";

const routes = [
  { path: "/", redirect: "/servers" },
  { path: "/login", name: "login", component: () => import("../pages/LoginPage.vue"), meta: { public: true } },
  { path: "/servers", name: "servers", component: () => import("../pages/DashboardPage.vue") },
  { path: "/servers/:name", name: "server-detail", component: () => import("../pages/ServerDetailPage.vue"), props: true },
  {
    path: "/servers/:name/tools/:tool",
    name: "tool-guard",
    component: () => import("../pages/ServerDetailPage.vue"),
    props: true,
  },
  { path: "/register-server", name: "register-server", component: () => import("../pages/RegisterServerPage.vue") },
  { path: "/bundles", name: "bundles", component: () => import("../pages/BundlesPage.vue") },
  { path: "/bundles/:name", name: "bundle-detail", component: () => import("../pages/BundleDetailPage.vue"), props: true },
  { path: "/composites", name: "composites", component: () => import("../pages/CompositesPage.vue") },
  { path: "/keys", name: "keys", component: () => import("../pages/KeysPage.vue") },
  { path: "/policies", name: "policies", component: () => import("../pages/PoliciesPage.vue") },
  { path: "/consumers", name: "consumers", component: () => import("../pages/ConsumersPage.vue") },
  { path: "/users", name: "users", component: () => import("../pages/UsersPage.vue") },
  { path: "/config", name: "config", component: () => import("../pages/ConfigPage.vue") },
  { path: "/audit-log", name: "audit-log", component: () => import("../pages/AuditLogPage.vue") },
  { path: "/overview", name: "overview", component: () => import("../pages/OverviewPage.vue") },
  { path: "/usage", name: "usage", component: () => import("../pages/UsagePage.vue") },
  { path: "/alerts", name: "alerts", component: () => import("../pages/AlertsPage.vue") },
  { path: "/schedules", name: "schedules", component: () => import("../pages/SchedulesPage.vue") },
  { path: "/:pathMatch(.*)*", name: "not-found", component: () => import("../pages/NotFoundPage.vue"), meta: { public: true } },
];

export const router = createRouter({
  history: createWebHistory("/admin/"),
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
  return true;
});
