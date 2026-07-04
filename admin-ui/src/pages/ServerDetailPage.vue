<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted, nextTick } from "vue";
import { useRouter } from "vue-router";
import { api, ApiError } from "../composables/useApi";
import { useConfirmAction } from "../composables/useConfirmAction";
import type { ClientDetail } from "../types/api";
import StatusBadge from "@/components/ui/StatusBadge.vue";
import ConfirmDialog from "@/components/ui/ConfirmDialog.vue";
import GuardEditor from "@/components/guard-editor/GuardEditor.vue";
import SignalLoader from "@/components/ui/SignalLoader.vue";
import ConnectClientDialog from "../components/ConnectClientDialog.vue";
import ServerDetailUpstreamAuth from "../components/ServerDetailUpstreamAuth.vue";
import ServerDetailOAuth from "../components/ServerDetailOAuth.vue";
import ServerDetailResync from "../components/ServerDetailResync.vue";
import ServerDetailLb from "../components/ServerDetailLb.vue";
import ServerDetailCanary from "../components/ServerDetailCanary.vue";
import ServerDetailTeam from "../components/ServerDetailTeam.vue";
import ServerDetailRemove from "../components/ServerDetailRemove.vue";
import ServerDetailToolsTable from "../components/ServerDetailToolsTable.vue";
import ServerDetailPlayground from "../components/ServerDetailPlayground.vue";
import { Wrench, Settings2, RotateCcw, Cable } from "lucide-vue-next";

const props = defineProps<{ name: string; tool?: string }>();
const router = useRouter();

const detail = ref<ClientDetail | null>(null);
const loading = ref(false);
const errorMessage = ref("");
const activeTab = ref<"tools" | "settings">("tools");
const resettingBreaker = ref(false);
const drawerCloseBtn = ref<HTMLButtonElement | null>(null);
const connectOpen = ref(false);

const activeTool = computed(() => detail.value?.tools.find((t) => t.name === props.tool) ?? null);

// Drawer is route-driven (props.tool + activeTool, not a local boolean) and
// activeTool only resolves once the async load() finishes — watch it rather
// than props.tool alone, or focus() would fire before the drawer exists.
watch(
  () => activeTool.value,
  async (tool) => {
    if (!tool) return;
    await nextTick();
    drawerCloseBtn.value?.focus();
  },
  { immediate: true },
);

function onKeydown(e: KeyboardEvent) {
  if (document.querySelector('[role="dialog"][aria-label="Command palette"]')) return;
  if (e.key === "Escape" && props.tool) closeGuardEditor();
}
// Capture phase, not bubble: CommandPalette's own bubble-phase Escape handler
// (registered on window too, but mounted earlier via App.vue) closes the
// palette itself fast enough that a bubble-phase check here can already find
// it gone, so this would then wrongly also close the drawer. Capture runs
// before that handler, so the palette-open check above still sees it open.
onMounted(() => window.addEventListener("keydown", onKeydown, true));
onUnmounted(() => window.removeEventListener("keydown", onKeydown, true));

async function load() {
  loading.value = true;
  errorMessage.value = "";
  try {
    detail.value = await api.get<ClientDetail>(`/admin-api/clients/${encodeURIComponent(props.name)}`);
  } catch (err) {
    errorMessage.value = err instanceof ApiError ? err.message : "Failed to load server.";
  } finally {
    loading.value = false;
  }
}

watch(() => props.name, load);
onMounted(load);

