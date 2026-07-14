<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted, nextTick } from "vue";
import { useI18n } from "vue-i18n";
import { useRouter } from "vue-router";
import { api } from "@/composables/useApi";
import { useResource } from "@/composables/useResource";
import { useConfirmAction } from "@/composables/useConfirmAction";
import { useCommandPalette } from "@/composables/useCommandPalette";
import { useFocusTrap } from "@/composables/useFocusTrap";
import { clientPath } from "@/utils/apiPaths";
import { toErrorMessage } from "@/utils/errors";
import { tk } from "@/i18n";
import type { ClientDetail } from "@/types/api";
import StatusBadge from "@/components/ui/StatusBadge.vue";
import KindBadge from "@/components/ui/KindBadge.vue";
import PageHeader from "@/components/ui/PageHeader.vue";
import TogglePill from "@/components/ui/TogglePill.vue";
import TabStrip from "@/components/ui/TabStrip.vue";
import ConfirmDialog from "@/components/ui/ConfirmDialog.vue";
import GuardEditor from "@/components/guard-editor/GuardEditor.vue";
import SignalLoader from "@/components/ui/SignalLoader.vue";
import ConnectClientDialog from "@/components/ConnectClientDialog.vue";
import ServerDetailUpstreamAuth from "@/components/server-detail/ServerDetailUpstreamAuth.vue";
import ServerDetailOAuth from "@/components/server-detail/ServerDetailOAuth.vue";
import ServerDetailResync from "@/components/server-detail/ServerDetailResync.vue";
import ServerDetailLb from "@/components/server-detail/ServerDetailLb.vue";
import ServerDetailCanary from "@/components/server-detail/ServerDetailCanary.vue";
import ServerDetailTeam from "@/components/server-detail/ServerDetailTeam.vue";
import ServerDetailRemove from "@/components/server-detail/ServerDetailRemove.vue";
import ServerDetailToolsTable from "@/components/server-detail/ServerDetailToolsTable.vue";
import ServerDetailPlayground from "@/components/server-detail/ServerDetailPlayground.vue";
import FieldError from "@/components/ui/FieldError.vue";
import { Wrench, Settings2, RotateCcw, Cable } from "lucide-vue-next";

const props = defineProps<{ name: string; tool?: string }>();
const router = useRouter();
const { paletteOpen } = useCommandPalette();
const { t } = useI18n({ useScope: "global" });

const {
  data: detail,
  loading,
  errorMessage,
  load,
} = useResource<ClientDetail | null>(
  () => api.get<ClientDetail>(clientPath(props.name)),
  null,
  tk("pages.server_detail.errors.load_failed"),
);

const activeTab = ref<"tools" | "settings">("tools");
const tabs = [
  { key: "tools" as const, label: t("pages.server_detail.tabs.tools"), icon: Wrench },
  { key: "settings" as const, label: t("pages.server_detail.tabs.settings"), icon: Settings2 },
];
const resettingBreaker = ref(false);
const drawerCloseBtn = ref<HTMLButtonElement | null>(null);
const drawerEl = ref<HTMLElement | null>(null);
const connectOpen = ref(false);

const { onKeydown: onDrawerKeydown } = useFocusTrap(drawerEl);

const activeTool = computed(() => detail.value?.tools.find((tt) => tt.name === props.tool) ?? null);

// Focus management, mirroring ModalShell: land focus on the close button when
// the drawer opens (or switches tools), and restore it to whatever launched
// the drawer when it closes (WCAG 2.4.3 — don't drop the user on <body>).
let previouslyFocused: HTMLElement | null = null;
watch(
  () => activeTool.value,
  async (tool, prevTool) => {
    if (tool) {
      if (!prevTool) previouslyFocused = document.activeElement as HTMLElement | null;
      await nextTick();
      drawerCloseBtn.value?.focus();
    } else if (prevTool) {
      previouslyFocused?.focus();
      previouslyFocused = null;
    }
  },
  { immediate: true },
);

