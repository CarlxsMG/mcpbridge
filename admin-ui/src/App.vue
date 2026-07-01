<script setup lang="ts">
import { computed } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useAuth } from "./composables/useAuth";

const route = useRoute();
const router = useRouter();
const { state, logout } = useAuth();

const showShell = computed(() => !route.meta.public && state.user !== null);

async function onLogout() {
  await logout();
  await router.push("/login");
}
</script>

<template>
  <div v-if="showShell" class="app-shell">
    <nav class="sidebar">
      <div class="brand">MCP REST Bridge</div>
      <ul>
        <li><RouterLink to="/clients">Servers</RouterLink></li>
        <li><RouterLink to="/overview">Overview</RouterLink></li>
        <li v-if="state.user?.role === 'admin'"><RouterLink to="/users">Users</RouterLink></li>
        <li><RouterLink to="/audit-log">Audit log</RouterLink></li>
      </ul>
      <div class="sidebar-footer">
        <div class="current-user">{{ state.user?.username }} <span class="role">({{ state.user?.role }})</span></div>
        <button type="button" class="link-btn" @click="onLogout">Sign out</button>
      </div>
    </nav>
    <main class="content">
      <RouterView />
    </main>
  </div>
  <RouterView v-else />
</template>

<style scoped>
.app-shell {
  display: flex;
  min-height: 100vh;
}
.sidebar {
  width: 220px;
  flex-shrink: 0;
  background: #171a1f;
  color: #e6e8eb;
  display: flex;
  flex-direction: column;
  padding: 1.25rem 1rem;
}
.brand {
  font-weight: 700;
  font-size: 0.95rem;
  margin-bottom: 1.5rem;
  padding: 0 0.5rem;
}
.sidebar ul {
  list-style: none;
  padding: 0;
  margin: 0;
  flex: 1;
}
.sidebar li {
  margin-bottom: 0.25rem;
}
.sidebar :deep(a) {
  display: block;
  padding: 0.5rem 0.6rem;
  border-radius: 6px;
  color: #c6cad1;
  text-decoration: none;
  font-size: 0.9rem;
}
.sidebar :deep(a.router-link-active) {
  background: #2a2f38;
  color: #fff;
}
.sidebar-footer {
  border-top: 1px solid #2a2f38;
  padding-top: 0.75rem;
  font-size: 0.85rem;
}
.current-user {
  margin-bottom: 0.4rem;
}
.role {
  color: #8a8f98;
}
.sidebar-footer .link-btn {
  color: #c6cad1;
}
.content {
  flex: 1;
  padding: 2rem 2.5rem;
  max-width: 1100px;
}
</style>
