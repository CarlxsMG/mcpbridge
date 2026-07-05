<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, nextTick, watch, type Component } from "vue";
import { useRouter } from "vue-router";
import { Search, Server, Boxes, KeyRound, CornerDownLeft } from "lucide-vue-next";
import { api } from "@/composables/useApi";
import { useCommandPalette } from "@/composables/useCommandPalette";
import { useFocusTrap } from "@/composables/useFocusTrap";
import { navEntries } from "../navigation";
import type { ClientSummary, BundleSummary, McpApiKey, PaginatedResult } from "@/types/api";

interface Entry {
  id: string;
  label: string;
  hint: string;
  group: string;
  icon: Component;
  to: string;
}

// One flat "Pages" bucket for every static route, regardless of which sidebar
// section (if any) it belongs to in App.vue — distinct from the live-fetched
// "Servers"/"Bundles"/"API keys" groups below.
const PAGES: Entry[] = navEntries.map((entry) => ({
  id: `p-${entry.name}`,
  label: entry.label,
  hint: entry.hint,
  group: "Pages",
  icon: entry.icon,
  to: entry.path,
}));

const router = useRouter();
const { paletteOpen: open } = useCommandPalette();
const query = ref("");
const activeIndex = ref(0);
const liveEntries = ref<Entry[]>([]);
const loadedLive = ref(false);
const inputEl = ref<HTMLInputElement | null>(null);
const listEl = ref<HTMLDivElement | null>(null);
const panelEl = ref<HTMLDivElement | null>(null);
const justOpened = ref(false);
const { onKeydown: trapKeydown } = useFocusTrap(panelEl);

function onGlobalKeydown(e: KeyboardEvent) {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
    e.preventDefault();
    if (open.value) {
      close();
    } else {
      show();
    }
  } else if (e.key === "Escape" && open.value) {
    close();
  }
}

async function show() {
  open.value = true;
  query.value = "";
  activeIndex.value = 0;
  justOpened.value = true;
  setTimeout(() => {
    justOpened.value = false;
  }, 700);
  await nextTick();
  inputEl.value?.focus();
  if (!loadedLive.value) void loadLive();
}

function close() {
  open.value = false;
}

async function loadLive() {
  loadedLive.value = true;
  try {
    const [clients, bundles, keys] = await Promise.all([
      api
        .get<PaginatedResult<ClientSummary>>("/admin-api/clients?limit=25")
        .catch(() => ({ items: [] as ClientSummary[] })),
      api.get<{ items: BundleSummary[] }>("/admin-api/bundles").catch(() => ({ items: [] as BundleSummary[] })),
      api.get<{ items: McpApiKey[] }>("/admin-api/mcp-keys").catch(() => ({ items: [] as McpApiKey[] })),
    ]);
    liveEntries.value = [
      ...clients.items.map((c) => ({
        id: `c-${c.name}`,
        label: c.name,
        hint: c.healthUrl,
        group: "Servers",
        icon: Server,
        to: `/servers/${encodeURIComponent(c.name)}`,
      })),
      ...bundles.items.map((b) => ({
        id: `b-${b.name}`,
        label: b.name,
        hint: `${b.toolsCount} tool(s)`,
        group: "Bundles",
        icon: Boxes,
        to: `/bundles/${encodeURIComponent(b.name)}`,
      })),
      ...keys.items.map((k) => ({
        id: `k-${k.id}`,
        label: k.label,
        hint: k.keyPrefix,
        group: "API keys",
        icon: KeyRound,
        to: "/keys",
      })),
    ];
  } catch {
    // Best-effort: live entries are a bonus, page search still works if this fails.
  }
}

function score(label: string, q: string): number {
  const l = label.toLowerCase();
  if (l === q) return 100;
  if (l.startsWith(q)) return 80;
  if (l.includes(q)) return 60;
  // subsequence match (e.g. "pysc" -> "payments-svc")
  let qi = 0;
  for (let i = 0; i < l.length && qi < q.length; i++) if (l[i] === q[qi]) qi++;
  return qi === q.length ? 20 : -1;
}

const results = computed<Entry[]>(() => {
  const q = query.value.trim().toLowerCase();
  const all = [...PAGES, ...liveEntries.value];
  if (!q) return PAGES.slice(0, 8);
  return all
    .map((e) => ({ e, s: score(e.label, q) }))
    .filter((r) => r.s >= 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, 20)
    .map((r) => r.e);
});

const grouped = computed(() => {
  const groups = new Map<string, Entry[]>();
  for (const e of results.value) {
    if (!groups.has(e.group)) groups.set(e.group, []);
    groups.get(e.group)!.push(e);
  }
  return [...groups.entries()];
});

watch(results, () => {
  activeIndex.value = 0;
});

function go(entry: Entry) {
  close();
  router.push(entry.to);
}

function onKeydown(e: KeyboardEvent) {
  trapKeydown(e);
  if (e.key === "ArrowDown") {
    e.preventDefault();
    activeIndex.value = Math.min(activeIndex.value + 1, results.value.length - 1);
    scrollActiveIntoView();
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    activeIndex.value = Math.max(activeIndex.value - 1, 0);
    scrollActiveIntoView();
  } else if (e.key === "Enter") {
    e.preventDefault();
    const entry = results.value[activeIndex.value];
    if (entry) go(entry);
  }
}

function scrollActiveIntoView() {
  nextTick(() => {
    listEl.value?.querySelector(".cmd-item.active")?.scrollIntoView({ block: "nearest" });
  });
}