function onKeydown(e: KeyboardEvent) {
  if (paletteOpen.value) return;
  if (e.key === "Escape" && props.tool) closeGuardEditor();
}
onMounted(() => window.addEventListener("keydown", onKeydown, true));
onUnmounted(() => window.removeEventListener("keydown", onKeydown, true));

watch(() => props.name, load);
onMounted(load);

async function toggleClientEnabled() {
  if (!detail.value) return;
  const next = !detail.value.enabled;
  const previous = detail.value.enabled;
  detail.value.enabled = next;
  try {
    await api.patch(clientPath(props.name), { enabled: next });
  } catch (err) {
    detail.value.enabled = previous;
    errorMessage.value = toErrorMessage(err, tk("pages.server_detail.errors.toggle_failed"));
  }
}

const {
  pending: pendingClientDisable,
  request: requestClientDisableConfirm,
  cancel: cancelClientDisable,
  confirm: confirmClientDisableAction,
} = useConfirmAction<true>();

function onClientToggleClick() {
  if (!detail.value) return;
  if (detail.value.enabled) {
    requestClientDisableConfirm(true);
  } else {
    toggleClientEnabled();
  }
}

function confirmClientDisable() {
  return confirmClientDisableAction(async () => {
    await toggleClientEnabled();
  });
}

async function closeGuardEditor() {
  const toolName = props.tool;
  await router.push(`/servers/${encodeURIComponent(props.name)}`);
  if (!toolName) return;
  await nextTick();
  document.querySelector<HTMLButtonElement>(`[data-guard-trigger="${CSS.escape(toolName)}"]`)?.focus();
}

async function resetBreaker() {
  resettingBreaker.value = true;
  try {
    await api.post(clientPath(props.name, "circuit-breaker", "reset"));
    await load();
  } catch (err) {
    errorMessage.value = toErrorMessage(err, tk("pages.server_detail.errors.reset_breaker_failed"));
  } finally {
    resettingBreaker.value = false;
  }
}
</script>

