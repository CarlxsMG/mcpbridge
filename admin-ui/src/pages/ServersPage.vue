<script setup lang="ts">
import { ref, computed, onMounted } from "vue";
import { useI18n } from "vue-i18n";
import { useRoute } from "vue-router";
import { api } from "@/composables/useApi";
import { useConfirmAction } from "@/composables/useConfirmAction";
import { useCursorPagination } from "@/composables/useCursorPagination";
import { useOptimisticToggle } from "@/composables/useOptimisticToggle";
import { useQueryFilters } from "@/composables/useQueryFilters";
import { toErrorMessage } from "@/utils/errors";
import { clientPath } from "@/utils/apiPaths";
import type { ClientSummary, PaginatedResult, TagSummary, TagToolRef } from "@/types/api";
import StatusBadge from "@/components/ui/StatusBadge.vue";
import ConfirmDialog from "@/components/ui/ConfirmDialog.vue";
import SignalLoader from "@/components/ui/SignalLoader.vue";
import OnboardingChecklist from "@/components/OnboardingChecklist.vue";
import PageHeader from "@/components/ui/PageHeader.vue";
import ListLayout from "@/components/ui/ListLayout.vue";
import TableCard from "@/components/ui/TableCard.vue";
import EmptyState from "@/components/ui/EmptyState.vue";
import SearchInput from "@/components/ui/SearchInput.vue";
import PaginationBar from "@/components/ui/PaginationBar.vue";
import TogglePill from "@/components/ui/TogglePill.vue";
import SelectMenu from "@/components/ui/SelectMenu.vue";
import HoverPreview from "@/components/ui/HoverPreview.vue";
import KindBadge from "@/components/ui/KindBadge.vue";
import FieldError from "@/components/ui/FieldError.vue";
import { Server, Tags, ChevronRight } from "lucide-vue-next";
import { i18n } from "../i18n";

const { t } = useI18n({ useScope: "global" });
function tk(key: string): string {
  return (i18n.global.t as (k: string) => string)(key);
}

const ENABLED_FILTER_OPTIONS = computed(() => [
  { value: "", label: tk("pages.servers.filter.all_states") },
  { value: "true", label: tk("pages.servers.filter.enabled_only") },
  { value: "false", label: tk("pages.servers.filter.disabled_only") },
]);

const route = useRoute();

const { rowError, toggle } = useOptimisticToggle<ClientSummary>((c) => c.name, tk("errors.update_failed"));

const { filters, syncUrl } = useQueryFilters(["q", "enabled"] as const);
const q = filters.q;
const enabledFilter = filters.enabled;
const initialCursor = typeof route.query.cursor === "string" ? route.query.cursor : undefined;

function buildQuery(cursor?: string): string {
  const params = new URLSearchParams();
  if (q.value) params.set("q", q.value);
  if (enabledFilter.value) params.set("enabled", enabledFilter.value);
  if (cursor) params.set("cursor", cursor);
  params.set("limit", "50");
  return params.toString();
}

const {
  items,
  loading,
  errorMessage,
  load,
  reset,
  next: nextPage,
  prev: prevPage,
  hasPrev,
  hasNext,
} = useCursorPagination<ClientSummary>(
  (cursor) => api.get<PaginatedResult<ClientSummary>>(`/admin-api/clients?${buildQuery(cursor)}`),
  {
    initialCursor,
    fallbackMessage: tk("errors.load_servers_failed"),
    onCursorChange: (cursor) => syncUrl({ cursor }),
  },
);

// debounce-free: filters apply on explicit submit here, not on every keystroke
function applyFilters() {
  reset();
  syncUrl();
  load();
}

const {
  pending: pendingDisable,
  request: requestDisableConfirm,
  cancel: cancelDisable,
  confirm: confirmDisableAction,
} = useConfirmAction<ClientSummary>();
const selected = ref<Set<string>>(new Set());
const bulkPending = ref(false);
const bulkError = ref("");
const {
  pending: pendingBulkDisable,
  request: requestBulkDisableConfirm,
  cancel: cancelBulkDisable,
  confirm: confirmBulkDisableAction,
} = useConfirmAction<true>();

function toggleSelected(name: string) {
  if (selected.value.has(name)) selected.value.delete(name);
  else selected.value.add(name);
  // Trigger reactivity — Set mutation alone doesn't notify Vue's ref.
  selected.value = new Set(selected.value);
}

function toggleSelectAll() {
  if (selected.value.size === items.value.length) {
    selected.value = new Set();
  } else {
    selected.value = new Set(items.value.map((c) => c.name));
  }
}

async function runBulk(enabled: boolean) {
  bulkError.value = "";
  bulkPending.value = true;
  try {
    await api.patch("/admin-api/clients", { names: Array.from(selected.value), enabled });
    selected.value = new Set();
    reset();
    await load();
  } catch (err) {
    bulkError.value = toErrorMessage(err, t("pages.servers.errors.bulk_update_failed"));
  } finally {
    bulkPending.value = false;
  }
}

