<script setup lang="ts">
import { ref, computed, onMounted } from "vue";
import { useRouter } from "vue-router";
import { api, ApiError } from "../composables/useApi";
import { useResource } from "../composables/useResource";
import type { CatalogEntry, DiscoveryPreview, DiscoveredTool } from "../types/api";
import { LayoutGrid, Plus } from "lucide-vue-next";
import ConfirmDialog from "../components/ConfirmDialog.vue";
import SignalLoader from "../components/SignalLoader.vue";

const router = useRouter();

const {
  data: items,
  loading,
  errorMessage,
  load,
} = useResource<CatalogEntry[]>(
  async () => (await api.get<{ items: CatalogEntry[] }>("/admin-api/catalog")).items,
  [],
  "Failed to load catalog.",
);

const sorted = computed(() =>
  [...items.value].sort((a, b) => (a.featured === b.featured ? a.name.localeCompare(b.name) : a.featured ? -1 : 1)),
);

onMounted(load);

// ── Install flow ────────────────────────────────────────────────────────────
const openEntryId = ref<string | null>(null);
const installName = ref("");
const previewTools = ref<DiscoveredTool[] | null>(null);
const previewing = ref(false);
const previewError = ref("");
const installing = ref(false);
const installError = ref("");

function toggleInstall(entry: CatalogEntry) {
  if (openEntryId.value === entry.id) {
    openEntryId.value = null;
    return;
  }
  openEntryId.value = entry.id;
  installName.value = entry.slug;
  previewTools.value = null;
  previewError.value = "";
  installError.value = "";
}

async function preview(entry: CatalogEntry) {
  if (!entry.openapiUrl) return;
  previewing.value = true;
  previewError.value = "";
  try {
    const res = await api.post<DiscoveryPreview>("/admin-api/discovery/preview", {
      openapi_url: entry.openapiUrl,
      include_tags: entry.includeTags ?? undefined,
      exclude_operations: entry.excludeOperations ?? undefined,
    });
    previewTools.value = res.tools;
  } catch (err) {
    previewError.value = err instanceof ApiError ? err.message : "Preview failed.";
  } finally {
    previewing.value = false;
  }
}

async function confirmInstall(entry: CatalogEntry) {
  installError.value = "";
  if (!installName.value.trim()) {
    installError.value = "Name is required.";
    return;
  }
  installing.value = true;
  try {
    await api.post(`/admin-api/catalog/${encodeURIComponent(entry.id)}/install`, { name: installName.value.trim() });
    await router.push(`/servers/${encodeURIComponent(installName.value.trim())}`);
  } catch (err) {
    installError.value = err instanceof ApiError ? err.message : "Install failed.";
  } finally {
    installing.value = false;
  }
}

// ── Custom entry form ───────────────────────────────────────────────────────
const showCreateForm = ref(false);
const newSlug = ref("");
const newName = ref("");
const newDescription = ref("");
const newKind = ref<"rest" | "mcp">("rest");
const newHealthUrl = ref("");
const newOpenapiUrl = ref("");
const newMcpUrl = ref("");
const createError = ref("");
const creating = ref(false);

async function createEntry() {
  createError.value = "";
  if (!newSlug.value.trim() || !newName.value.trim()) {
    createError.value = "Slug and name are required.";
    return;
  }
  creating.value = true;
  try {
    await api.post("/admin-api/catalog", {
      slug: newSlug.value.trim(),
      name: newName.value.trim(),
      description: newDescription.value.trim() || undefined,
      kind: newKind.value,
      healthUrl: newKind.value === "rest" ? newHealthUrl.value.trim() || undefined : undefined,
      openapiUrl: newKind.value === "rest" ? newOpenapiUrl.value.trim() || undefined : undefined,
      mcpUrl: newKind.value === "mcp" ? newMcpUrl.value.trim() || undefined : undefined,
    });
    newSlug.value = "";
    newName.value = "";
    newDescription.value = "";
    newHealthUrl.value = "";
    newOpenapiUrl.value = "";
    newMcpUrl.value = "";
    showCreateForm.value = false;
    await load();
  } catch (err) {
    createError.value = err instanceof ApiError ? err.message : "Failed to save catalog entry.";
  } finally {
    creating.value = false;
  }
}

const pendingDelete = ref<CatalogEntry | null>(null);

function deleteEntry(entry: CatalogEntry) {
  pendingDelete.value = entry;
}

async function confirmDelete() {
  if (!pendingDelete.value) return;
  const entry = pendingDelete.value;
  pendingDelete.value = null;
  try {
    await api.delete(`/admin-api/catalog/${encodeURIComponent(entry.id)}`);
    await load();
  } catch (err) {
    errorMessage.value = err instanceof ApiError ? err.message : "Failed to delete catalog entry.";
  }
}
</script>

