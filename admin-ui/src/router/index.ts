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
  { path: "/users", name: "users", component: () => import("../pages/UsersPage.vue") },
  { path: "/audit-log", name: "audit-log", component: () => import("../pages/AuditLogPage.vue") },
  { path: "/overview", name: "overview", component: () => import("../pages/OverviewPage.vue") },
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
