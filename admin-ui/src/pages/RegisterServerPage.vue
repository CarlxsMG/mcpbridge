<script setup lang="ts">
import { ref, watch } from "vue";
import { useRouter } from "vue-router";
import { api, ApiError } from "../composables/useApi";
import type { DiscoveryPreview, DiscoveredTool, McpTransport } from "../types/api";

const router = useRouter();

// Wizard-only kind — a "graphql" registration still persists as an ordinary
// kind:"rest" client (see performGraphqlRegistration in routes/register.ts);
// this local union is broader than the API's UpstreamKind on purpose.
const kind = ref<"rest" | "mcp" | "graphql">("rest");
const name = ref("");

// REST fields
const healthUrl = ref("");
const baseUrl = ref("");
const mode = ref<"openapi" | "manual">("openapi");
const openapiUrl = ref("");
const includeTags = ref("");
const excludeOps = ref("");
const manualTools = ref("");

// MCP upstream fields
const mcpUrl = ref("");
const mcpTransport = ref<McpTransport>("streamable-http");

// GraphQL fields
const graphqlUrl = ref("");
const includeMutations = ref(true);
const graphqlHealthUrl = ref("");

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

watch([openapiUrl, includeTags, excludeOps], () => {
  previewTools.value = null;
});

async function previewGraphql() {
  previewError.value = "";
  previewTools.value = null;
  if (!graphqlUrl.value.trim()) {
    previewError.value = "Enter a GraphQL URL first.";
    return;
  }
  previewing.value = true;
  try {
    const res = await api.post<DiscoveryPreview>("/admin-api/discovery/preview-graphql", {
      graphql_url: graphqlUrl.value.trim(),
      include_mutations: includeMutations.value,
    });
    previewTools.value = res.tools;
  } catch (err) {
    previewError.value = err instanceof ApiError ? err.message : "Preview failed.";
  } finally {
    previewing.value = false;
  }
}

watch([graphqlUrl, includeMutations], () => {
  previewTools.value = null;
});

