<script setup lang="ts">
import { onMounted, computed, ref, watch } from "vue";
import { api } from "../composables/useApi";
import { useResource } from "../composables/useResource";
import type { OverviewStats } from "../types/api";
import StatCard from "@/components/ui/StatCard.vue";
import SegmentedBar from "@/components/charts/SegmentedBar.vue";
import DonutChart from "@/components/charts/DonutChart.vue";
import SignalLoader from "@/components/ui/SignalLoader.vue";
import PageHeader from "@/components/ui/PageHeader.vue";
import EmptyState from "@/components/ui/EmptyState.vue";
import {
  Server,
  Wrench,
  GitBranch,
  ShieldCheck,
  RefreshCw,
  SlidersHorizontal,
  ChevronUp,
  ChevronDown,
  Eye,
  EyeOff,
} from "lucide-vue-next";

const {
  data: stats,
  loading,
  errorMessage,
  load,
} = useResource<OverviewStats | null>(
  () => api.get<OverviewStats>("/admin-api/overview"),
  null,
  "Failed to load overview.",
);

type CardId = "clients" | "tools" | "breakers" | "admins";

const DEFAULT_ORDER: CardId[] = ["clients", "tools", "breakers", "admins"];

const CARDS_STORAGE_KEY = "mcpbridge:overview:cards";

function isCardId(v: unknown): v is CardId {
  return typeof v === "string" && (DEFAULT_ORDER as string[]).includes(v);
}

function readStoredCards(): { order: CardId[]; hidden: CardId[] } {
  try {
    const raw = localStorage.getItem(CARDS_STORAGE_KEY);
    if (!raw) return { order: [...DEFAULT_ORDER], hidden: [] };
    const parsed = JSON.parse(raw) as { order?: unknown; hidden?: unknown };
    const storedOrder = Array.isArray(parsed.order) ? parsed.order.filter(isCardId) : [];
    const missing = DEFAULT_ORDER.filter((id) => !storedOrder.includes(id));
    const order = [...storedOrder, ...missing];
    const hidden = Array.isArray(parsed.hidden) ? parsed.hidden.filter(isCardId) : [];
    return { order, hidden };
  } catch {
    return { order: [...DEFAULT_ORDER], hidden: [] };
  }
}

const initialCards = readStoredCards();
const cardOrder = ref<CardId[]>(initialCards.order);
const hiddenCards = ref<CardId[]>(initialCards.hidden);
const customizing = ref(false);

function persist(): void {
  localStorage.setItem(CARDS_STORAGE_KEY, JSON.stringify({ order: cardOrder.value, hidden: hiddenCards.value }));
}

watch([cardOrder, hiddenCards], persist, { deep: true });

const visibleCardOrder = computed(() =>
  customizing.value ? cardOrder.value : cardOrder.value.filter((id) => !hiddenCards.value.includes(id)),
);

function moveCard(id: CardId, direction: -1 | 1): void {
  const idx = cardOrder.value.indexOf(id);
  const swapWith = idx + direction;
  if (idx < 0 || swapWith < 0 || swapWith >= cardOrder.value.length) return;
  const next = [...cardOrder.value];
  [next[idx], next[swapWith]] = [next[swapWith], next[idx]];
  cardOrder.value = next;
}

function toggleHidden(id: CardId): void {
  hiddenCards.value = hiddenCards.value.includes(id)
    ? hiddenCards.value.filter((c) => c !== id)
    : [...hiddenCards.value, id];
}

const clientSegments = computed(() => {
  if (!stats.value) return [];
  const c = stats.value.clients;
  return [
    { label: "Healthy", value: c.healthy, color: "var(--ok)" },
    { label: "Degraded", value: c.degraded, color: "var(--canary)" },
    { label: "Unreachable", value: c.unreachable, color: "var(--breach)" },
  ].filter((s) => s.value > 0);
});

const breakerSegments = computed(() => {
  if (!stats.value) return [];
  const b = stats.value.circuit_breakers;
  return [
    { label: "Closed", value: b.closed, color: "var(--ok)" },
    { label: "Half-open", value: b.half_open, color: "var(--canary)" },
    { label: "Open", value: b.open, color: "var(--breach)" },
  ].filter((s) => s.value > 0);
});

onMounted(load);
</script>

