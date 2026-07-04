<script setup lang="ts">
import { ref, watch } from "vue";
import { useRouter } from "vue-router";
import { api, ApiError } from "@/composables/useApi";
import { parseList } from "@/utils/fieldParsing";
import { toErrorMessage } from "@/utils/errors";
import type { DiscoveryPreview, DiscoveredTool, McpTransport } from "@/types/api";
import PageHeader from "@/components/ui/PageHeader.vue";
import TableCard from "@/components/ui/TableCard.vue";
import FormField from "@/components/ui/FormField.vue";
import SelectMenu from "@/components/ui/SelectMenu.vue";
import FormPage from "@/components/ui/FormPage.vue";

const TRANSPORT_OPTIONS: { value: McpTransport; label: string }[] = [
  { value: "streamable-http", label: "Streamable HTTP" },
  { value: "sse", label: "SSE (legacy)" },
];

const router = useRouter();

// Wizard-only kind — a "graphql" registration still persists as an ordinary
// kind:"rest" client (see performGraphqlRegistration in routes/register.ts);
// this local union is broader than the API's UpstreamKind on purpose.
const kind = ref<"rest" | "mcp" | "graphql">("rest");
const name = ref("");

// REST fields
const healthUrl = ref("");
const baseUrl = ref("");
const mode = ref<"openapi" | "manual" | "curl" | "postman">("openapi");
const openapiUrl = ref("");
const includeTags = ref("");
const excludeOps = ref("");
const manualTools = ref("");
const curlInput = ref("");
const postmanText = ref("");
const postmanFileName = ref("");

const curlPlaceholder =
  "curl -X POST https://api.example.com/users \\\n" +
  '  -H "Content-Type: application/json" \\\n' +
  '  -d \'{"name":"Jane"}\'\n\n' +
  "# a second command works too — separate with a blank line\n" +
  "curl https://api.example.com/users";

// MCP upstream fields
const mcpUrl = ref("");
const mcpTransport = ref<McpTransport>("streamable-http");

// GraphQL fields
const graphqlUrl = ref("");
const includeMutations = ref(true);
const graphqlHealthUrl = ref("");

const previewTools = ref<DiscoveredTool[] | null>(null);
const previewStale = ref(false);
const previewing = ref(false);
const previewError = ref("");
const registering = ref(false);
const error = ref("");

function parseJsonField(raw: string, label: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`${label} must be valid JSON.`);
  }
}

/**
 * Builds the discovery-source portion of the /register (and preview) payload
 * for whichever REST mode is currently selected — openapi/manual/curl/postman
 * all funnel through the SAME preview() flow and the SAME /register call
 * below; only this one piece of the payload differs per mode. Throws a plain
 * Error (not ApiError) with a user-facing message for client-side input
 * problems (empty field, invalid JSON) so both preview() and register() can
 * surface it identically without hitting the network.
 */
function buildRestDiscoveryPayload(): Record<string, unknown> {
  if (mode.value === "openapi") {
    if (!openapiUrl.value.trim()) throw new Error("Enter an OpenAPI URL first.");
    return {
      openapi_url: openapiUrl.value.trim(),
      include_tags: parseList(includeTags.value),
      exclude_operations: parseList(excludeOps.value),
    };
  }
  if (mode.value === "manual") {
    if (!manualTools.value.trim()) throw new Error("Enter a tools JSON array first.");
    return { tools: parseJsonField(manualTools.value, "Tools") };
  }
  if (mode.value === "curl") {
    if (!curlInput.value.trim()) throw new Error("Enter a cURL command first.");
    return { curl_input: curlInput.value };
  }
  // postman
  if (!postmanText.value.trim()) throw new Error("Paste or upload a Postman collection first.");
  return { postman_collection: parseJsonField(postmanText.value, "Postman collection") };
}

async function preview() {
  previewError.value = "";
  previewTools.value = null;

  let payload: Record<string, unknown>;
  try {
    payload = buildRestDiscoveryPayload();
  } catch (err) {
    previewError.value = err instanceof Error ? err.message : "Invalid input.";
    return;
  }

  previewing.value = true;
  try {
    const res = await api.post<DiscoveryPreview>("/admin-api/discovery/preview", payload);
    previewTools.value = res.tools;
    previewStale.value = false;
  } catch (err) {
    previewError.value = toErrorMessage(err, "Preview failed.");
  } finally {
    previewing.value = false;
  }
}

