<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { useRouter } from "vue-router";
import { api, ApiError } from "@/composables/useApi";
import { parseList } from "@/utils/fieldParsing";
import { toErrorMessage } from "@/utils/errors";
import { i18n } from "../i18n";
import type { DiscoveryPreview, DiscoveredTool, McpTransport } from "@/types/api";
import PageHeader from "@/components/ui/PageHeader.vue";
import TableCard from "@/components/ui/TableCard.vue";
import FormField from "@/components/ui/FormField.vue";
import SelectMenu from "@/components/ui/SelectMenu.vue";
import FormPage from "@/components/ui/FormPage.vue";

const { t } = useI18n({ useScope: "global" });
const tk = (key: string) => (i18n.global.t as (k: string) => string)(key);

const TRANSPORT_OPTIONS: { value: McpTransport; label: string }[] = [
  { value: "streamable-http", label: "Streamable HTTP" },
  { value: "sse", label: "SSE (legacy)" },
];

const router = useRouter();

const kind = ref<"rest" | "mcp" | "graphql">("rest");
const name = ref("");

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

const mcpUrl = ref("");
const mcpTransport = ref<McpTransport>("streamable-http");

const graphqlUrl = ref("");
const includeMutations = ref(true);
const graphqlHealthUrl = ref("");

const previewTools = ref<DiscoveredTool[] | null>(null);
const previewStale = ref(false);
const previewing = ref(false);
const previewError = ref("");
const registering = ref(false);
const error = ref("");

const previewFallback = tk("errors.preview_failed");

function parseJsonField(raw: string, label: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(t("pages.register_server.errors.invalid_json", { label }));
  }
}

function buildRestDiscoveryPayload(): Record<string, unknown> {
  if (mode.value === "openapi") {
    if (!openapiUrl.value.trim()) throw new Error(t("pages.register_server.errors.openapi_url_required"));
    return {
      openapi_url: openapiUrl.value.trim(),
      include_tags: parseList(includeTags.value),
      exclude_operations: parseList(excludeOps.value),
    };
  }
  if (mode.value === "manual") {
    if (!manualTools.value.trim()) throw new Error(t("pages.register_server.errors.manual_tools_required"));
    return { tools: parseJsonField(manualTools.value, "Tools") };
  }
  if (mode.value === "curl") {
    if (!curlInput.value.trim()) throw new Error(t("pages.register_server.errors.curl_required"));
    return { curl_input: curlInput.value };
  }
  if (!postmanText.value.trim()) throw new Error(t("pages.register_server.errors.postman_required"));
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
    previewError.value = toErrorMessage(err, previewFallback);
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
    previewError.value = t("pages.register_server.errors.graphql_url_required");
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
    previewError.value = toErrorMessage(err, previewFallback);
  } finally {
    previewing.value = false;
  }
}

watch([graphqlUrl, includeMutations], () => {
  previewTools.value = null;
});

const previewFn = computed(() => (kind.value === "graphql" ? previewGraphql : preview));