<template>
  <section>
    <PageHeader title="Overview" subtitle="Snapshot of this bridge instance — use Refresh to update.">
      <button type="button" class="btn-secondary" :aria-pressed="customizing" @click="customizing = !customizing">
        <SlidersHorizontal :size="14" stroke-width="2" aria-hidden="true" />
        {{ customizing ? "Done" : "Customize" }}
      </button>
      <button type="button" class="btn-secondary" :disabled="loading" @click="load">
        <RefreshCw :size="14" stroke-width="2" aria-hidden="true" :class="{ spin: loading }" />
        {{ loading ? "Refreshing…" : "Refresh" }}
      </button>
    </PageHeader>

    <p v-if="errorMessage" class="error" role="alert">{{ errorMessage }}</p>
    <SignalLoader v-if="loading && !stats" />

    <template v-else-if="stats">
      <div class="cards">
        <div
          v-for="id in visibleCardOrder"
          :key="id"
          class="card-slot"
          :class="{ 'is-hidden': customizing && hiddenCards.includes(id) }"
        >
          <StatCard
            v-if="id === 'clients'"
            :icon="Server"
            label="Clients"
            :value="stats.clients.live"
            :detail="`${stats.clients.disabled} disabled`"
          >
            <SegmentedBar v-if="clientSegments.length" :segments="clientSegments" />
          </StatCard>
          <StatCard
            v-else-if="id === 'tools'"
            :icon="Wrench"
            label="Tools"
            :value="stats.tools.total"
            :detail="`${stats.tools.disabled} disabled`"
          />
          <StatCard
            v-else-if="id === 'breakers'"
            :icon="GitBranch"
            label="Breakers open"
            :value="stats.circuit_breakers.open"
            :detail="`${stats.circuit_breakers.half_open} half-open`"
            :tone="stats.circuit_breakers.open > 0 ? 'danger' : 'ok'"
            :pulse="stats.circuit_breakers.open > 0"
          >
            <DonutChart v-if="breakerSegments.length" :segments="breakerSegments" :size="72" :center-label="null" />
          </StatCard>
          <StatCard v-else-if="id === 'admins'" :icon="ShieldCheck" label="Admin users" :value="stats.admin_users" />

          <div v-if="customizing" class="card-slot-controls">
            <button
              type="button"
              class="slot-btn"
              title="Move up"
              :disabled="cardOrder.indexOf(id) === 0"
              @click="moveCard(id, -1)"
            >
              <ChevronUp :size="14" stroke-width="2" aria-hidden="true" />
            </button>
            <button
              type="button"
              class="slot-btn"
              title="Move down"
              :disabled="cardOrder.indexOf(id) === cardOrder.length - 1"
              @click="moveCard(id, 1)"
            >
              <ChevronDown :size="14" stroke-width="2" aria-hidden="true" />
            </button>
            <button
              type="button"
              class="slot-btn"
              :title="hiddenCards.includes(id) ? 'Show card' : 'Hide card'"
              @click="toggleHidden(id)"
            >
              <EyeOff v-if="hiddenCards.includes(id)" :size="14" stroke-width="2" aria-hidden="true" />
              <Eye v-else :size="14" stroke-width="2" aria-hidden="true" />
            </button>
          </div>
        </div>
      </div>

      <p v-if="!customizing && hiddenCards.length" class="hidden-note">
        {{ hiddenCards.length }} card{{ hiddenCards.length === 1 ? "" : "s" }} hidden —
        <button type="button" class="link-btn" @click="customizing = true">Customize to show</button>
      </p>
    </template>

    <EmptyState v-if="stats && stats.clients.live === 0" :icon="Server">
      No servers registered yet. <RouterLink to="/register-server">Add a server</RouterLink> or
      <RouterLink to="/catalog">browse the catalog</RouterLink>.
    </EmptyState>
  </section>
</template>

<style scoped>
/* PageHeader's own recipe covers the title/subtitle; this page still needs its
   two header buttons laid out in a row (PageHeader's .header-actions wrapper
   is rendered by the child component, so reaching it requires :deep()) and its
   icon+label buttons to lay out inline. */
:deep(.header-actions) {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}
.btn-secondary {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
}
.spin {
  animation: spin 0.8s linear infinite;
}
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
.cards {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(14.375rem, 1fr));
  gap: 1rem;
}
.card-slot {
  position: relative;
}
.card-slot.is-hidden {
  opacity: 0.45;
}
.card-slot-controls {
  position: absolute;
  top: var(--space-2);
  right: var(--space-2);
  display: flex;
  align-items: center;
  gap: var(--space-1);
  padding: var(--space-1);
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  box-shadow: var(--shadow-xs);
}
.slot-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 1.375rem;
  height: 1.375rem;
  padding: 0;
  background: none;
  border: none;
  border-radius: var(--radius-sm);
  color: var(--text-muted);
  cursor: pointer;
}
.slot-btn:hover:not(:disabled) {
  background: var(--signal-soft);
  color: var(--signal-strong);
}
.slot-btn:disabled {
  opacity: 0.35;
  cursor: not-allowed;
}
.hidden-note {
  margin: var(--space-3) 0 0;
  font-size: var(--text-sm);
  color: var(--text-muted);
}
.error {
  color: var(--breach);
}
/* EmptyState's own recipe matches this page's padding/colors exactly, but it
   doesn't add top spacing to separate it from the cards grid above it. */
:deep(.empty-state) {
  margin-top: var(--space-4);
}
</style>