onMounted(() => window.addEventListener("keydown", onGlobalKeydown));
onUnmounted(() => window.removeEventListener("keydown", onGlobalKeydown));
</script>

<template>
  <button type="button" class="cmd-trigger" aria-label="Open command palette" @click="show">
    <Search :size="14" stroke-width="2" aria-hidden="true" />
    <span>Jump to…</span>
    <kbd>⌘K</kbd>
  </button>

  <div v-if="open" class="cmd-overlay" @click.self="close" @keydown="onKeydown">
    <div ref="panelEl" class="cmd-panel" role="dialog" aria-modal="true" aria-label="Command palette">
      <div class="sweep-line" :class="{ 'is-sweeping': justOpened }" aria-hidden="true"></div>
      <div class="cmd-input-row">
        <Search :size="16" stroke-width="2" aria-hidden="true" class="cmd-input-icon" />
        <input
          ref="inputEl"
          v-model="query"
          type="text"
          placeholder="Search servers, bundles, keys, pages…"
          aria-label="Search"
        />
        <kbd>Esc</kbd>
      </div>
      <div ref="listEl" class="cmd-results">
        <template v-if="results.length">
          <div v-for="[group, items] in grouped" :key="group" class="cmd-group">
            <p class="cmd-group-label">{{ group }}</p>
            <button
              v-for="entry in items"
              :key="entry.id"
              type="button"
              class="cmd-item"
              :class="{ active: results[activeIndex]?.id === entry.id }"
              @mouseenter="activeIndex = results.indexOf(entry)"
              @click="go(entry)"
            >
              <component :is="entry.icon" :size="16" stroke-width="2" aria-hidden="true" />
              <span class="cmd-item-label">{{ entry.label }}</span>
              <span class="cmd-item-hint">{{ entry.hint }}</span>
              <CornerDownLeft :size="13" stroke-width="2" class="cmd-item-enter" aria-hidden="true" />
            </button>
          </div>
        </template>
        <p v-else class="cmd-empty">No matches for "{{ query }}".</p>
      </div>
    </div>
  </div>
</template>

<style scoped>
.cmd-trigger {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  width: 100%;
  background: rgba(255, 255, 255, 0.06);
  border: 1px solid var(--ink-border);
  color: var(--text-on-dark-muted);
  border-radius: var(--radius-sm);
  padding: var(--space-2);
  font-size: var(--text-sm);
  cursor: pointer;
  text-align: left;
  transition:
    background-color 0.12s ease,
    border-color 0.12s ease;
}
.cmd-trigger:hover {
  background: rgba(255, 255, 255, 0.1);
  border-color: #3a4152;
}
.cmd-trigger span {
  flex: 1;
}
.cmd-trigger kbd {
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  background: rgba(255, 255, 255, 0.08);
  border-radius: 4px;
  padding: 0.1em 0.4em;
}

.cmd-overlay {
  position: fixed;
  inset: 0;
  background: var(--overlay-backdrop);
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding-top: 12vh;
  z-index: var(--z-command-palette);
}
.cmd-panel {
  position: relative;
  width: 100%;
  max-width: 35rem;
  max-height: 60vh;
  background: var(--surface);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-lg);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.sweep-line {
  position: absolute;
  top: 0;
  left: -40%;
  width: 40%;
  height: 2px;
  background: linear-gradient(90deg, transparent, var(--signal), transparent);
  opacity: 0;
  pointer-events: none;
}
.sweep-line.is-sweeping {
  animation: cmd-sweep 0.7s ease-out;
}
@keyframes cmd-sweep {
  0% {
    left: -40%;
    opacity: 0;
  }
  15% {
    opacity: 1;
  }
  100% {
    left: 100%;
    opacity: 0;
  }
}
.cmd-input-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-4);
  border-bottom: 1px solid var(--border);
}
.cmd-input-icon {
  color: var(--text-muted);
  flex-shrink: 0;
}
.cmd-input-row input {
  flex: 1;
  border: none;
  outline: none;
  font-size: var(--text-md);
  font-family: var(--font-body);
  color: var(--text-primary);
  background: transparent;
}
.cmd-input-row kbd {
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  color: var(--text-muted);
  background: var(--surface-sunken);
  border-radius: 4px;
  padding: 0.15em 0.45em;
}

.cmd-results {
  overflow-y: auto;
  padding: var(--space-2);
}
.cmd-group-label {
  font-size: var(--text-xs);
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--text-muted);
  margin: var(--space-2) var(--space-2) var(--space-1);
}
.cmd-item {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  width: 100%;
  padding: var(--space-2);
  border: none;
  background: none;
  border-radius: var(--radius-sm);
  cursor: pointer;
  text-align: left;
  color: var(--text-primary);
  font-size: var(--text-base);
}
.cmd-item.active {
  background: var(--signal-soft);
}
.cmd-item svg:first-child {
  color: var(--text-muted);
  flex-shrink: 0;
}
.cmd-item.active svg:first-child {
  color: var(--signal-strong);
}
.cmd-item-label {
  font-weight: 500;
  white-space: nowrap;
}
.cmd-item-hint {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-muted);
  font-size: var(--text-sm);
  font-family: var(--font-mono);
}
.cmd-item-enter {
  color: var(--text-muted);
  opacity: 0;
  flex-shrink: 0;
}
.cmd-item.active .cmd-item-enter {
  opacity: 1;
}
.cmd-empty {
  padding: var(--space-6);
  text-align: center;
  color: var(--text-muted);
  font-size: var(--text-base);
  margin: 0;
}
</style>
