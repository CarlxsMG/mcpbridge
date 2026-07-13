<script setup lang="ts">
import { ref, computed, onMounted, watch } from "vue";
import { useI18n } from "vue-i18n";
import { useRouter } from "vue-router";
import { api } from "@/composables/useApi";
import { useLoadState } from "@/composables/useResource";
import { prettyJson } from "@/utils/format";
import type { StoredSpan } from "@/types/api";
import { Waypoints } from "lucide-vue-next";
import ListLayout from "@/components/ui/ListLayout.vue";
import EmptyState from "@/components/ui/EmptyState.vue";

const props = defineProps<{ traceId: string }>();
const router = useRouter();
const { t } = useI18n({ useScope: "global" });

const spans = ref<StoredSpan[] | null>(null);
const { loading, errorMessage, run: runDetail } = useLoadState(t("pages.traces.errors.detail_load_failed"));

async function loadDetail() {
  spans.value = null;
  const result = await runDetail(() =>
    api.get<{ traceId: string; spans: StoredSpan[] }>(`/admin-api/traces/${encodeURIComponent(props.traceId)}`),
  );
  if (result !== undefined) spans.value = result.spans;
}

onMounted(loadDetail);
watch(() => props.traceId, loadDetail);

function backToList() {
  router.push({ name: "traces" });
}

const waterfall = computed(() => {
  const rows = spans.value ?? [];
  if (rows.length === 0) return { rows: [], totalMs: 0 };
  const traceStart = Math.min(...rows.map((s) => s.startMs));
  const traceEnd = Math.max(...rows.map((s) => s.endMs));
  const totalMs = Math.max(traceEnd - traceStart, 1);
  return {
    totalMs,
    rows: rows.map((s) => ({
      span: s,
      leftPct: ((s.startMs - traceStart) / totalMs) * 100,
      widthPct: Math.max(((s.endMs - s.startMs) / totalMs) * 100, 0.5),
      durationMs: s.endMs - s.startMs,
    })),
  };
});
</script>

<template>
  <section>
    <button type="button" class="link-btn back-link" @click="backToList">
      &larr; {{ t("pages.traces.back_to_list") }}
    </button>
    <ListLayout :loading="loading" :error="errorMessage" :empty="waterfall.rows.length === 0">
      <template #empty>
        <EmptyState :icon="Waypoints">{{ t("pages.traces.detail_not_found") }}</EmptyState>
      </template>

      <div class="waterfall-card">
        <h2>{{ t("pages.traces.detail_title", { id: traceId }) }}</h2>
        <div class="waterfall">
          <div v-for="row in waterfall.rows" :key="row.span.id" class="waterfall-row">
            <div class="waterfall-label" :title="row.span.name">{{ row.span.name }}</div>
            <div class="waterfall-track">
              <div
                class="waterfall-bar"
                :class="{ hot: row.span.statusCode === 2 }"
                :style="{ left: `${row.leftPct}%`, width: `${row.widthPct}%` }"
                :title="`${row.span.name} — ${row.durationMs}ms`"
              ></div>
            </div>
            <div class="waterfall-duration">{{ row.durationMs }}ms</div>
          </div>
        </div>
        <details class="attrs">
          <summary>{{ t("pages.traces.detail_attributes_summary") }}</summary>
          <pre>{{ prettyJson(waterfall.rows[waterfall.rows.length - 1]?.span.attributes ?? {}) }}</pre>
        </details>
      </div>
    </ListLayout>
  </section>
</template>

<style scoped>
.back-link {
  display: inline-block;
  margin-bottom: 1rem;
}
.waterfall-card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-xs);
  padding: 1.25rem;
}
.waterfall-card h2 {
  margin-top: 0;
  font-size: 0.95rem;
  font-family: var(--font-mono);
  word-break: break-all;
}
.waterfall {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}
.waterfall-row {
  display: grid;
  grid-template-columns: 12.5rem 1fr 4.375rem;
  align-items: center;
  gap: 0.75rem;
}
.waterfall-label {
  font-size: 0.82rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.waterfall-track {
  position: relative;
  height: 1.25rem;
  background: var(--surface-sunken);
  border-radius: var(--radius-sm);
}
.waterfall-bar {
  position: absolute;
  top: 0;
  height: 100%;
  background: var(--signal);
  border-radius: var(--radius-sm);
  min-width: 2px;
}
.waterfall-bar.hot {
  background: var(--breach);
}
.waterfall-duration {
  font-size: 0.78rem;
  color: var(--text-muted);
  text-align: right;
  font-family: var(--font-mono);
}
.attrs {
  margin-top: 1rem;
  font-size: 0.8rem;
}
.attrs pre {
  background: var(--surface-sunken);
  padding: 0.6rem;
  border-radius: var(--radius-sm);
  overflow-x: auto;
}
.link-btn {
  background: none;
  border: none;
  cursor: pointer;
  font-size: 0.85rem;
  padding: 0;
  color: var(--signal-strong);
}
</style>
