import { createRouter, createWebHistory } from "vue-router";
import { useAuth } from "../composables/useAuth";

const routes = [
  { path: "/", redirect: "/clients" },
  { path: "/login", name: "login", component: () => import("../pages/LoginPage.vue"), meta: { public: true } },
  { path: "/clients", name: "clients", component: () => import("../pages/DashboardPage.vue") },
  { path: "/clients/:name", name: "client-detail", component: () => import("../pages/ServerDetailPage.vue"), props: true },
  {
    path: "/clients/:name/tools/:tool",
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
  if (to.meta.public) return true;

  const { state, checkSession } = useAuth();
  if (!state.checked) {
    await checkSession();
  }
  if (!state.user) {
    return { name: "login", query: { redirect: to.fullPath } };
  }
  return true;
});
