<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { useRouter } from "vue-router";
import { useAuth } from "@/composables/useAuth";
import { useLiveSignal } from "@/composables/useLiveSignal";
import { useNavEntries } from "@/composables/useNavEntries";
import CommandPalette from "@/components/CommandPalette.vue";
import { ChevronRight, Activity } from "lucide-vue-next";

defineProps<{ navOpen: boolean }>();

const router = useRouter();
const { state, logout } = useAuth();
const { isLive } = useLiveSignal();
const { t } = useI18n({ useScope: "global" });

const { entries: navItems, groupLabel } = useNavEntries({ role: state.user?.role });

// Group ordering drives the visual sidebar order. Hard-coded (kept in sync
// with the group header translations through NAV_GROUP_KEYS).
const NAV_GROUP_ORDER = ["Servers", "Access", "Observability", "Administration"] as const;

const groupedNav = computed(() =>
  NAV_GROUP_ORDER.map((group) => ({
    group,
    label: groupLabel(group),
    entries: navItems.value.filter((e) => e.group === group),
  })).filter((g) => g.entries.length > 0),
);

const AVATAR_TONES: Array<{ soft: string; strong: string }> = [
  { soft: "var(--signal-soft)", strong: "var(--signal-strong)" },
  { soft: "var(--canary-soft)", strong: "var(--canary)" },
  { soft: "var(--ok-soft)", strong: "var(--ok)" },
  { soft: "var(--kind-mcp-soft)", strong: "var(--kind-mcp-text)" },
];

function hashString(value: string): number {
  let hash = 0;
  for (let i = 0; i < value.length; i++) {
    hash += value.charCodeAt(i);
  }
  return hash;
}

const userInitials = computed(() => (state.user?.username ?? "").slice(0, 2).toUpperCase());
const avatarTone = computed(() => AVATAR_TONES[hashString(state.user?.username ?? "") % AVATAR_TONES.length]);

async function onLogout() {
  await logout();
  await router.push("/login");
}
</script>

<template>
  <nav id="sidebar-nav" class="sidebar" :class="{ 'sidebar-open': navOpen }">
    <div class="brand">
      <Activity
        class="brand-icon"
        :class="{ 'is-live': isLive }"
        :size="17"
        stroke-width="2.25"
        :title="isLive ? t('sidebar.brand_live_title') : t('sidebar.brand_idle_title')"
        aria-hidden="true"
      />
      MCP REST Bridge
    </div>
    <CommandPalette />
    <div class="nav-groups">
      <template v-for="g in groupedNav" :key="g.group">
        <div class="nav-label">{{ g.label }}</div>
        <ul>
          <li v-for="entry in g.entries" :key="entry.path">
            <RouterLink :to="entry.path"
              ><component :is="entry.icon" :size="15" stroke-width="2" aria-hidden="true" /> {{ entry.label }}
            </RouterLink>
          </li>
        </ul>
      </template>
    </div>
    <div class="sidebar-footer">
      <RouterLink
        to="/account"
        class="current-user"
        :title="t('sidebar.account_title')"
        :aria-label="`${t('sidebar.account_title')} — ${state.user?.username} (${state.user?.role})`"
      >
        <span
          class="user-avatar"
          :style="{ background: avatarTone.soft, color: avatarTone.strong }"
          aria-hidden="true"
          >{{ userInitials }}</span
        >
        <span class="current-user-id"
          >{{ state.user?.username }} <span class="role">({{ state.user?.role }})</span></span
        >
        <ChevronRight class="current-user-chevron" :size="14" stroke-width="2" aria-hidden="true" />
      </RouterLink>
      <button type="button" class="link-btn" @click="onLogout">{{ t("sidebar.sign_out") }}</button>
    </div>
  </nav>
</template>

<style scoped>
.sidebar {
  width: 14.5rem; /* rem, not px: must grow with the root font-size ramp on TV-class screens */
  flex-shrink: 0;
  background: var(--ink);
  color: var(--text-on-dark);
  display: flex;
  flex-direction: column;
  padding: var(--space-4) var(--space-3);
  overflow: hidden;
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
.brand-icon {
  color: var(--text-on-dark-muted);
  flex-shrink: 0;
}
.brand-icon.is-live {
  color: var(--signal);
}
.nav-groups {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  margin-top: var(--space-4);
  padding-right: 1rem;
  scrollbar-color: var(--ink-border) transparent;
}
.nav-groups::-webkit-scrollbar-thumb {
  background-color: var(--ink-border);
}
.nav-groups::-webkit-scrollbar-thumb:hover {
  background-color: var(--text-on-dark-muted);
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
  transition:
    background-color 0.12s ease,
    color 0.12s ease;
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
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin-bottom: var(--space-1-5);
  color: var(--text-on-dark);
  font-size: var(--text-sm);
  text-decoration: none;
}
.current-user-id {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.current-user .current-user-chevron {
  flex-shrink: 0;
  opacity: 0.45;
  transition: opacity 0.12s ease;
}
.current-user:hover .current-user-chevron,
.current-user:focus-visible .current-user-chevron {
  opacity: 0.85;
}
.user-avatar {
  width: 1.75rem;
  height: 1.75rem;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-weight: 600;
  font-size: 0.7rem;
  flex-shrink: 0;
}
.role {
  color: var(--text-on-dark-muted);
}
.sidebar-footer .link-btn {
  color: var(--text-on-dark-muted);
  margin-left: 0.5rem;
}

@media (max-width: 768px) {
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
}
</style>
