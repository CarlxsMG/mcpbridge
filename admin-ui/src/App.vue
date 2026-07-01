<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useAuth } from "./composables/useAuth";

const route = useRoute();
const router = useRouter();
const { state, logout } = useAuth();

const showShell = computed(() => !route.meta.public && state.user !== null);
const mobileNavOpen = ref(false);

watch(() => route.fullPath, () => {
  mobileNavOpen.value = false;
});

async function onLogout() {
  await logout();
  await router.push("/login");
}
</script>

<template>
  <div v-if="showShell" class="app-shell">
    <header class="mobile-topbar">
      <button
        type="button"
        class="mobile-nav-toggle"
        :aria-expanded="mobileNavOpen"
        aria-controls="sidebar-nav"
        aria-label="Toggle navigation menu"
        @click="mobileNavOpen = !mobileNavOpen"
      >
        <span aria-hidden="true">☰</span>
      </button>
      <div class="brand">MCP REST Bridge</div>
    </header>
    <div v-if="mobileNavOpen" class="mobile-nav-backdrop" @click="mobileNavOpen = false"></div>
    <nav id="sidebar-nav" class="sidebar" :class="{ 'sidebar-open': mobileNavOpen }">
      <div class="brand">MCP REST Bridge</div>
      <ul>
        <li><RouterLink to="/servers">Servers</RouterLink></li>
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
.mobile-topbar {
  display: none;
}
.mobile-nav-backdrop {
  display: none;
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
  min-width: 0;
}

@media (max-width: 768px) {
  .app-shell {
    display: block;
  }
  .mobile-topbar {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    background: #171a1f;
    color: #fff;
    padding: 0.75rem 1rem;
    position: sticky;
    top: 0;
    z-index: 120;
  }
  .mobile-topbar .brand {
    margin: 0;
    padding: 0;
  }
  .mobile-nav-toggle {
    background: none;
    border: 1px solid #3a3f48;
    border-radius: 6px;
    color: #fff;
    font-size: 1.1rem;
    line-height: 1;
    padding: 0.35rem 0.6rem;
    cursor: pointer;
  }
  .mobile-nav-backdrop {
    display: block;
    position: fixed;
    inset: 0;
    background: rgba(15, 18, 22, 0.45);
    z-index: 150;
  }
  .sidebar {
    position: fixed;
    top: 0;
    left: 0;
    height: 100vh;
    width: min(280px, 82vw);
    z-index: 200;
    transform: translateX(-100%);
    transition: transform 0.2s ease;
    box-shadow: 8px 0 24px rgba(0, 0, 0, 0.2);
  }
  .sidebar.sidebar-open {
    transform: translateX(0);
  }
  .sidebar .brand {
    display: none;
  }
  .content {
    padding: 1.25rem 1rem;
    max-width: 100%;
  }
}
</style>
