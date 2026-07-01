<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted, nextTick } from "vue";
import { useRouter } from "vue-router";
import { api, ApiError } from "../composables/useApi";
import type { ClientDetail, ToolDetail, UpstreamAuthInfo, DiscoveredTool, DiscoveryPreview } from "../types/api";
import StatusBadge from "../components/StatusBadge.vue";
import ConfirmDialog from "../components/ConfirmDialog.vue";
import GuardEditor from "../components/GuardEditor.vue";

const props = defineProps<{ name: string; tool?: string }>();
const router = useRouter();

const detail = ref<ClientDetail | null>(null);
const loading = ref(false);
const errorMessage = ref("");
const rowError = ref<Record<string, string>>({});
const pendingToolDisable = ref<ToolDetail | null>(null);
const savingGuards = ref(false);
const testingTool = ref<string | null>(null);
const testResult = ref<{ tool: string; text: string; isError: boolean } | null>(null);
const resettingBreaker = ref(false);
const drawerCloseBtn = ref<HTMLButtonElement | null>(null);

// Upstream auth (per-client injected credentials)
const upstreamAuth = ref<UpstreamAuthInfo | null>(null);
const uaEditing = ref(false);
const uaType = ref<"bearer" | "basic" | "header">("bearer");
const uaToken = ref("");
const uaUser = ref("");
const uaPass = ref("");
const uaHeader = ref("");
const uaValue = ref("");
const uaSaving = ref(false);
const uaError = ref("");

// Re-sync tools from an OpenAPI spec
const resyncOpen = ref(false);
const resyncUrl = ref("");
const resyncPreview = ref<DiscoveredTool[] | null>(null);
const resyncing = ref(false);
const applyingResync = ref(false);
const resyncError = ref("");
const resyncDiff = computed(() => {
  if (!resyncPreview.value || !detail.value) return null;
  const current = new Set(detail.value.tools.map((t) => t.name));
  const next = new Set(resyncPreview.value.map((t) => t.name));
  return {
    added: [...next].filter((n) => !current.has(n)),
    removed: [...current].filter((n) => !next.has(n)),
    kept: [...next].filter((n) => current.has(n)),
  };
});

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
  { immediate: true }
);

function onKeydown(e: KeyboardEvent) {
  if (e.key === "Escape" && props.tool) closeGuardEditor();
}
onMounted(() => window.addEventListener("keydown", onKeydown));
onUnmounted(() => window.removeEventListener("keydown", onKeydown));

async function load() {
  loading.value = true;
  errorMessage.value = "";
  try {
    detail.value = await api.get<ClientDetail>(`/admin-api/clients/${encodeURIComponent(props.name)}`);
    await loadUpstreamAuth();
  } catch (err) {
    errorMessage.value = err instanceof ApiError ? err.message : "Failed to load client.";
  } finally {
    loading.value = false;
  }
}

async function loadUpstreamAuth() {
  try {
    upstreamAuth.value = await api.get<UpstreamAuthInfo>(`/admin-api/clients/${encodeURIComponent(props.name)}/upstream-auth`);
  } catch {
    upstreamAuth.value = null;
  }
}

async function saveUpstreamAuth() {
  uaError.value = "";
  const body: Record<string, unknown> = { type: uaType.value };
  if (uaType.value === "bearer") body.token = uaToken.value;
  else if (uaType.value === "basic") { body.username = uaUser.value; body.password = uaPass.value; }
  else { body.headerName = uaHeader.value; body.value = uaValue.value; }
  uaSaving.value = true;
  try {
    await api.put(`/admin-api/clients/${encodeURIComponent(props.name)}/upstream-auth`, body);
    uaToken.value = uaUser.value = uaPass.value = uaHeader.value = uaValue.value = "";
    uaEditing.value = false;
    await loadUpstreamAuth();
  } catch (err) {
    uaError.value = err instanceof ApiError ? err.message : "Failed to save credentials.";
  } finally {
    uaSaving.value = false;
  }
}

