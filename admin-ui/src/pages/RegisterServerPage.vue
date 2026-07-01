<script setup lang="ts">
import { ref } from "vue";
import { useRouter } from "vue-router";
import { api, ApiError } from "../composables/useApi";
import type { DiscoveryPreview, DiscoveredTool } from "../types/api";

const router = useRouter();

const name = ref("");
const healthUrl = ref("");
const baseUrl = ref("");
const mode = ref<"openapi" | "manual">("openapi");
const openapiUrl = ref("");
const includeTags = ref("");
const excludeOps = ref("");
const manualTools = ref("");

const previewTools = ref<DiscoveredTool[] | null>(null);
const previewing = ref(false);
const previewError = ref("");
const registering = ref(false);
const error = ref("");

function parseList(raw: string): string[] {
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

async function preview() {
  previewError.value = "";
  previewTools.value = null;
  if (!openapiUrl.value.trim()) {
    previewError.value = "Enter an OpenAPI URL first.";
    return;
  }
  previewing.value = true;
  try {
    const res = await api.post<DiscoveryPreview>("/admin-api/discovery/preview", {
      openapi_url: openapiUrl.value.trim(),
      include_tags: parseList(includeTags.value),
      exclude_operations: parseList(excludeOps.value),
    });
    previewTools.value = res.tools;
  } catch (err) {
    previewError.value = err instanceof ApiError ? err.message : "Preview failed.";
  } finally {
    previewing.value = false;
  }
}

async function register() {
  error.value = "";
  if (!name.value.trim() || !healthUrl.value.trim()) {
    error.value = "Name and health URL are required.";
    return;
  }
  registering.value = true;
  try {
    const payload: Record<string, unknown> = { name: name.value.trim(), health_url: healthUrl.value.trim() };
    if (baseUrl.value.trim()) payload.base_url = baseUrl.value.trim();
    if (mode.value === "openapi") {
      payload.openapi_url = openapiUrl.value.trim();
      const tags = parseList(includeTags.value);
      if (tags.length) payload.include_tags = tags;
      const ex = parseList(excludeOps.value);
      if (ex.length) payload.exclude_operations = ex;
    } else {
      payload.tools = JSON.parse(manualTools.value);
    }
    await api.post("/register", payload);
    await router.push(`/servers/${encodeURIComponent(name.value.trim())}`);
  } catch (err) {
    if (err instanceof SyntaxError) error.value = "Manual tools must be valid JSON.";
    else error.value = err instanceof ApiError ? err.message : "Registration failed.";
  } finally {
    registering.value = false;
  }
}
</script>

<template>
  <section>
    <p class="breadcrumb"><RouterLink to="/servers">Servers</RouterLink> / Add server</p>
    <h1>Register a server</h1>

    <form class="reg-form" @submit.prevent="register">
      <div class="field">
        <label for="r-name">Name</label>
        <input id="r-name" v-model="name" type="text" required placeholder="payments-svc" />
      </div>
      <div class="field">
        <label for="r-health">Health URL</label>
        <input id="r-health" v-model="healthUrl" type="url" required placeholder="https://api.example.com/health" />
      </div>
      <div class="field">
        <label for="r-base">Base URL (optional — defaults to the health URL's origin)</label>
        <input id="r-base" v-model="baseUrl" type="url" placeholder="https://api.example.com" />
      </div>

      <div class="mode-toggle">
        <label><input v-model="mode" type="radio" value="openapi" /> From OpenAPI</label>
        <label><input v-model="mode" type="radio" value="manual" /> Manual tools</label>
      </div>

      <template v-if="mode === 'openapi'">
        <div class="field">
          <label for="r-openapi">OpenAPI URL</label>
          <input id="r-openapi" v-model="openapiUrl" type="url" placeholder="https://api.example.com/openapi.json" />
        </div>
        <div class="field">
          <label for="r-tags">Include tags (comma-separated, optional)</label>
          <input id="r-tags" v-model="includeTags" type="text" placeholder="public, v2" />
        </div>
        <div class="field">
          <label for="r-exclude">Exclude operationIds (comma-separated, optional)</label>
          <input id="r-exclude" v-model="excludeOps" type="text" placeholder="deleteEverything" />
        </div>
        <div class="preview-row">
          <button type="button" class="btn-secondary" :disabled="previewing" @click="preview">
            {{ previewing ? "Discovering…" : "Preview tools" }}
          </button>
          <span v-if="previewTools" class="preview-count">{{ previewTools.length }} tool(s) discovered</span>
        </div>
        <p v-if="previewError" class="error">{{ previewError }}</p>
        <div v-if="previewTools && previewTools.length" class="table-scroll preview-table">
          <table>
            <thead><tr><th>Name</th><th>Method</th><th>Endpoint</th></tr></thead>
            <tbody>
              <tr v-for="t in previewTools" :key="t.name">
                <td>{{ t.name }}</td>
                <td><code>{{ t.method }}</code></td>
                <td class="ep">{{ t.endpoint }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </template>

      <div v-else class="field">
        <label for="r-manual">Tools (JSON array of {name, method, endpoint, description, inputSchema})</label>
        <textarea id="r-manual" v-model="manualTools" rows="10" spellcheck="false"></textarea>
      </div>

      <p v-if="error" class="error" role="alert">{{ error }}</p>
      <button type="submit" class="btn-primary" :disabled="registering">{{ registering ? "Registering…" : "Register server" }}</button>
    </form>
  </section>
</template>

<style scoped>
.breadcrumb {
  font-size: 0.85rem;
  color: #63676e;
}
.reg-form {
  display: flex;
  flex-direction: column;
  gap: 0.85rem;
  max-width: 560px;
  margin-top: 1rem;
}
.field label {
  display: block;
  font-size: 0.85rem;
  font-weight: 600;
  margin-bottom: 0.25rem;
}
.field input,
.field textarea {
  width: 100%;
  padding: 0.45rem 0.6rem;
  border: 1px solid #cfd4da;
  border-radius: 6px;
  box-sizing: border-box;
  font-family: inherit;
}
.field textarea {
  font-family: ui-monospace, monospace;
  font-size: 0.82rem;
}
.mode-toggle {
  display: flex;
  gap: 1.25rem;
  padding: 0.5rem 0;
  font-size: 0.9rem;
}
.mode-toggle label {
  font-weight: 500;
}
.preview-row {
  display: flex;
  align-items: center;
  gap: 0.75rem;
}
.preview-count {
  font-size: 0.85rem;
  color: #146c2e;
}
.preview-table table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.85rem;
}
.preview-table th {
  text-align: left;
  padding: 0.4rem 0.6rem;
  border-bottom: 2px solid #e5e7eb;
  font-size: 0.75rem;
  text-transform: uppercase;
  color: #52565c;
}
.preview-table td {
  padding: 0.4rem 0.6rem;
  border-bottom: 1px solid #eef0f2;
}
.preview-table .ep {
  color: #63676e;
}
.error {
  color: #a11212;
}
</style>