<template>
  <section>
    <header class="page-header">
      <div>
        <h1>Catalog</h1>
        <p class="subtitle">
          Browse well-known servers and install them with one click, or save your own reusable templates.
        </p>
      </div>
      <button
        type="button"
        :class="showCreateForm ? 'btn-secondary' : 'btn-primary'"
        @click="showCreateForm = !showCreateForm"
      >
        <Plus :size="14" stroke-width="2.5" aria-hidden="true" /> {{ showCreateForm ? "Cancel" : "Add custom entry" }}
      </button>
    </header>

    <form v-if="showCreateForm" class="create-form" @submit.prevent="createEntry">
      <div class="field">
        <label for="ce-slug">Slug</label>
        <input id="ce-slug" v-model="newSlug" type="text" placeholder="internal-crm-staging" required />
      </div>
      <div class="field">
        <label for="ce-name">Name</label>
        <input id="ce-name" v-model="newName" type="text" placeholder="Internal CRM (staging)" required />
      </div>
      <div class="field">
        <label for="ce-description">Description (optional)</label>
        <input id="ce-description" v-model="newDescription" type="text" placeholder="What this template registers" />
      </div>
      <div class="segmented" role="radiogroup" aria-label="Kind">
        <label><input v-model="newKind" type="radio" name="ce-kind" value="rest" /> REST API</label>
        <label><input v-model="newKind" type="radio" name="ce-kind" value="mcp" /> MCP server</label>
      </div>
      <template v-if="newKind === 'rest'">
        <div class="field">
          <label for="ce-health">Health URL</label>
          <input id="ce-health" v-model="newHealthUrl" type="url" placeholder="https://api.example.com/health" />
        </div>
        <div class="field">
          <label for="ce-openapi">OpenAPI URL</label>
          <input
            id="ce-openapi"
            v-model="newOpenapiUrl"
            type="url"
            placeholder="https://api.example.com/openapi.json"
          />
        </div>
      </template>
      <div v-else class="field">
        <label for="ce-mcp">MCP server URL</label>
        <input id="ce-mcp" v-model="newMcpUrl" type="url" placeholder="https://mcp.example.com/mcp" />
      </div>
      <p v-if="createError" class="error">{{ createError }}</p>
      <button type="submit" class="btn-primary" :disabled="creating">{{ creating ? "Saving…" : "Save entry" }}</button>
    </form>

    <p v-if="errorMessage" class="error" role="alert">{{ errorMessage }}</p>
    <SignalLoader v-if="loading" />

    <template v-else-if="items.length === 0">
      <div class="empty-state">
        <LayoutGrid :size="26" stroke-width="1.5" aria-hidden="true" class="empty-icon" />
        <p>No catalog entries yet. The catalog lists one-click installable servers -- built-in or admin-added -- so registering a new backend doesn't start from a blank form.</p>
      </div>
    </template>

    <div v-else class="catalog-grid">
      <article
        v-for="entry in sorted"
        :key="entry.id"
        class="catalog-card"
        :class="{ 'is-open': openEntryId === entry.id }"
      >
        <div class="card-top">
          <span class="kind-badge" :class="`kind-${entry.kind}`">{{ entry.kind === "mcp" ? "MCP" : "REST" }}</span>
          <span v-if="entry.featured" class="featured-badge">Featured</span>
          <span v-if="entry.source === 'custom'" class="custom-badge">Custom</span>
        </div>
        <h3>{{ entry.name }}</h3>
        <p class="desc">{{ entry.description || "No description." }}</p>
        <p v-if="entry.category" class="category">{{ entry.category }}</p>
        <div v-if="entry.tags.length" class="tags">
          <span v-for="tag in entry.tags" :key="tag" class="tag">{{ tag }}</span>
        </div>

        <div class="card-actions">
          <button type="button" class="btn-secondary" @click="toggleInstall(entry)">
            {{ openEntryId === entry.id ? "Cancel" : "Install" }}
          </button>
          <button v-if="entry.source === 'custom'" type="button" class="link-btn danger" @click="deleteEntry(entry)">
            Delete
          </button>
        </div>

        <div v-if="openEntryId === entry.id" class="install-panel">
          <div class="field">
            <label :for="`install-name-${entry.id}`">Install as</label>
            <input :id="`install-name-${entry.id}`" v-model="installName" type="text" />
          </div>
          <template v-if="entry.kind === 'rest' && entry.openapiUrl">
            <div class="preview-row">
              <button type="button" class="btn-secondary" :disabled="previewing" @click="preview(entry)">
                {{ previewing ? "Discovering…" : "Preview tools" }}
              </button>
              <span v-if="previewTools" class="preview-count">{{ previewTools.length }} tool(s) discovered</span>
            </div>
            <p v-if="previewError" class="error">{{ previewError }}</p>
          </template>
          <p v-else class="hint">
            The bridge connects to the MCP server and discovers its tools on install. If it requires authentication,
            install it first, set upstream credentials on its detail page, then re-register.
          </p>
          <p v-if="installError" class="error">{{ installError }}</p>
          <button type="button" class="btn-primary" :disabled="installing" @click="confirmInstall(entry)">
            {{ installing ? "Installing…" : "Confirm install" }}
          </button>
        </div>
      </article>
    </div>

    <ConfirmDialog
      :open="pendingDelete !== null"
      title="Delete catalog entry?"
      :message="
        pendingDelete
          ? `'${pendingDelete.name}' will be removed from the catalog. This does not affect any servers already installed from it.`
          : ''
      "
      :confirm-label="pendingDelete ? `Delete ${pendingDelete.name}` : 'Delete'"
      danger
      @confirm="confirmDelete"
      @cancel="pendingDelete = null"
    />
  </section>
