<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useAuth } from "./composables/useAuth";
import CommandPalette from "./components/CommandPalette.vue";
import {
  Server,
  Boxes,
  Combine,
  KeyRound,
  ShieldCheck,
  Users2,
  LayoutDashboard,
  Activity,
  BellRing,
  Clock,
  ScrollText,
  UserCog,
  UsersRound,
  Settings2,
  GitBranch,
} from "lucide-vue-next";

const route = useRoute();
const router = useRouter();
const { state, logout } = useAuth();

const isDemo = import.meta.env.VITE_DEMO === "true";

const showShell = computed(() => state.user !== null);
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
  <a
    v-if="isDemo"
    class="demo-ribbon"
    href="https://github.com/aico-dot-team-code/mcpbridge"
    target="_blank"
    rel="noopener"
  >
    <GitBranch :size="13" stroke-width="2.5" aria-hidden="true" /> Live demo — data is mocked · View source ↗
  </a>
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
      <div class="brand"><GitBranch :size="16" stroke-width="2.25" aria-hidden="true" /> MCP REST Bridge</div>
    </header>
    <div v-if="mobileNavOpen" class="mobile-nav-backdrop" @click="mobileNavOpen = false"></div>
    <nav id="sidebar-nav" class="sidebar" :class="{ 'sidebar-open': mobileNavOpen }">
      <div class="brand"><GitBranch :size="17" stroke-width="2.25" aria-hidden="true" /> MCP REST Bridge</div>
      <CommandPalette />
      <div class="nav-groups">
        <div class="nav-label">Servers</div>
        <ul>
          <li><RouterLink to="/servers"><Server :size="15" stroke-width="2" aria-hidden="true" /> Servers</RouterLink></li>
          <li><RouterLink to="/register-server"><Server :size="15" stroke-width="2" aria-hidden="true" /> Add server</RouterLink></li>
          <li><RouterLink to="/bundles"><Boxes :size="15" stroke-width="2" aria-hidden="true" /> Bundles</RouterLink></li>
          <li><RouterLink to="/composites"><Combine :size="15" stroke-width="2" aria-hidden="true" /> Composites</RouterLink></li>
        </ul>
        <div class="nav-label">Access</div>
        <ul>
          <li><RouterLink to="/keys"><KeyRound :size="15" stroke-width="2" aria-hidden="true" /> API keys</RouterLink></li>
          <li><RouterLink to="/policies"><ShieldCheck :size="15" stroke-width="2" aria-hidden="true" /> Policies</RouterLink></li>
          <li><RouterLink to="/consumers"><Users2 :size="15" stroke-width="2" aria-hidden="true" /> Consumers</RouterLink></li>
        </ul>
        <div class="nav-label">Observability</div>
        <ul>
          <li><RouterLink to="/overview"><LayoutDashboard :size="15" stroke-width="2" aria-hidden="true" /> Overview</RouterLink></li>
          <li><RouterLink to="/usage"><Activity :size="15" stroke-width="2" aria-hidden="true" /> Usage</RouterLink></li>
          <li><RouterLink to="/alerts"><BellRing :size="15" stroke-width="2" aria-hidden="true" /> Alerts</RouterLink></li>
          <li><RouterLink to="/schedules"><Clock :size="15" stroke-width="2" aria-hidden="true" /> Schedules</RouterLink></li>
          <li><RouterLink to="/audit-log"><ScrollText :size="15" stroke-width="2" aria-hidden="true" /> Audit log</RouterLink></li>
        </ul>
        <template v-if="state.user?.role === 'admin'">
          <div class="nav-label">Administration</div>
          <ul>
            <li><RouterLink to="/users"><UserCog :size="15" stroke-width="2" aria-hidden="true" /> Users</RouterLink></li>
            <li><RouterLink to="/teams"><UsersRound :size="15" stroke-width="2" aria-hidden="true" /> Teams</RouterLink></li>
            <li><RouterLink to="/config"><Settings2 :size="15" stroke-width="2" aria-hidden="true" /> Config</RouterLink></li>
          </ul>
        </template>
      </div>
      <div class="sidebar-footer">
        <div class="current-user">{{ state.user?.username }} <span class="role">({{ state.user?.role }})</span></div>
        <button type="button" class="link-btn" @click="onLogout">Sign out</button>
      </div>
    </nav>
    <main class="content">
      <RouterView />
    </main>
  </div>
  <div v-else-if="!state.checked" class="loading">Loading…</div>
  <RouterView v-else />
</template>