async function clearUpstreamAuthCreds() {
  try {
    await api.delete(`/admin-api/clients/${encodeURIComponent(props.name)}/upstream-auth`);
    await loadUpstreamAuth();
  } catch (err) {
    uaError.value = err instanceof ApiError ? err.message : "Failed to clear credentials.";
  }
}

async function previewResync() {
  resyncError.value = "";
  resyncPreview.value = null;
  if (!resyncUrl.value.trim()) {
    resyncError.value = "Enter the OpenAPI URL.";
    return;
  }
  resyncing.value = true;
  try {
    const res = await api.post<DiscoveryPreview>("/admin-api/discovery/preview", { openapi_url: resyncUrl.value.trim() });
    resyncPreview.value = res.tools;
  } catch (err) {
    resyncError.value = err instanceof ApiError ? err.message : "Preview failed.";
  } finally {
    resyncing.value = false;
  }
}

async function applyResync() {
  if (!detail.value) return;
  applyingResync.value = true;
  resyncError.value = "";
  try {
    await api.post("/register", {
      name: detail.value.name,
      health_url: detail.value.healthUrl,
      base_url: detail.value.baseUrl,
      openapi_url: resyncUrl.value.trim(),
    });
    resyncOpen.value = false;
    resyncPreview.value = null;
    resyncUrl.value = "";
    await load();
  } catch (err) {
    resyncError.value = err instanceof ApiError ? err.message : "Re-sync failed.";
  } finally {
    applyingResync.value = false;
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

async function toggleToolEnabled(tool: ToolDetail) {
  const next = !tool.enabled;
  const previous = tool.enabled;
  tool.enabled = next; // optimistic
  delete rowError.value[tool.name];
  try {
    await api.patch(`/admin-api/clients/${encodeURIComponent(props.name)}/tools/${encodeURIComponent(tool.name)}`, { enabled: next });
  } catch (err) {
    tool.enabled = previous;
    rowError.value[tool.name] = err instanceof ApiError ? err.message : "Failed to update.";
  }
}

function onToolToggleClick(tool: ToolDetail) {
  if (tool.enabled) {
    pendingToolDisable.value = tool;
  } else {
    toggleToolEnabled(tool);
  }
}

async function confirmToolDisable() {
  if (!pendingToolDisable.value) return;
  const tool = pendingToolDisable.value;
  pendingToolDisable.value = null;
  await toggleToolEnabled(tool);
}

function openGuardEditor(tool: ToolDetail) {
  router.push(`/servers/${encodeURIComponent(props.name)}/tools/${encodeURIComponent(tool.name)}`);
}

function closeGuardEditor() {
  router.push(`/servers/${encodeURIComponent(props.name)}`);
}

async function saveGuards(payload: { rateLimitPerMin?: number; timeoutMs?: number; allowedApiKeys?: string[] } | null) {
  if (!activeTool.value) return;
  savingGuards.value = true;
  try {
    await api.patch(`/admin-api/clients/${encodeURIComponent(props.name)}/tools/${encodeURIComponent(activeTool.value.name)}`, {
      guards: payload,
    });
    await load();
    closeGuardEditor();
  } catch (err) {
    errorMessage.value = err instanceof ApiError ? err.message : "Failed to save guards.";
  } finally {
    savingGuards.value = false;
  }
}

async function saveOverride(payload: { description?: string; params?: Record<string, { description?: string }> } | null) {
  if (!activeTool.value) return;
  savingGuards.value = true;
  try {
    await api.patch(`/admin-api/clients/${encodeURIComponent(props.name)}/tools/${encodeURIComponent(activeTool.value.name)}`, {
      overrides: payload,
    });
    await load();
  } catch (err) {
    errorMessage.value = err instanceof ApiError ? err.message : "Failed to save description override.";
  } finally {
    savingGuards.value = false;
  }
}

async function saveTags(tags: string[]) {
  if (!activeTool.value) return;
  savingGuards.value = true;
  try {
    await api.put(`/admin-api/clients/${encodeURIComponent(props.name)}/tools/${encodeURIComponent(activeTool.value.name)}/tags`, { tags });
    await load();
  } catch (err) {
    errorMessage.value = err instanceof ApiError ? err.message : "Failed to save tags.";
  } finally {
    savingGuards.value = false;
  }
}

async function toggleSensitive(tool: ToolDetail) {
  const next = tool.sensitive === true ? false : true;
  delete rowError.value[tool.name];
  try {
    await api.patch(`/admin-api/clients/${encodeURIComponent(props.name)}/tools/${encodeURIComponent(tool.name)}`, { sensitive: next });
    await load();
  } catch (err) {
    rowError.value[tool.name] = err instanceof ApiError ? err.message : "Failed to update sensitivity.";
  }
}

async function testTool(tool: ToolDetail) {
  testingTool.value = tool.name;
  testResult.value = null;
  try {
    const result = await api.post<{ content: { type: string; text: string }[]; isError?: boolean }>(
      `/admin-api/clients/${encodeURIComponent(props.name)}/tools/${encodeURIComponent(tool.name)}/test`,
      {}
    );
    testResult.value = { tool: tool.name, text: result.content.map((c) => c.text).join("\n"), isError: Boolean(result.isError) };
  } catch (err) {
    // A backend that isn't currently live produces a generic "not found"-style
    // error from the API — surface the real, actionable cause instead.
    const text =
      detail.value && !detail.value.live
        ? "Can't reach this backend right now — its health check isn't currently passing. Check the health URL, then try again."
        : err instanceof ApiError
          ? err.message
          : "Test call failed.";
    testResult.value = { tool: tool.name, text, isError: true };
  } finally {
    testingTool.value = null;
  }
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

    <div v-if="loading && !detail" class="loading">Loading…</div>
    <p v-else-if="errorMessage && !detail" class="error" role="alert">{{ errorMessage }}</p>

    <template v-else-if="detail">
      <header class="page-header">
        <div>
          <h1>{{ detail.name }}</h1>
          <div class="badges">
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
            @click="toggleClientEnabled"
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
            {{ resettingBreaker ? "Resetting…" : "Reset circuit breaker" }}
          </button>
        </div>
      </header>

      <p v-if="errorMessage" class="error" role="alert">{{ errorMessage }}</p>

      <dl class="meta">
        <div><dt>Health URL</dt><dd>{{ detail.healthUrl }}</dd></div>
        <div><dt>Base URL</dt><dd>{{ detail.baseUrl }}</dd></div>
        <div v-if="detail.consecutiveFailures !== null"><dt>Consecutive failures</dt><dd>{{ detail.consecutiveFailures }}</dd></div>
      </dl>

      <div class="upstream-auth">
        <div class="ua-head">
          <h2>Upstream authentication</h2>
          <div class="ua-actions">
            <button type="button" class="btn-secondary" @click="uaEditing = !uaEditing">
              {{ uaEditing ? "Cancel" : upstreamAuth?.configured ? "Change" : "Set credentials" }}
            </button>
            <button v-if="upstreamAuth?.configured" type="button" class="link-btn danger" @click="clearUpstreamAuthCreds">Clear</button>
          </div>
        </div>
        <p class="ua-status">
          <template v-if="upstreamAuth?.configured">
            Configured: <code>{{ upstreamAuth.type }}</code><span v-if="upstreamAuth.headerName"> · {{ upstreamAuth.headerName }}</span>
          </template>
          <template v-else>Not configured — requests to this backend are sent without credentials.</template>
        </p>
        <form v-if="uaEditing" class="ua-form" @submit.prevent="saveUpstreamAuth">
          <label>Type
            <select v-model="uaType">
              <option value="bearer">Bearer token</option>
              <option value="basic">Basic (user / password)</option>
              <option value="header">Custom header</option>
            </select>
          </label>
          <label v-if="uaType === 'bearer'">Token <input v-model="uaToken" type="password" autocomplete="off" /></label>
          <template v-else-if="uaType === 'basic'">
            <label>Username <input v-model="uaUser" autocomplete="off" /></label>
            <label>Password <input v-model="uaPass" type="password" autocomplete="off" /></label>
          </template>
          <template v-else>
            <label>Header name <input v-model="uaHeader" placeholder="X-Api-Key" autocomplete="off" /></label>
            <label>Value <input v-model="uaValue" type="password" autocomplete="off" /></label>
          </template>
          <p v-if="uaError" class="error">{{ uaError }}</p>
          <button type="submit" class="btn-primary" :disabled="uaSaving">{{ uaSaving ? "Saving…" : "Save" }}</button>
        </form>
      </div>

      <div class="upstream-auth">
        <div class="ua-head">
          <h2>Re-sync from OpenAPI</h2>
          <button type="button" class="btn-secondary" @click="resyncOpen = !resyncOpen">{{ resyncOpen ? "Cancel" : "Re-sync" }}</button>
        </div>
        <div v-if="resyncOpen" class="resync-body">
          <div class="field-inline">
            <input v-model="resyncUrl" type="url" placeholder="https://api.example.com/openapi.json" />
            <button type="button" class="btn-secondary" :disabled="resyncing" @click="previewResync">{{ resyncing ? "Discovering…" : "Preview diff" }}</button>
          </div>
          <p v-if="resyncError" class="error">{{ resyncError }}</p>
          <div v-if="resyncDiff" class="diff">
            <p class="diff-summary">
              <strong>{{ resyncDiff.added.length }}</strong> added ·
              <strong>{{ resyncDiff.removed.length }}</strong> removed ·
              <strong>{{ resyncDiff.kept.length }}</strong> unchanged
            </p>
            <p v-if="resyncDiff.added.length" class="diff-add">+ {{ resyncDiff.added.join(", ") }}</p>
            <p v-if="resyncDiff.removed.length" class="diff-rem">− {{ resyncDiff.removed.join(", ") }}</p>
            <button type="button" class="btn-primary" :disabled="applyingResync" @click="applyResync">
              {{ applyingResync ? "Applying…" : "Apply re-sync" }}
            </button>
          </div>
        </div>
      </div>

      <h2>Tools ({{ detail.tools.length }})</h2>
      <div v-if="detail.tools.length" class="table-scroll">
      <table class="tools-table">
        <thead>
          <tr>
            <th>Name</th>
            <th>Method</th>
            <th>Endpoint</th>
            <th>Guards</th>
            <th>Sensitive</th>
            <th>Enabled</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="tool in detail.tools" :key="tool.name">
            <td>
              {{ tool.name }}
              <span v-for="tag in tool.tags" :key="tag" class="tag-chip">{{ tag }}</span>
            </td>
            <td><code>{{ tool.method }}</code></td>
            <td class="url-cell">{{ tool.endpoint }}</td>
            <td>
              <button type="button" class="link-btn" @click="openGuardEditor(tool)">
                {{ tool.guards ? "Edit guards" : "Add guards" }}
              </button>
            </td>
            <td>
              <button type="button" class="link-btn" @click="toggleSensitive(tool)">
                {{ tool.sensitive === true ? "🔒 Sensitive" : "Mark sensitive" }}
              </button>
            </td>
            <td>
              <button
                type="button"
                class="toggle"
                :class="tool.enabled ? 'toggle-on' : 'toggle-off'"
                :aria-pressed="tool.enabled"
                @click="onToolToggleClick(tool)"
              >
                {{ tool.enabled ? "Enabled" : "Disabled" }}
              </button>
              <p v-if="rowError[tool.name]" class="row-error">{{ rowError[tool.name] }}</p>
            </td>
            <td>
              <button type="button" class="btn-secondary" :disabled="testingTool === tool.name" @click="testTool(tool)">
                {{ testingTool === tool.name ? "Testing…" : "Test" }}
              </button>
            </td>
          </tr>
        </tbody>
      </table>
      </div>
      <p v-else class="empty-state">This client has no tools registered.</p>

      <div v-if="testResult" class="test-result" :class="testResult.isError ? 'test-error' : 'test-ok'">
        <strong>{{ testResult.tool }}</strong>
        <pre>{{ testResult.text }}</pre>
      </div>
    </template>

    <!-- Guard editor drawer -->
    <div v-if="tool && activeTool" class="drawer-overlay" @click="closeGuardEditor"></div>
    <div v-if="tool && activeTool" class="drawer" role="dialog" aria-modal="true" :aria-label="`Guards — ${activeTool.name}`">
      <div class="drawer-header">
        <h2>Guards — {{ activeTool.name }}</h2>
        <button ref="drawerCloseBtn" type="button" class="link-btn" @click="closeGuardEditor">Close</button>
      </div>
      <GuardEditor :guards="activeTool.guards" :override="activeTool.override" :tags="activeTool.tags" :saving="savingGuards" @save="saveGuards" @save-override="saveOverride" @save-tags="saveTags" />
    </div>
    <p v-else-if="tool && detail && !activeTool" class="error">Tool "{{ tool }}" not found on this client.</p>

    <ConfirmDialog
      :open="pendingToolDisable !== null"
      title="Disable this tool?"
      :message="pendingToolDisable ? `'${pendingToolDisable.name}' will stop working for all connected MCP agents until re-enabled.` : ''"
      :confirm-label="pendingToolDisable ? `Disable ${pendingToolDisable.name}` : 'Disable'"
      danger
      @confirm="confirmToolDisable"
      @cancel="pendingToolDisable = null"
    />
  </section>
</template>

<style scoped>
.breadcrumb {
  font-size: 0.85rem;
  color: #63676e;
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
.badge-neutral {
  display: inline-flex;
  align-items: center;
  padding: 0.15em 0.6em;
  border-radius: 999px;
  font-size: 0.8rem;
  font-weight: 600;
  background: #eceef1;
  color: #52565c;
}
.meta {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: 0.75rem;
  margin: 1rem 0 1.5rem;
  padding: 1rem;
  background: #fafbfc;
  border-radius: 8px;
}
.meta dt {
  font-size: 0.75rem;
  text-transform: uppercase;
  color: #63676e;
  margin-bottom: 0.15rem;
}
.meta dd {
  margin: 0;
  font-size: 0.9rem;
  word-break: break-all;
}
.tools-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.9rem;
}
.tools-table th {
  text-align: left;
  padding: 0.5rem 0.6rem;
  border-bottom: 2px solid #e5e7eb;
  color: #52565c;
  font-size: 0.78rem;
  text-transform: uppercase;
}
.tools-table td {
  padding: 0.55rem 0.6rem;
  border-bottom: 1px solid #eef0f2;
  vertical-align: middle;
}
.url-cell {
  color: #63676e;
  max-width: 260px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.toggle {
  display: inline-flex;
  align-items: center;
  gap: 0.4em;
  border-radius: 6px;
  padding: 0.25rem 0.75rem;
  font-size: 0.8rem;
  font-weight: 600;
  cursor: pointer;
  background: #fff;
}
.toggle::before {
  content: "";
  width: 0.6em;
  height: 0.6em;
  border-radius: 50%;
  background: currentColor;
}
.toggle-on {
  border: 1px solid #146c2e;
  color: #146c2e;
}
.toggle-off {
  border: 1px solid #9aa0a8;
  color: #52565c;
}
.row-error {
  color: #a11212;
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
.drawer-overlay {
  position: fixed;
  inset: 0;
  background: rgba(15, 18, 22, 0.45);
  z-index: 49;
}
.drawer {
  position: fixed;
  top: 0;
  right: 0;
  height: 100vh;
  width: min(420px, 100%);
  background: #fff;
  box-shadow: -8px 0 24px rgba(0, 0, 0, 0.12);
  padding: 1.5rem;
  overflow-y: auto;
  z-index: 50;
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
.loading {
  color: #63676e;
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
  max-width: 360px;
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
</style>
