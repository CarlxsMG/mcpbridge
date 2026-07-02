<script setup lang="ts">
import { ref, computed, onMounted } from "vue";
import { api, ApiError } from "../composables/useApi";
import type { ToolListItem, BundleToolRef } from "../types/api";
import { Search } from "lucide-vue-next";

const props = defineProps<{ modelValue: BundleToolRef[] }>();
const emit = defineEmits<{ "update:modelValue": [value: BundleToolRef[]] }>();

const allTools = ref<ToolListItem[]>([]);
const loading = ref(false);
const errorMessage = ref("");
const search = ref("");
const showSelectedOnly = ref(false);

async function load() {
  loading.value = true;
  errorMessage.value = "";
  try {
    const res = await api.get<{ items: ToolListItem[] }>("/admin-api/tools");
    allTools.value = res.items;
  } catch (err) {
    errorMessage.value = err instanceof ApiError ? err.message : "Failed to load tools.";
  } finally {
    loading.value = false;
  }
}
onMounted(load);

function refKey(ref: { client: string; tool: string }): string {
  return `${ref.client}__${ref.tool}`;
}

const selectedKeys = computed(() => new Set(props.modelValue.map(refKey)));

function isSelected(item: ToolListItem): boolean {
  return selectedKeys.value.has(refKey(item));
}

function toggle(item: ToolListItem) {
  if (isSelected(item)) {
    emit("update:modelValue", props.modelValue.filter((t) => refKey(t) !== refKey(item)));
  } else {
    emit("update:modelValue", [...props.modelValue, { client: item.client, tool: item.tool }]);
  }
}

function selectAllInGroup(tools: ToolListItem[]) {
  const additions = tools.filter((t) => !isSelected(t)).map((t) => ({ client: t.client, tool: t.tool }));
  if (additions.length) emit("update:modelValue", [...props.modelValue, ...additions]);
}

const filteredTools = computed(() => {
  const q = search.value.trim().toLowerCase();
  let tools = allTools.value;
  if (showSelectedOnly.value) tools = tools.filter((t) => isSelected(t));
  if (!q) return tools;
  return tools.filter(
    (t) => t.client.toLowerCase().includes(q) || t.tool.toLowerCase().includes(q) || t.description.toLowerCase().includes(q)
  );
});

const groupedByClient = computed(() => {
  const groups = new Map<string, ToolListItem[]>();
  for (const tool of filteredTools.value) {
    if (!groups.has(tool.client)) groups.set(tool.client, []);
    groups.get(tool.client)!.push(tool);
  }
  return Array.from(groups.entries()).sort(([a], [b]) => a.localeCompare(b));
});
</script>

<template>
  <div class="tool-picker">
    <div class="picker-header">
      <label for="tool-filter" class="visually-hidden">Filter tools</label>
      <div class="search-input">
        <Search :size="15" stroke-width="2" aria-hidden="true" />
        <input id="tool-filter" v-model="search" type="search" placeholder="Filter by client, tool, or description…" aria-label="Filter tools" />
      </div>
      <label class="show-selected">
        <input type="checkbox" v-model="showSelectedOnly" />
        Show selected only
      </label>
      <span class="selected-count">{{ modelValue.length }} selected</span>
    </div>

    <p v-if="errorMessage" class="error" role="alert">{{ errorMessage }}</p>
    <div v-if="loading" class="loading">Loading tools…</div>

    <template v-else-if="allTools.length === 0">
      <p class="empty-state">No tools available yet — register a client first.</p>
    </template>
    <template v-else-if="groupedByClient.length === 0">
      <p class="empty-state">No tools match "{{ search }}".</p>
    </template>

    <details v-for="[clientName, tools] in groupedByClient" :key="clientName" class="client-group" open>
      <summary>
        {{ clientName }}
        <span v-if="!tools[0].clientEnabled" class="hint-tag">client disabled</span>
        <button type="button" class="link-btn select-all-btn" @click.stop.prevent="selectAllInGroup(tools)">Select all</button>
      </summary>
      <ul>
        <li v-for="tool in tools" :key="tool.tool">
          <label>
            <input type="checkbox" :checked="isSelected(tool)" @change="toggle(tool)" />
            <span class="tool-name">{{ tool.tool }}</span>
            <span v-if="!tool.enabled" class="hint-tag">disabled</span>
            <span class="tool-desc" :title="tool.description">{{ tool.description }}</span>
          </label>
        </li>
      </ul>
    </details>
  </div>
</template>

<style scoped>
.tool-picker {
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: var(--surface);
  padding: 0.85rem;
  max-height: 360px;
  overflow-y: auto;
}
.picker-header {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  margin-bottom: 0.6rem;
  position: sticky;
  top: -0.85rem;
  background: var(--surface);
  padding-top: 0.1rem;
}
.picker-header .search-input {
  flex: 1;
}
.search-input {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-sm);
  padding: 0 0.6rem;
  background: var(--surface);
}
.search-input svg {
  color: var(--text-muted);
  flex-shrink: 0;
}
.search-input input {
  flex: 1;
  width: 100%;
  padding: 0.45rem 0;
  border: none;
  outline: none;
  background: transparent;
  font-family: var(--font-body);
  font-size: 0.9rem;
}
.visually-hidden {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}
.show-selected {
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
  font-size: 0.8rem;
  color: var(--text-secondary);
  white-space: nowrap;
  cursor: pointer;
}
.selected-count {
  font-size: 0.8rem;
  color: var(--text-secondary);
  white-space: nowrap;
}
.client-group {
  border-bottom: 1px solid var(--border);
  padding: 0.4rem 0;
}
.client-group:last-child {
  border-bottom: none;
}
.client-group summary {
  cursor: pointer;
  font-weight: 600;
  font-size: 0.9rem;
  padding: 0.2rem 0;
}
.select-all-btn {
  margin-left: 0.6rem;
  font-size: 0.78rem;
  font-weight: 400;
}
.client-group ul {
  list-style: none;
  margin: 0.3rem 0 0;
  padding: 0;
}
.client-group li {
  padding: 0.2rem 0 0.2rem 1.1rem;
}
.client-group label {
  display: flex;
  align-items: baseline;
  gap: 0.5rem;
  cursor: pointer;
  font-size: 0.87rem;
}
.tool-name {
  font-weight: 500;
}
.tool-desc {
  color: var(--text-secondary);
  font-size: 0.8rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.hint-tag {
  font-size: 0.72rem;
  color: var(--canary);
  background: var(--canary-soft);
  padding: 0.05em 0.45em;
  border-radius: var(--radius-pill);
}
.empty-state {
  padding: 1rem;
  text-align: center;
  color: var(--text-secondary);
}
.loading {
  color: var(--text-muted);
  padding: 0.5rem 0;
}
.error {
  color: var(--breach);
}
</style>