function onPostmanFileChange(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  postmanFileName.value = file.name;
  const reader = new FileReader();
  reader.onload = () => {
    postmanText.value = typeof reader.result === "string" ? reader.result : "";
  };
  reader.readAsText(file);
}

watch([mode, openapiUrl, includeTags, excludeOps, manualTools, curlInput, postmanText], () => {
  if (previewTools.value) previewStale.value = true;
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
    previewError.value = toErrorMessage(err, "Preview failed.");
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
    Object.assign(payload, buildRestDiscoveryPayload());
    await api.post("/register", payload);
    await router.push(`/servers/${encodeURIComponent(name.value.trim())}`);
  } catch (err) {
    if (err instanceof ApiError) error.value = err.message;
    else if (err instanceof Error) error.value = err.message;
    else error.value = "Registration failed.";
  } finally {
    registering.value = false;
  }
}
</script>

<template>
  <section>
    <FormPage max-width="50rem">
      <PageHeader title="Register a server" :back-link="{ to: '/servers', label: 'Servers' }" />

      <form class="reg-form" @submit.prevent="register">
        <div class="segmented" role="radiogroup" aria-label="Server kind">
          <label><input v-model="kind" type="radio" name="kind" value="rest" /> REST API</label>
          <label><input v-model="kind" type="radio" name="kind" value="graphql" /> GraphQL</label>
          <label><input v-model="kind" type="radio" name="kind" value="mcp" /> MCP server</label>
        </div>

        <FormField label="Name" for="r-name">
          <input id="r-name" v-model="name" type="text" required placeholder="payments-svc" />
        </FormField>

        <template v-if="kind === 'rest'">
          <FormField label="Health URL" for="r-health">
            <input id="r-health" v-model="healthUrl" type="url" placeholder="https://api.example.com/health" />
          </FormField>
          <FormField label="Base URL (optional — defaults to the health URL's origin)" for="r-base">
            <input id="r-base" v-model="baseUrl" type="url" placeholder="https://api.example.com" />
          </FormField>

          <div class="segmented" role="radiogroup" aria-label="Tool discovery mode">
            <label><input v-model="mode" type="radio" name="mode" value="openapi" /> From OpenAPI</label>
            <label><input v-model="mode" type="radio" name="mode" value="manual" /> Manual tools</label>
            <label><input v-model="mode" type="radio" name="mode" value="curl" /> From cURL</label>
            <label><input v-model="mode" type="radio" name="mode" value="postman" /> From Postman</label>
          </div>

          <template v-if="mode === 'openapi'">
            <FormField label="OpenAPI URL" for="r-openapi">
              <input
                id="r-openapi"
                v-model="openapiUrl"
                type="url"
                placeholder="https://api.example.com/openapi.json"
              />
            </FormField>
            <FormField label="Include tags (comma-separated, optional)" for="r-tags">
              <input id="r-tags" v-model="includeTags" type="text" placeholder="public, v2" />
            </FormField>
            <FormField label="Exclude operationIds (comma-separated, optional)" for="r-exclude">
              <input id="r-exclude" v-model="excludeOps" type="text" placeholder="deleteEverything" />
            </FormField>
          </template>

          <FormField
            v-else-if="mode === 'manual'"
            label="Tools (JSON array of {name, method, endpoint, description, inputSchema})"
            for="r-manual"
          >
            <textarea
              id="r-manual"
              v-model="manualTools"
              rows="10"
              spellcheck="false"
              placeholder='[{"name":"get_user","method":"GET","endpoint":"/users/:id","description":"Fetch a user by id","inputSchema":{"type":"object","properties":{"id":{"type":"string"}}}}]'
            ></textarea>
          </FormField>

          <FormField v-else-if="mode === 'curl'" label="cURL command(s)" for="r-curl">
            <textarea
              id="r-curl"
              v-model="curlInput"
              rows="10"
              spellcheck="false"
              :placeholder="curlPlaceholder"
            ></textarea>
            <p class="hint">
              Paste one or more cURL commands — separate multiple with a blank line, or use a trailing "\" to continue
              one command across lines. An optional "# name" comment line right above a command sets that tool's name.
            </p>
          </FormField>

          <FormField v-else label="Postman Collection v2.1" for="r-postman-file">
            <input id="r-postman-file" type="file" accept="application/json,.json" @change="onPostmanFileChange" />
            <p v-if="postmanFileName" class="hint">Loaded from file: {{ postmanFileName }}</p>
            <label for="r-postman-text" class="postman-paste-label">…or paste the exported collection JSON</label>
            <textarea id="r-postman-text" v-model="postmanText" rows="8" spellcheck="false"></textarea>
          </FormField>

          <div class="preview-row">
            <button type="button" class="btn-secondary" :disabled="previewing" @click="preview">
              {{ previewing ? "Discovering…" : "Preview tools" }}
            </button>
            <span v-if="previewTools" class="preview-count">{{ previewTools.length }} tool(s) discovered</span>
          </div>
          <p v-if="previewError" class="error">{{ previewError }}</p>
          <TableCard v-if="previewTools && previewTools.length">
            <thead>
              <tr>
                <th>Name</th>
                <th>Method</th>
                <th>Endpoint</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="t in previewTools" :key="t.name">
                <td>{{ t.name }}</td>
                <td>
                  <code>{{ t.method }}</code>
                </td>
                <td class="ep">{{ t.endpoint }}</td>
              </tr>
            </tbody>
          </TableCard>
        </template>

        <template v-else-if="kind === 'graphql'">
          <FormField label="GraphQL URL" for="r-graphql-url">
            <input id="r-graphql-url" v-model="graphqlUrl" type="url" placeholder="https://api.example.com/graphql" />
          </FormField>
          <FormField label="Health URL (optional — defaults to the GraphQL URL)" for="r-graphql-health">
            <input
              id="r-graphql-health"
              v-model="graphqlHealthUrl"
              type="url"
              placeholder="https://api.example.com/health"
            />
            <p class="hint">
              Many GraphQL servers reject a bare GET on the operation endpoint. If you have a dedicated liveness
              endpoint, use it here to avoid false health-check failures.
            </p>
          </FormField>
          <label class="checkline"><input v-model="includeMutations" type="checkbox" /> Include mutations</label>
          <div class="preview-row">
            <button type="button" class="btn-secondary" :disabled="previewing" @click="previewGraphql">
              {{ previewing ? "Discovering…" : "Preview tools" }}
            </button>
            <span v-if="previewTools" class="preview-count">{{ previewTools.length }} tool(s) discovered</span>
          </div>
          <p v-if="previewError" class="error">{{ previewError }}</p>
          <TableCard v-if="previewTools && previewTools.length">
            <thead>
              <tr>
                <th>Name</th>
                <th>Method</th>
                <th>Endpoint</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="t in previewTools" :key="t.name">
                <td>{{ t.name }}</td>
                <td>
                  <code>{{ t.method }}</code>
                </td>
                <td class="ep">{{ t.endpoint }}</td>
              </tr>
            </tbody>
          </TableCard>
        </template>

        <template v-else>
          <FormField label="MCP server URL" for="r-mcp-url">
            <input id="r-mcp-url" v-model="mcpUrl" type="url" required placeholder="https://mcp.example.com/mcp" />
          </FormField>
          <FormField label="Transport" for="r-mcp-transport">
            <SelectMenu id="r-mcp-transport" v-model="mcpTransport" :options="TRANSPORT_OPTIONS" />
          </FormField>
          <p class="hint">
            The bridge connects to the MCP server and discovers its tools on registration. If the server requires
            authentication, register it first, set upstream credentials on its detail page, then re-discover.
          </p>
        </template>

        <p v-if="kind === 'rest' && !previewTools && !previewStale" class="hint">
          Run Preview tools first so you can confirm what will be registered.
        </p>
        <p v-if="kind === 'rest' && !previewTools && previewStale" class="hint warn">
          Preview is out of date — run it again before registering.
        </p>
        <p v-if="error" class="error" role="alert">{{ error }}</p>
        <button type="submit" class="btn-primary" :disabled="registering || (kind === 'rest' && !previewTools)">
          {{ registering ? "Registering…" : "Register server" }}
        </button>
      </form>
    </FormPage>
  </section>
</template>

<style scoped>
.reg-form {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-xs);
  padding: 1.25rem;
  display: flex;
  flex-direction: column;
  gap: 0.85rem;
  margin: 1rem 0;
}
:deep(.field textarea) {
  font-family: var(--font-mono);
  font-size: 0.82rem;
}
.hint {
  font-size: 0.82rem;
  color: var(--text-secondary);
  margin: 0;
}
.hint.warn {
  color: var(--canary);
  font-weight: 600;
}
:deep(.field input[type="file"]) {
  padding: 0.4rem 0;
  border: none;
}
.postman-paste-label {
  display: block;
  font-size: 0.8rem;
  color: var(--text-secondary);
  margin: 0.6rem 0 0.3rem;
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
:deep(.data-table .ep) {
  color: var(--text-secondary);
}
</style>