async function toggleClientEnabled() {
  if (!detail.value) return;
  const next = !detail.value.enabled;
  const previous = detail.value.enabled;
  detail.value.enabled = next;
  try {
    await api.patch(`/admin-api/clients/${encodeURIComponent(props.name)}`, { enabled: next });
  } catch (err) {
    detail.value.enabled = previous;
    errorMessage.value = err instanceof ApiError ? err.message : "Failed to update.";
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

function closeGuardEditor() {
  router.push(`/servers/${encodeURIComponent(props.name)}`);
}

async function resetBreaker() {
  resettingBreaker.value = true;
  try {
    await api.post(`/admin-api/clients/${encodeURIComponent(props.name)}/circuit-breaker/reset`);
    await load();
  } catch (err) {
    errorMessage.value = err instanceof ApiError ? err.message : "Failed to reset circuit breaker.";
  } finally {
    resettingBreaker.value = false;
  }
}
</script>

<template>
  <section>
    <p class="breadcrumb"><RouterLink to="/servers">Servers</RouterLink> / {{ name }}</p>

    <SignalLoader v-if="loading && !detail" />
    <p v-else-if="errorMessage && !detail" class="error" role="alert">{{ errorMessage }}</p>

    <template v-else-if="detail">
      <header class="page-header">
        <div>
          <h1>{{ detail.name }}</h1>
          <div class="badges">
            <span v-if="detail.kind === 'mcp'" class="kind-mcp">MCP</span>
            <StatusBadge :status="detail.status" />
            <StatusBadge v-if="detail.circuitBreakerState" :status="detail.circuitBreakerState" />
            <span v-if="!detail.live" class="badge badge-neutral">Not currently connected</span>
          </div>
        </div>
        <div class="header-actions">
          <button
            type="button"
            class="toggle"
            :class="detail.enabled ? 'toggle-on' : 'toggle-off'"
            :aria-pressed="detail.enabled"
            @click="onClientToggleClick"
          >
            {{ detail.enabled ? "Enabled" : "Disabled" }}
          </button>
          <button
            v-if="detail.live"
            type="button"
            class="btn-secondary"
            :disabled="resettingBreaker"
            @click="resetBreaker"
          >
            <RotateCcw :size="14" stroke-width="2" aria-hidden="true" />
            {{ resettingBreaker ? "Resetting…" : "Reset circuit breaker" }}
          </button>
          <button type="button" class="btn-secondary" @click="connectOpen = true">
            <Cable :size="14" stroke-width="2" aria-hidden="true" />
            Connect client
          </button>
        </div>
      </header>

      <p v-if="errorMessage" class="error" role="alert">{{ errorMessage }}</p>

      <dl class="meta">
        <template v-if="detail.kind === 'mcp'">
          <div>
            <dt>MCP URL</dt>
            <dd>{{ detail.mcpUrl }}</dd>
          </div>
          <div>
            <dt>Transport</dt>
            <dd>{{ detail.mcpTransport }}</dd>
          </div>
        </template>
        <template v-else>
          <div>
            <dt>Health URL</dt>
            <dd>{{ detail.healthUrl }}</dd>
          </div>
          <div>
            <dt>Base URL</dt>
            <dd>{{ detail.baseUrl }}</dd>
          </div>
        </template>
        <div v-if="detail.consecutiveFailures !== null">
          <dt>Consecutive failures</dt>
          <dd>{{ detail.consecutiveFailures }}</dd>
        </div>
      </dl>

      <div class="tab-strip" role="tablist">
        <button
          type="button"
          role="tab"
          :aria-selected="activeTab === 'tools'"
          class="tab-btn"
          :class="{ 'tab-active': activeTab === 'tools' }"
          @click="activeTab = 'tools'"
        >
          <Wrench :size="15" stroke-width="2" aria-hidden="true" /> Tools
        </button>
        <button
          type="button"
          role="tab"
          :aria-selected="activeTab === 'settings'"
          class="tab-btn"
          :class="{ 'tab-active': activeTab === 'settings' }"
          @click="activeTab = 'settings'"
        >
          <Settings2 :size="15" stroke-width="2" aria-hidden="true" /> Settings
        </button>
      </div>

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
    <div v-if="tool && activeTool" class="drawer" role="dialog" aria-modal="true" :aria-label="`Guards — ${activeTool.name}`">
      <div class="drawer-header">
        <h2>Guards — {{ activeTool.name }}</h2>
        <button ref="drawerCloseBtn" type="button" class="link-btn" @click="closeGuardEditor">Close</button>
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
    <p v-else-if="tool && detail && !activeTool" class="error">Tool "{{ tool }}" not found on this server.</p>

    <ConfirmDialog
      :open="pendingClientDisable !== null"
      title="Disable this server?"
      :message="
        detail
          ? `'${detail.name}' and all of its tools will stop working for connected MCP agents until re-enabled.`
          : ''
      "
      :confirm-label="detail ? `Disable ${detail.name}` : 'Disable'"
      danger
      @confirm="confirmClientDisable"
      @cancel="cancelClientDisable"
    />

    <ConnectClientDialog :open="connectOpen" preset-scope="client" :preset-name="name" @close="connectOpen = false" />
  </section>
</template>

<style>
/* Deliberately unscoped: this stylesheet is shared with the 9 extracted
   ServerDetailXxx.vue section components, which render under their own
   scope hash, not this file's. Verified none of these class names collide
   with anything else in admin-ui/src (they're only ever mounted while this
   route is active, and are distinctive enough not to leak meaningfully). */
.breadcrumb {
  font-size: 0.85rem;
  color: var(--text-secondary);
}
.page-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  margin-bottom: 1rem;
}
.page-header h1 {
  margin: 0 0 0.4rem;
}
.badges {
  display: flex;
  gap: 0.5rem;
}
.header-actions {
  display: flex;
  gap: 0.6rem;
  align-items: center;
}
.header-actions .btn-secondary {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
}
.badge-neutral {
  display: inline-flex;
  align-items: center;
  padding: 0.15em 0.6em;
  border-radius: var(--radius-pill);
  font-size: 0.8rem;
  font-weight: 600;
  background: var(--surface-sunken);
  color: var(--text-secondary);
}
.kind-mcp {
  display: inline-flex;
  align-items: center;
  padding: 0.15em 0.6em;
  border-radius: var(--radius-pill);
  font-size: 0.8rem;
  font-weight: 700;
  letter-spacing: 0.02em;
  background: var(--kind-mcp-soft);
  color: var(--kind-mcp-text);
}
.meta {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(12.5rem, 1fr));
  gap: 0.75rem;
  margin: 1rem 0 1.5rem;
  padding: 1rem 1.1rem;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
}
.meta dt {
  font-size: 0.72rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.03em;
  color: var(--text-muted);
  margin-bottom: 0.2rem;
}
.meta dd {
  margin: 0;
  font-size: 0.88rem;
  font-family: var(--font-mono);
  word-break: break-all;
}
.tab-strip {
  display: flex;
  gap: 0.25rem;
  margin-bottom: 1.25rem;
  border-bottom: 1px solid var(--border);
}
.tab-btn {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  background: none;
  border: none;
  border-bottom: 2px solid transparent;
  color: var(--text-secondary);
  font-weight: 600;
  font-size: 0.88rem;
  padding: 0.55rem 0.35rem;
  margin-bottom: -1px;
  cursor: pointer;
  transition:
    color 0.12s ease,
    border-color 0.12s ease;
}
.tab-btn:hover {
  color: var(--text-primary);
}
.tab-btn.tab-active {
  color: var(--signal-strong);
  border-bottom-color: var(--signal);
}
.table-card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-xs);
}
.tools-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.9rem;
}
.tools-table th {
  text-align: left;
  padding: 0.65rem 0.85rem;
  border-bottom: 1px solid var(--border);
  color: var(--text-muted);
  font-size: 0.74rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.tools-table td {
  padding: 0.6rem 0.85rem;
  border-bottom: 1px solid var(--border);
  vertical-align: middle;
}
.tools-table tbody tr:last-child td {
  border-bottom: none;
}
.tools-table tbody tr:hover {
  background: var(--surface-sunken);
}
.url-cell {
  color: var(--text-secondary);
  font-family: var(--font-mono);
  font-size: 0.83rem;
  max-width: 16.25rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.toggle {
  display: inline-flex;
  align-items: center;
  gap: 0.45em;
  border-radius: var(--radius-pill);
  padding: 0.28rem 0.8rem;
  font-size: 0.78rem;
  font-weight: 600;
  cursor: pointer;
  background: var(--surface);
  transition: background-color 0.12s ease;
}
.toggle::before {
  content: "";
  width: 0.55em;
  height: 0.55em;
  border-radius: 50%;
  background: currentColor;
  flex-shrink: 0;
}
.toggle-on {
  border: 1px solid var(--ok);
  color: var(--ok);
}
.toggle-off {
  border: 1px solid var(--border-strong);
  color: var(--text-secondary);
}
.toggle-on:hover {
  background: var(--ok-soft);
}
.toggle-off:hover {
  background: var(--surface-sunken);
}
.row-error {
  color: var(--breach);
  font-size: 0.75rem;
  margin: 0.25rem 0 0;
}
.test-result {
  margin-top: 1rem;
  padding: 0.75rem 1rem;
  border-radius: 8px;
}
.test-ok {
  background: #f0f7f2;
}
.test-error {
  background: #fdf1f1;
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
  border-top: 1px solid #e6e8eb;
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
  color: #63676e;
}
.ex-chip {
  display: inline-flex;
  align-items: center;
  gap: 0.2rem;
  background: #eef1f4;
  border-radius: 12px;
  padding: 0.1rem 0.5rem;
}
.ex-chip .del {
  color: #a11212;
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
  border: 1px solid #cfd4da;
  border-radius: 6px;
  font-size: 0.85rem;
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
  background: #fff;
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
.empty-state {
  padding: 1.5rem;
  text-align: center;
  color: #63676e;
  background: #fafbfc;
  border-radius: 8px;
}
.error {
  color: #a11212;
}
.upstream-auth {
  margin: 0 0 1.75rem;
  padding: 1rem 1.25rem;
  background: #fafbfc;
  border-radius: 8px;
}
.ua-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.ua-head h2 {
  margin: 0;
  font-size: 1.05rem;
}
.ua-actions {
  display: flex;
  gap: 0.75rem;
  align-items: center;
}
.ua-status {
  font-size: 0.85rem;
  color: #52565c;
  margin: 0.5rem 0 0;
}
.ua-form {
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
  margin-top: 0.9rem;
  max-width: 22.5rem;
}
.ua-form label {
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
  font-size: 0.82rem;
  font-weight: 600;
}
.ua-form input,
.ua-form select {
  padding: 0.4rem 0.55rem;
  border: 1px solid #cfd4da;
  border-radius: 6px;
  font-weight: 400;
}
.link-btn.danger {
  color: #a11212;
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
  border: 1px solid #cfd4da;
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
  color: #146c2e;
  margin: 0.2rem 0;
}
.diff-rem {
  color: #a11212;
  margin: 0.2rem 0;
}
.tag-chip {
  display: inline-block;
  margin-left: 0.35rem;
  padding: 0.05rem 0.45rem;
  background: #eef2f7;
  color: #3a5a8a;
  border-radius: 999px;
  font-size: 0.72rem;
  vertical-align: middle;
}
.lb-targets {
  margin-top: var(--space-4);
}
.lb-table {
  width: 100%;
  border-collapse: collapse;
  font-size: var(--text-base);
}
.lb-table th {
  text-align: left;
  padding: var(--space-3);
  border-bottom: 1px solid var(--border);
  color: var(--text-muted);
  font-size: var(--text-xs);
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.lb-table td {
  padding: var(--space-2) var(--space-3);
  border-bottom: 1px solid var(--border);
  vertical-align: middle;
}
.lb-table tbody tr:last-child td {
  border-bottom: none;
}
.lb-table tbody tr:hover {
  background: var(--surface-sunken);
}
</style>