<style scoped>
.app-shell {
  display: flex;
  min-height: 100vh;
}
.demo-ribbon {
  position: fixed;
  top: var(--space-2);
  left: 50%;
  transform: translateX(-50%);
  z-index: var(--z-banner);
  display: inline-flex;
  align-items: center;
  gap: var(--space-1-5);
  padding: var(--space-1-5) var(--space-3);
  background: var(--ink);
  color: #fff;
  border: 1px solid var(--signal);
  border-radius: var(--radius-pill);
  font-size: var(--text-sm);
  font-weight: 600;
  text-decoration: none;
  box-shadow: var(--shadow-md);
}
.demo-ribbon svg {
  color: var(--signal);
}
.demo-ribbon:hover {
  background: var(--ink-raised);
}
@media (max-width: 768px) {
  .demo-ribbon {
    top: auto;
    bottom: var(--space-2);
  }
}
.loading {
  padding: var(--space-8);
  color: var(--text-muted);
}
.mobile-topbar {
  display: none;
}
.mobile-nav-backdrop {
  display: none;
}
.sidebar {
  width: 232px;
  flex-shrink: 0;
  background: var(--ink);
  color: var(--text-on-dark);
  display: flex;
  flex-direction: column;
  padding: var(--space-4) var(--space-3);
}
.brand {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  font-family: var(--font-display);
  font-weight: 600;
  font-size: var(--text-md);
  color: #fff;
  margin-bottom: var(--space-4);
  padding: 0 var(--space-1-5);
}
.brand svg {
  color: var(--signal);
  flex-shrink: 0;
}
.nav-groups {
  flex: 1;
  margin-top: var(--space-4);
}
.sidebar ul {
  list-style: none;
  padding: 0;
  margin: 0 0 var(--space-3);
}
.sidebar li {
  margin-bottom: 0.1rem;
}
.nav-label {
  color: var(--text-on-dark-muted);
  text-transform: uppercase;
  font-size: var(--text-xs);
  font-weight: 600;
  letter-spacing: 0.06em;
  padding: 0 var(--space-2);
  margin-bottom: var(--space-1-5);
}
.sidebar :deep(a) {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-1-5) var(--space-2);
  border-radius: var(--radius-sm);
  color: var(--text-on-dark-muted);
  text-decoration: none;
  font-size: var(--text-base);
  border-left: 2px solid transparent;
  transition: background-color 0.12s ease, color 0.12s ease;
}
.sidebar :deep(a svg) {
  flex-shrink: 0;
  opacity: 0.75;
}
.sidebar :deep(a:hover) {
  background: rgba(255, 255, 255, 0.05);
  color: var(--text-on-dark);
}
.sidebar :deep(a.router-link-active) {
  background: rgba(0, 169, 154, 0.12);
  color: #fff;
  border-left-color: var(--signal);
}
.sidebar :deep(a.router-link-active svg) {
  opacity: 1;
  color: var(--signal);
}
.sidebar-footer {
  border-top: 1px solid var(--ink-border);
  padding-top: var(--space-3);
  font-size: var(--text-sm);
}
.current-user {
  margin-bottom: var(--space-1-5);
  color: var(--text-on-dark);
}
.role {
  color: var(--text-on-dark-muted);
}
.sidebar-footer .link-btn {
  color: var(--text-on-dark-muted);
}
.content {
  flex: 1;
  padding: var(--space-8) var(--space-10);
  max-width: 1180px;
  min-width: 0;
}

@media (max-width: 768px) {
  .app-shell {
    display: block;
  }
  .mobile-topbar {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    background: var(--ink);
    color: #fff;
    padding: var(--space-3) var(--space-4);
    position: sticky;
    top: 0;
    z-index: var(--z-mobile-topbar);
  }
  .mobile-topbar .brand {
    margin: 0;
    padding: 0;
  }
  .mobile-nav-toggle {
    background: none;
    border: 1px solid var(--ink-border);
    border-radius: var(--radius-sm);
    color: #fff;
    font-size: var(--text-lg);
    line-height: 1;
    padding: var(--space-1-5) var(--space-2);
    cursor: pointer;
  }
  .mobile-nav-backdrop {
    display: block;
    position: fixed;
    inset: 0;
    background: rgba(14, 17, 22, 0.45);
    z-index: var(--z-mobile-backdrop);
  }
  .sidebar {
    position: fixed;
    top: 0;
    left: 0;
    height: 100vh;
    width: min(280px, 82vw);
    z-index: var(--z-mobile-nav);
    transform: translateX(-100%);
    transition: transform 0.2s ease;
    box-shadow: var(--shadow-lg);
  }
  .sidebar.sidebar-open {
    transform: translateX(0);
  }
  .sidebar .brand {
    display: none;
  }
  .content {
    padding: var(--space-5) var(--space-4);
    max-width: 100%;
  }
}
</style>