function requestBulkDisable() {
  requestBulkDisableConfirm(true);
}

function confirmBulkDisable() {
  return confirmBulkDisableAction(async () => {
    await runBulk(false);
  });
}

async function toggleEnabled(client: ClientSummary) {
  await toggle(client, "enabled", (next) => api.patch(clientPath(client.name), { enabled: next }));
}

function requestDisable(client: ClientSummary) {
  if (client.toolsCount === 0) {
    toggleEnabled(client);
    return;
  }
  requestDisableConfirm(client);
}

function confirmDisable() {
  return confirmDisableAction(async (client) => {
    await toggleEnabled(client);
  });
}

function onToggleClick(client: ClientSummary) {
  if (client.enabled) {
    requestDisable(client);
  } else {
    toggleEnabled(client);
  }
}

const showTagBrowser = ref(false);
const tags = ref<TagSummary[]>([]);
const tagsLoading = ref(false);
const tagsError = ref("");
const selectedTag = ref<string | null>(null);
const tagTools = ref<TagToolRef[]>([]);
const tagToolsLoading = ref(false);
const tagToolsError = ref("");

async function loadTags() {
  tagsLoading.value = true;
  tagsError.value = "";
  try {
    tags.value = (await api.get<{ items: TagSummary[] }>("/admin-api/tags")).items;
  } catch (err) {
    tagsError.value = toErrorMessage(err, t("pages.servers.errors.tags_load_failed"));
  } finally {
    tagsLoading.value = false;
  }
}

async function selectTag(tag: string) {
  if (selectedTag.value === tag) {
    selectedTag.value = null;
    tagTools.value = [];
    return;
  }
  selectedTag.value = tag;
  tagToolsLoading.value = true;
  tagToolsError.value = "";
  try {
    tagTools.value = (await api.get<{ items: TagToolRef[] }>(`/admin-api/tags/${encodeURIComponent(tag)}/tools`)).items;
  } catch (err) {
    tagToolsError.value = toErrorMessage(err, t("pages.servers.errors.tag_tools_load_failed"));
  } finally {
    tagToolsLoading.value = false;
  }
}

function toggleTagBrowser() {
  showTagBrowser.value = !showTagBrowser.value;
  if (showTagBrowser.value && tags.value.length === 0 && !tagsLoading.value) loadTags();
}

onMounted(() => load());
</script>