</template>

<style scoped>
.page-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  margin-bottom: 1.25rem;
}
.page-header h1 {
  margin: 0 0 0.2rem;
}
.subtitle {
  color: var(--text-secondary);
  margin: 0;
  max-width: 560px;
}
.btn-primary,
.btn-secondary {
  display: inline-flex;
  align-items: center;
  gap: 0.4em;
}
.create-form {
  background: var(--surface-sunken);
  padding: 1.25rem;
  border-radius: var(--radius-md);
  margin-bottom: 1.5rem;
  max-width: 480px;
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}
.field label {
  display: block;
  font-size: 0.85rem;
  font-weight: 600;
  margin-bottom: 0.3rem;
}
.field input {
  width: 100%;
  padding: 0.55rem 0.7rem;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-sm);
  font-size: 0.9rem;
  font-family: var(--font-body);
  box-sizing: border-box;
}
.segmented {
  display: flex;
  gap: 1rem;
  font-size: 0.85rem;
}
.catalog-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
  gap: 1rem;
}
.catalog-card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-xs);
  padding: 1rem;
  display: flex;
  flex-direction: column;
}
.catalog-card.is-open {
  border-color: var(--accent, var(--border-strong));
}
.card-top {
  display: flex;
  gap: 0.4rem;
  margin-bottom: 0.5rem;
}
.kind-badge,
.featured-badge,
.custom-badge {
  font-size: 0.68rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  padding: 0.15rem 0.5rem;
  border-radius: var(--radius-pill);
}
.kind-badge {
  background: var(--surface-sunken);
  color: var(--text-secondary);
}
.featured-badge {
  background: var(--ok-soft, var(--surface-sunken));
  color: var(--ok);
}
.custom-badge {
  border: 1px solid var(--border-strong);
  color: var(--text-secondary);
}
.catalog-card h3 {
  margin: 0 0 0.3rem;
  font-size: 1rem;
}
.desc {
  color: var(--text-secondary);
  font-size: 0.85rem;
  margin: 0 0 0.4rem;
  flex-grow: 1;
}
.category {
  font-size: 0.78rem;
  color: var(--text-muted);
  margin: 0 0 0.4rem;
}
.tags {
  display: flex;
  flex-wrap: wrap;
  gap: 0.3rem;
  margin-bottom: 0.75rem;
}
.tag {
  font-size: 0.72rem;
  background: var(--surface-sunken);
  color: var(--text-secondary);
  padding: 0.1rem 0.5rem;
  border-radius: var(--radius-pill);
}
.card-actions {
  display: flex;
  align-items: center;
  gap: 0.75rem;
}
.link-btn.danger {
  color: var(--breach);
}
.install-panel {
  margin-top: 0.85rem;
  padding-top: 0.85rem;
  border-top: 1px solid var(--border);
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
}
.preview-row {
  display: flex;
  align-items: center;
  gap: 0.75rem;
}
.preview-count {
  font-size: 0.85rem;
  color: var(--ok);
}
.hint {
  font-size: 0.8rem;
  color: var(--text-secondary);
  margin: 0;
}
.error {
  color: var(--breach);
}
.empty-state {
  padding: 3rem 2rem;
  text-align: center;
  color: var(--text-secondary);
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
}
.empty-icon {
  color: var(--text-muted);
  margin-bottom: 0.75rem;
}
</style>