async function register() {
  error.value = "";
  registering.value = true;
  try {
    if (kind.value === "mcp") {
      if (!name.value.trim() || !mcpUrl.value.trim()) {
        error.value = "Name and MCP server URL are required.";
        return;
      }
      await api.post("/register", {
        kind: "mcp",
        name: name.value.trim(),
        mcp_url: mcpUrl.value.trim(),
        mcp_transport: mcpTransport.value,
      });
      await router.push(`/servers/${encodeURIComponent(name.value.trim())}`);
      return;
    }

    if (kind.value === "graphql") {
      if (!name.value.trim() || !graphqlUrl.value.trim()) {
        error.value = "Name and GraphQL URL are required.";
        return;
      }
      await api.post("/register", {
        kind: "graphql",
        name: name.value.trim(),
        graphql_url: graphqlUrl.value.trim(),
        health_url: graphqlHealthUrl.value.trim() || undefined,
        include_mutations: includeMutations.value,
      });
      await router.push(`/servers/${encodeURIComponent(name.value.trim())}`);
      return;
    }

    if (!name.value.trim() || !healthUrl.value.trim()) {
      error.value = "Name and health URL are required.";
      return;
    }
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
    <header class="page-header">
      <h1>Register a server</h1>
    </header>

    <form class="reg-form" @submit.prevent="register">
      <div class="segmented" role="radiogroup" aria-label="Server kind">
        <label><input v-model="kind" type="radio" name="kind" value="rest" /> REST API</label>
        <label><input v-model="kind" type="radio" name="kind" value="graphql" /> GraphQL</label>
        <label><input v-model="kind" type="radio" name="kind" value="mcp" /> MCP server</label>
      </div>

      <div class="field">
        <label for="r-name">Name</label>
        <input id="r-name" v-model="name" type="text" required placeholder="payments-svc" />
      </div>

      <template v-if="kind === 'rest'">
        <div class="field">
          <label for="r-health">Health URL</label>
          <input id="r-health" v-model="healthUrl" type="url" placeholder="https://api.example.com/health" />
        </div>
        <div class="field">
          <label for="r-base">Base URL (optional — defaults to the health URL's origin)</label>
          <input id="r-base" v-model="baseUrl" type="url" placeholder="https://api.example.com" />
        </div>

        <div class="segmented" role="radiogroup" aria-label="Tool discovery mode">
          <label><input v-model="mode" type="radio" name="mode" value="openapi" /> From OpenAPI</label>
          <label><input v-model="mode" type="radio" name="mode" value="manual" /> Manual tools</label>
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
          <div v-if="previewTools && previewTools.length" class="table-card table-scroll">
            <table class="preview-table">
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
          <textarea
            id="r-manual"
            v-model="manualTools"
            rows="10"
            spellcheck="false"
            placeholder='[{"name":"get_user","method":"GET","endpoint":"/users/{id}","description":"Fetch a user by id","inputSchema":{"type":"object","properties":{"id":{"type":"string"}}}}]'
          ></textarea>
        </div>
      </template>

      <template v-else-if="kind === 'graphql'">
        <div class="field">
          <label for="r-graphql-url">GraphQL URL</label>
          <input id="r-graphql-url" v-model="graphqlUrl" type="url" placeholder="https://api.example.com/graphql" />
        </div>
        <div class="field">
          <label for="r-graphql-health">Health URL (optional — defaults to the GraphQL URL)</label>
          <input id="r-graphql-health" v-model="graphqlHealthUrl" type="url" placeholder="https://api.example.com/health" />
          <p class="hint">Many GraphQL servers reject a bare GET on the operation endpoint. If you have a dedicated liveness endpoint, use it here to avoid false health-check failures.</p>
        </div>
        <label class="checkline"><input v-model="includeMutations" type="checkbox" /> Include mutations</label>
        <div class="preview-row">
          <button type="button" class="btn-secondary" :disabled="previewing" @click="previewGraphql">
            {{ previewing ? "Discovering…" : "Preview tools" }}
          </button>
          <span v-if="previewTools" class="preview-count">{{ previewTools.length }} tool(s) discovered</span>
        </div>
        <p v-if="previewError" class="error">{{ previewError }}</p>
        <div v-if="previewTools && previewTools.length" class="table-card table-scroll">
          <table class="preview-table">
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

      <template v-else>
        <div class="field">
          <label for="r-mcp-url">MCP server URL</label>
          <input id="r-mcp-url" v-model="mcpUrl" type="url" required placeholder="https://mcp.example.com/mcp" />
        </div>
        <div class="field">
          <label for="r-mcp-transport">Transport</label>
          <select id="r-mcp-transport" v-model="mcpTransport">
            <option value="streamable-http">Streamable HTTP</option>
            <option value="sse">SSE (legacy)</option>
          </select>
        </div>
        <p class="hint">
          The bridge connects to the MCP server and discovers its tools on registration. If the server
          requires authentication, register it first, set upstream credentials on its detail page, then
          re-discover.
        </p>
      </template>

      <p v-if="error" class="error" role="alert">{{ error }}</p>
      <button
        type="submit"
        class="btn-primary"
        :disabled="registering || (kind === 'rest' && mode === 'openapi' && !previewTools)"
      >{{ registering ? "Registering…" : "Register server" }}</button>
    </form>
  </section>
</template>

<style scoped>
.breadcrumb {
  font-size: 0.85rem;
  color: var(--text-secondary);
}
.page-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  margin-bottom: 1.25rem;
}
.page-header h1 {
  margin: 0 0 0.2rem;
}
.reg-form {
  display: flex;
  flex-direction: column;
  gap: 0.85rem;
  max-width: 560px;
  margin-top: 1rem;
}
.field {
  margin-bottom: 1rem;
}
.field label {
  display: block;
  font-size: 0.85rem;
  font-weight: 600;
  margin-bottom: 0.3rem;
}
.field input,
.field select,
.field textarea {
  width: 100%;
  padding: 0.55rem 0.7rem;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-sm);
  font-size: 0.9rem;
  font-family: var(--font-body);
  box-sizing: border-box;
}
.field textarea {
  font-family: var(--font-mono);
  font-size: 0.82rem;
}
.hint {
  font-size: 0.82rem;
  color: var(--text-secondary);
  margin: 0;
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
.table-card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-xs);
}
.preview-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.9rem;
}
.preview-table th {
  text-align: left;
  padding: 0.65rem 0.85rem;
  border-bottom: 1px solid var(--border);
  color: var(--text-muted);
  font-size: 0.74rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.preview-table td {
  padding: 0.6rem 0.85rem;
  border-bottom: 1px solid var(--border);
  vertical-align: middle;
}
.preview-table tbody tr:last-child td {
  border-bottom: none;
}
.preview-table tbody tr:hover {
  background: var(--surface-sunken);
}
.preview-table .ep {
  color: var(--text-secondary);
}
.error {
  color: var(--breach);
}
</style>