<template>
  <section>
    <p class="sd-breadcrumb">
      <RouterLink to="/servers">{{ t("nav.servers.label") }}</RouterLink> / {{ name }}
    </p>

    <SignalLoader v-if="loading && !detail" />
    <p v-else-if="errorMessage && !detail" class="error" role="alert">{{ errorMessage }}</p>

    <template v-else-if="detail">
      <PageHeader :title="detail.name">
        <template #meta>
          <KindBadge :kind="detail.kind" />
          <StatusBadge :status="detail.status" />
          <StatusBadge v-if="detail.circuitBreakerState" :status="detail.circuitBreakerState" />
          <KindBadge v-if="!detail.live" :kind="t('pages.server_detail.not_connected')" />
        </template>

        <TogglePill
          :on="detail.enabled"
          :on-label="t('common.enabled')"
          :off-label="t('common.disabled')"
          @click="onClientToggleClick"
        />
        <button
          v-if="detail.live"
          type="button"
          class="btn-secondary"
          :disabled="resettingBreaker"
          @click="resetBreaker"
        >
          <RotateCcw :size="14" stroke-width="2" aria-hidden="true" />
          {{ resettingBreaker ? t("pages.server_detail.resetting") : t("pages.server_detail.reset_breaker") }}
        </button>
        <button type="button" class="btn-secondary" @click="connectOpen = true">
          <Cable :size="14" stroke-width="2" aria-hidden="true" />
          {{ t("common.connect_client") }}
        </button>
      </PageHeader>

      <p v-if="errorMessage" class="error" role="alert">{{ errorMessage }}</p>

      <dl class="sd-meta">
        <template v-if="detail.kind === 'mcp'">
          <div>
            <dt>{{ t("pages.server_detail.mcp_url") }}</dt>
            <dd>{{ detail.mcpUrl }}</dd>
          </div>
          <div>
            <dt>{{ t("pages.server_detail.transport") }}</dt>
            <dd>{{ detail.mcpTransport }}</dd>
          </div>
        </template>
        <template v-else>
          <div>
            <dt>{{ t("pages.server_detail.health_url") }}</dt>
            <dd>{{ detail.healthUrl }}</dd>
          </div>
          <div>
            <dt>{{ t("pages.server_detail.base_url") }}</dt>
            <dd>{{ detail.baseUrl }}</dd>
          </div>
        </template>
        <div v-if="detail.consecutiveFailures !== null">
          <dt>{{ t("pages.server_detail.consecutive_failures") }}</dt>
          <dd>{{ detail.consecutiveFailures }}</dd>
        </div>
      </dl>

      <TabStrip v-model="activeTab" :tabs="tabs" />

      <template v-if="activeTab === 'settings'">
        <ServerDetailUpstreamAuth :client-name="props.name" :kind="detail.kind" />
        <ServerDetailOAuth v-if="detail.kind !== 'mcp'" :client-name="props.name" />
        <ServerDetailResync :detail="detail" @resynced="load" />
        <ServerDetailLb v-if="detail.kind !== 'mcp'" :client-name="props.name" />
        <ServerDetailCanary v-if="detail.kind !== 'mcp'" :client-name="props.name" />
        <ServerDetailTeam :client-name="props.name" :team-id="detail.teamId" />
        <ServerDetailRemove :client-name="props.name" />
      </template>

      <template v-if="activeTab === 'tools'">
        <ServerDetailToolsTable :tools="detail.tools" :kind="detail.kind" :client-name="props.name" />
      </template>
    </template>

    <!-- Guard editor drawer -->
    <div v-if="tool && activeTool" class="drawer-overlay" @click="closeGuardEditor"></div>
    <div
      v-if="tool && activeTool"
      ref="drawerEl"
      class="drawer"
      role="dialog"
      aria-modal="true"
      :aria-label="t('pages.server_detail.guards_aria', { name: activeTool.name })"
      @keydown="onDrawerKeydown"
    >
      <div class="drawer-header">
        <h2>{{ t("pages.server_detail.guards_heading", { name: activeTool.name }) }}</h2>
        <button ref="drawerCloseBtn" type="button" class="link-btn" @click="closeGuardEditor">
          {{ t("common.close") }}
        </button>
      </div>
      <GuardEditor
        :guards="activeTool.guards"
        :override="activeTool.override"
        :guardrails="activeTool.guardrails"
        :coalesce="activeTool.coalesce"
        :approval="activeTool.approval"
        :quarantine="activeTool.quarantine"
        :ws="activeTool.ws"
        :graphql="activeTool.graphql"
        :context-budget="activeTool.contextBudget"
        :client-name="props.name"
        :tool-name="activeTool.name"
        :tags="activeTool.tags"
        :redact-paths="activeTool.redactPaths"
        @tool-changed="load"
      />

      <ServerDetailPlayground :client-name="props.name" :tool="activeTool" />
    </div>
    <FieldError
      v-else-if="tool && detail && !activeTool"
      :message="t('pages.server_detail.tool_not_found', { name: tool })"
    />

    <ConfirmDialog
      :open="pendingClientDisable !== null"
      :title="t('pages.server_detail.confirm.disable_title')"
      :message="detail ? t('pages.server_detail.confirm.disable_message', { name: detail.name }) : ''"
      :confirm-label="
        detail ? t('pages.server_detail.confirm.disable_cta', { name: detail.name }) : t('common.disable')
      "
      danger
      @confirm="confirmClientDisable"
      @cancel="cancelClientDisable"
    />

    <ConnectClientDialog :open="connectOpen" preset-scope="client" :preset-name="name" @close="connectOpen = false" />
  </section>
</template>