async function register() {
  error.value = "";
  registering.value = true;
  try {
    if (kind.value === "mcp") {
      if (!name.value.trim() || !mcpUrl.value.trim()) {
        error.value = t("pages.register_server.errors.name_and_mcp_required");
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
        error.value = t("pages.register_server.errors.name_and_graphql_required");
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
      error.value = t("pages.register_server.errors.name_and_health_required");
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
    else error.value = t("pages.register_server.errors.registration_failed");
  } finally {
    registering.value = false;
  }
}
</script>

<template>
  <section>
    <FormPage max-width="50rem">
      <PageHeader
        :title="t('pages.register_server.title')"
        :back-link="{ to: '/servers', label: t('pages.register_server.back_to_servers') }"
      />

      <form class="reg-form" @submit.prevent="register">
        <div class="segmented" role="radiogroup" :aria-label="t('pages.register_server.kind_aria')">
          <label
            ><input v-model="kind" type="radio" name="kind" value="rest" />
            {{ t("pages.register_server.kind_rest") }}</label
          >
          <label
            ><input v-model="kind" type="radio" name="kind" value="graphql" />
            {{ t("pages.register_server.kind_graphql") }}</label
          >
          <label
            ><input v-model="kind" type="radio" name="kind" value="mcp" />
            {{ t("pages.register_server.kind_mcp") }}</label
          >
        </div>

        <FormField :label="t('pages.register_server.name_label')" for="r-name">
          <input
            id="r-name"
            v-model="name"
            type="text"
            required
            :placeholder="t('pages.register_server.name_placeholder')"
          />
        </FormField>

        <template v-if="kind === 'rest'">
          <FormField :label="t('pages.register_server.health_url_label')" for="r-health">
            <input
              id="r-health"
              v-model="healthUrl"
              type="url"
              :placeholder="t('pages.register_server.health_url_placeholder')"
            />
          </FormField>
          <FormField :label="t('pages.register_server.base_url_label')" for="r-base">
            <input
              id="r-base"
              v-model="baseUrl"
              type="url"
              :placeholder="t('pages.register_server.base_url_placeholder')"
            />
          </FormField>

          <div class="segmented" role="radiogroup" :aria-label="t('pages.register_server.mode_aria')">
            <label
              ><input v-model="mode" type="radio" name="mode" value="openapi" />
              {{ t("pages.register_server.mode_openapi") }}</label
            >
            <label
              ><input v-model="mode" type="radio" name="mode" value="manual" />
              {{ t("pages.register_server.mode_manual") }}</label
            >
            <label
              ><input v-model="mode" type="radio" name="mode" value="curl" />
              {{ t("pages.register_server.mode_curl") }}</label
            >
            <label
              ><input v-model="mode" type="radio" name="mode" value="postman" />
              {{ t("pages.register_server.mode_postman") }}</label
            >
          </div>

          <template v-if="mode === 'openapi'">
            <FormField :label="t('pages.register_server.openapi_url_label')" for="r-openapi">
              <input
                id="r-openapi"
                v-model="openapiUrl"
                type="url"
                :placeholder="t('pages.register_server.openapi_url_placeholder')"
              />
            </FormField>
            <FormField :label="t('pages.register_server.include_tags_label')" for="r-tags">
              <input
                id="r-tags"
                v-model="includeTags"
                type="text"
                :placeholder="t('pages.register_server.include_tags_placeholder')"
              />
            </FormField>
            <FormField :label="t('pages.register_server.exclude_ops_label')" for="r-exclude">
              <input
                id="r-exclude"
                v-model="excludeOps"
                type="text"
                :placeholder="t('pages.register_server.exclude_ops_placeholder')"
              />
            </FormField>
          </template>

          <FormField
            v-else-if="mode === 'manual'"
            :label="t('pages.register_server.manual_tools_label')"
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

          <FormField v-else-if="mode === 'curl'" :label="t('pages.register_server.curl_label')" for="r-curl">
            <textarea
              id="r-curl"
              v-model="curlInput"
              rows="10"
              spellcheck="false"
              :placeholder="curlPlaceholder"
            ></textarea>
            <p class="hint">
              {{ t("pages.register_server.curl_hint") }}
            </p>
          </FormField>

          <FormField v-else :label="t('pages.register_server.postman_label')" for="r-postman-file">
            <input id="r-postman-file" type="file" accept="application/json,.json" @change="onPostmanFileChange" />
            <p v-if="postmanFileName" class="hint">
              {{ t("pages.register_server.postman_loaded", { name: postmanFileName }) }}
            </p>
            <label for="r-postman-text" class="postman-paste-label">{{
              t("pages.register_server.postman_paste_label")
            }}</label>
            <textarea id="r-postman-text" v-model="postmanText" rows="8" spellcheck="false"></textarea>
          </FormField>
        </template>

        <template v-else-if="kind === 'graphql'">
          <FormField :label="t('pages.register_server.graphql_url_label')" for="r-graphql-url">
            <input
              id="r-graphql-url"
              v-model="graphqlUrl"
              type="url"
              :placeholder="t('pages.register_server.graphql_url_placeholder')"
            />
          </FormField>
          <FormField :label="t('pages.register_server.graphql_health_label')" for="r-graphql-health">
            <input
              id="r-graphql-health"
              v-model="graphqlHealthUrl"
              type="url"
              :placeholder="t('pages.register_server.health_url_placeholder')"
            />
            <p class="hint">
              {{ t("pages.register_server.graphql_health_hint") }}
            </p>
          </FormField>
          <label class="checkline"
            ><input v-model="includeMutations" type="checkbox" />
            {{ t("pages.register_server.graphql_include_mutations") }}</label
          >
        </template>

        <template v-else>
          <FormField :label="t('pages.register_server.mcp_url_label')" for="r-mcp-url">
            <input
              id="r-mcp-url"
              v-model="mcpUrl"
              type="url"
              required
              :placeholder="t('pages.register_server.mcp_url_placeholder')"
            />
          </FormField>
          <FormField :label="t('pages.register_server.mcp_transport_label')" for="r-mcp-transport">
            <SelectMenu id="r-mcp-transport" v-model="mcpTransport" :options="TRANSPORT_OPTIONS" />
          </FormField>
          <p class="hint">
            {{ t("pages.register_server.mcp_transport_hint") }}
          </p>
        </template>

        <template v-if="kind === 'rest' || kind === 'graphql'">
          <div class="preview-row">
            <button type="button" class="btn-secondary" :disabled="previewing" @click="previewFn">
              {{ previewing ? t("pages.register_server.discovering") : t("pages.register_server.preview_tools") }}
            </button>
            <span v-if="previewTools" class="preview-count">{{
              t("pages.register_server.preview_count", { count: previewTools.length })
            }}</span>
          </div>
          <p v-if="previewError" class="error">{{ previewError }}</p>
          <TableCard v-if="previewTools && previewTools.length" id="preview-table">
            <thead>
              <tr>
                <th>{{ t("common.name") }}</th>
                <th>{{ t("common.method") }}</th>
                <th>{{ t("common.endpoint") }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="tool in previewTools" :key="tool.name">
                <td>{{ tool.name }}</td>
                <td>
                  <code>{{ tool.method }}</code>
                </td>
                <td class="ep">{{ tool.endpoint }}</td>
              </tr>
            </tbody>
          </TableCard>
        </template>

        <p v-if="kind === 'rest' && !previewTools && !previewStale" class="hint">
          {{ t("pages.register_server.preview_hint") }}
        </p>
        <p v-if="kind === 'rest' && !previewTools && previewStale" class="hint warn">
          {{ t("pages.register_server.preview_stale_hint") }}
        </p>
        <p v-if="error" class="error" role="alert">{{ error }}</p>
        <button type="submit" class="btn-primary" :disabled="registering || (kind === 'rest' && !previewTools)">
          {{ registering ? t("pages.register_server.registering") : t("pages.register_server.register_server") }}
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