<template>
  <section class="list-shell">
    <PageHeader :title="t('pages.servers.title')" :subtitle="t('pages.servers.subtitle')">
      <button type="button" class="btn-secondary" :aria-expanded="showTagBrowser" @click="toggleTagBrowser">
        <Tags :size="15" stroke-width="2" aria-hidden="true" /> {{ t("pages.servers.browse_by_tag") }}
      </button>
      <RouterLink to="/register-server" class="btn-primary">{{ t("pages.servers.add_server") }}</RouterLink>
    </PageHeader>

    <OnboardingChecklist :has-servers="items.length > 0" />

    <div v-if="showTagBrowser" class="tag-browser">
      <SignalLoader v-if="tagsLoading" />
      <FieldError v-else-if="tagsError" :message="tagsError" />
      <p v-else-if="tags.length === 0" class="subtitle">
        {{ t("pages.servers.empty.tags") }}
      </p>
      <template v-else>
        <div class="tag-cloud">
          <button
            v-for="tag in tags"
            :key="tag.tag"
            type="button"
            class="tag-filter-chip"
            :class="{ 'tag-filter-chip-active': selectedTag === tag.tag }"
            :aria-pressed="selectedTag === tag.tag"
            @click="selectTag(tag.tag)"
          >
            {{ tag.tag }} <span class="tag-count">{{ tag.count }}</span>
          </button>
        </div>
        <div v-if="selectedTag" class="tag-tools">
          <SignalLoader v-if="tagToolsLoading" />
          <FieldError v-else-if="tagToolsError" :message="tagToolsError" />
          <p v-else-if="tagTools.length === 0" class="subtitle">
            {{ t("pages.servers.empty.tag_tools", { tag: selectedTag }) }}
          </p>
          <ul v-else class="tag-tools-list">
            <li v-for="toolRef in tagTools" :key="`${toolRef.client}__${toolRef.tool}`">
              <ChevronRight :size="13" stroke-width="2" class="tag-tool-arrow" aria-hidden="true" />
              <RouterLink :to="`/servers/${encodeURIComponent(toolRef.client)}`">{{ toolRef.client }}</RouterLink>
              <span class="tag-tool-sep">/</span>
              <code>{{ toolRef.tool }}</code>
            </li>
          </ul>
        </div>
      </template>
    </div>

    <form class="filters" @submit.prevent="applyFilters">
      <div class="field">
        <label for="d-search">{{ t("common.search") }}</label>
        <SearchInput v-model="q" :placeholder="t('pages.servers.search_placeholder')" />
      </div>
      <div class="field">
        <label for="d-state">{{ t("pages.servers.state_label") }}</label>
        <SelectMenu id="d-state" v-model="enabledFilter" :options="ENABLED_FILTER_OPTIONS" />
      </div>
      <button type="submit" class="btn-secondary">{{ t("common.apply") }}</button>
    </form>

    <div v-if="selected.size > 0" class="bulk-bar">
      <span>{{ t("pages.servers.selected_count", { count: selected.size }) }}</span>
      <button type="button" class="btn-secondary" :disabled="bulkPending" @click="runBulk(true)">
        {{ t("pages.servers.enable_selected") }}
      </button>
      <button type="button" class="btn-danger" :disabled="bulkPending" @click="requestBulkDisable">
        {{ t("pages.servers.disable_selected") }}
      </button>
      <button type="button" class="link-btn" @click="selected = new Set()">
        {{ t("pages.servers.clear_selection") }}
      </button>
      <span v-if="bulkError" class="error" role="alert">{{ bulkError }}</span>
    </div>

    <ListLayout :loading="loading" :error="errorMessage" :empty="items.length === 0">
      <template #empty>
        <EmptyState :icon="Server">
          <template v-if="q || enabledFilter">
            {{ t("pages.servers.empty.no_match") }}
            <button
              type="button"
              class="link-btn"
              @click="
                q = '';
                enabledFilter = '';
                applyFilters();
              "
            >
              {{ t("pages.servers.clear_filters") }}
            </button>
          </template>
          <template v-else>
            {{ t("pages.servers.empty.no_servers") }}
          </template>
        </EmptyState>
      </template>

      <TableCard>
        <thead>
          <tr>
            <th class="checkbox-col">
              <input
                type="checkbox"
                :checked="selected.size > 0 && selected.size === items.length"
                :aria-label="t('pages.servers.aria.select_all')"
                @change="toggleSelectAll"
              />
            </th>
            <th>{{ t("common.name") }}</th>
            <th>{{ t("common.status") }}</th>
            <th>{{ t("pages.servers.col_tools") }}</th>
            <th>{{ t("pages.servers.col_health_url") }}</th>
            <th>{{ t("common.enabled") }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="client in items" :key="client.name">
            <td class="checkbox-col">
              <input
                type="checkbox"
                :checked="selected.has(client.name)"
                :aria-label="t('pages.servers.aria.select_one', { name: client.name })"
                @change="toggleSelected(client.name)"
              />
            </td>
            <td>
              <RouterLink :to="`/servers/${encodeURIComponent(client.name)}`">{{ client.name }}</RouterLink>
              <KindBadge class="kind-chip" :kind="client.kind" />
            </td>
            <td><StatusBadge :status="client.status" /></td>
            <td>{{ client.toolsCount }}</td>
            <td>
              <HoverPreview class="cell-truncate" :text="client.healthUrl" mono>{{ client.healthUrl }}</HoverPreview>
            </td>
            <td>
              <TogglePill
                :on="client.enabled"
                :on-label="t('common.enabled')"
                :off-label="t('common.disabled')"
                :aria-pressed="client.enabled"
                @click="onToggleClick(client)"
              />
              <p v-if="rowError[client.name]" class="row-error">{{ rowError[client.name] }}</p>
            </td>
          </tr>
        </tbody>
      </TableCard>
    </ListLayout>

    <div class="sticky-pagination">
      <PaginationBar
        :has-prev="hasPrev"
        :has-next="hasNext"
        :label="t('pages.servers.pagination_label', { count: items.length })"
        @prev="prevPage"
        @next="nextPage"
      />
    </div>

    <ConfirmDialog
      :open="pendingDisable !== null"
      :title="t('pages.servers.confirm.disable_title')"
      :message="
        pendingDisable
          ? t('pages.servers.confirm.disable_message', { name: pendingDisable.name, tools: pendingDisable.toolsCount })
          : ''
      "
      :confirm-label="
        pendingDisable
          ? t('pages.servers.confirm.disable_label_named', { name: pendingDisable.name })
          : t('common.disable')
      "
      danger
      @confirm="confirmDisable"
      @cancel="cancelDisable"
    />

    <ConfirmDialog
      :open="pendingBulkDisable !== null"
      :title="t('pages.servers.confirm.bulk_disable_title')"
      :message="t('pages.servers.confirm.bulk_disable_message', { count: selected.size })"
      :confirm-label="t('pages.servers.confirm.bulk_disable_label', { count: selected.size })"
      danger
      @confirm="confirmBulkDisable"
      @cancel="cancelBulkDisable"
    />
  </section>
</template>

<style scoped>
.subtitle {
  color: var(--text-secondary);
  margin: 0;
}
</style>