<style scoped>
.sd-breadcrumb {
  font-size: 0.85rem;
  color: var(--text-secondary);
}
.sd-meta {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(12.5rem, 1fr));
  gap: 0.75rem;
  margin: 1rem 0 1.5rem;
  padding: 1rem 1.1rem;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
}
.sd-meta dt {
  font-size: 0.72rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.03em;
  color: var(--text-muted);
  margin-bottom: 0.2rem;
}
.sd-meta dd {
  margin: 0;
  font-size: 0.88rem;
  font-family: var(--font-mono);
  word-break: break-all;
}
.drawer-overlay {
  position: fixed;
  inset: 0;
  background: rgba(15, 18, 22, 0.45);
  z-index: var(--z-drawer);
}
.drawer {
  position: fixed;
  top: 0;
  right: 0;
  height: 100vh;
  width: min(26.25rem, 100%);
  background: var(--surface);
  box-shadow: -8px 0 24px rgba(0, 0, 0, 0.12);
  padding: 1.5rem;
  overflow-y: auto;
  z-index: var(--z-drawer-top);
}
.drawer-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 1rem;
}
.drawer-header h2 {
  font-size: 1.05rem;
  margin: 0;
}
</style>

<style>
/* Unscoped on purpose: the rules below reach into the child section components
   rendered on this page (ServerDetailToolsTable, ServerDetailPlayground,
   ServerDetailResync, ServerDetailLb), each of which renders under its own
   scoped-style hash — a `scoped` block here could not target them (same pattern
   as ConfigSection.vue). These names are domain-specific, so they carry no
   app-wide-collision risk; the page's own-element styles (breadcrumb, meta,
   drawer) live in the `scoped` block above. */
.url-cell {
  color: var(--text-secondary);
  font-family: var(--font-mono);
  font-size: 0.83rem;
  max-width: 16.25rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.test-result {
  margin-top: 1rem;
  padding: 0.75rem 1rem;
  border-radius: 8px;
}
.test-ok {
  background: var(--ok-soft);
}
.test-error {
  background: var(--breach-soft);
}
.test-result pre {
  white-space: pre-wrap;
  word-break: break-word;
  margin: 0.4rem 0 0;
  font-size: 0.82rem;
}
.playground {
  margin-top: 1.4rem;
  padding-top: 1rem;
  border-top: 1px solid var(--border);
}
.playground h3 {
  margin: 0 0 0.2rem;
  font-size: 1rem;
}
.examples {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.4rem;
  margin-bottom: 0.7rem;
  font-size: 0.85rem;
}
.ex-label {
  color: var(--text-secondary);
}
.ex-chip {
  display: inline-flex;
  align-items: center;
  gap: 0.2rem;
  background: var(--surface-sunken);
  border-radius: 12px;
  padding: 0.1rem 0.5rem;
}
.ex-chip .del {
  color: var(--breach);
}
.pg-actions {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 0.6rem;
  margin-top: 0.8rem;
  flex-wrap: wrap;
}
.save-ex {
  display: inline-flex;
  gap: 0.4rem;
}
.save-ex input {
  padding: 0.4rem 0.55rem;
  border: 1px solid var(--border-strong);
  border-radius: 6px;
  font-size: 0.85rem;
}
.resync-body {
  margin-top: 0.9rem;
}
.field-inline {
  display: flex;
  gap: 0.6rem;
  align-items: center;
}
.field-inline input {
  flex: 1;
  padding: 0.4rem 0.55rem;
  border: 1px solid var(--border-strong);
  border-radius: 6px;
}
.diff {
  margin-top: 0.75rem;
  font-size: 0.85rem;
}
.diff-summary {
  margin: 0 0 0.4rem;
}
.diff-add {
  color: var(--ok);
  margin: 0.2rem 0;
}
.diff-rem {
  color: var(--breach);
  margin: 0.2rem 0;
}
.tag-chip {
  display: inline-block;
  margin-left: 0.35rem;
  padding: 0.05rem 0.45rem;
  background: var(--signal-soft);
  color: var(--signal-strong);
  border-radius: 999px;
  font-size: 0.72rem;
  vertical-align: middle;
}
.lb-targets {
  margin-top: var(--space-4);
}
</style>
