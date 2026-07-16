<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { useRouter } from "vue-router";
import { api, ApiError } from "@/composables/useApi";
import { parseList } from "@/utils/fieldParsing";
import { toErrorMessage } from "@/utils/errors";
import { useUnsavedChangesGuard } from "@/composables/useUnsavedChangesGuard";
import { tk } from "@/i18n";
import type { DiscoveryPreview, DiscoveredTool, McpTransport } from "@/types/api";
import PageHeader from "@/components/ui/PageHeader.vue";
import TableCard from "@/components/ui/TableCard.vue";
import FormField from "@/components/ui/FormField.vue";
import FormPage from "@/components/ui/FormPage.vue";
import FieldError from "@/components/ui/FieldError.vue";
import ConfirmDialog from "@/components/ui/ConfirmDialog.vue";
import RegisterRestFields from "@/components/register-server/RegisterRestFields.vue";
import RegisterGraphqlFields from "@/components/register-server/RegisterGraphqlFields.vue";
import RegisterMcpFields from "@/components/register-server/RegisterMcpFields.vue";

const { t } = useI18n({ useScope: "global" });

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

watch(kind, () => {
  previewTools.value = null;
  previewStale.value = false;
  previewError.value = "";
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

const isDirty = computed(
  () =>
    Boolean(name.value.trim()) ||
    Boolean(healthUrl.value.trim()) ||
    Boolean(baseUrl.value.trim()) ||
    Boolean(openapiUrl.value.trim()) ||
    Boolean(includeTags.value.trim()) ||
    Boolean(excludeOps.value.trim()) ||
    Boolean(manualTools.value.trim()) ||
    Boolean(curlInput.value.trim()) ||
    Boolean(postmanText.value.trim()) ||
    Boolean(mcpUrl.value.trim()) ||
    Boolean(graphqlUrl.value.trim()) ||
    Boolean(graphqlHealthUrl.value.trim()),
);
const { pendingLeave, confirmLeave, cancelLeave } = useUnsavedChangesGuard(isDirty, () => registering.value);
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

        <RegisterRestFields
          v-if="kind === 'rest'"
          v-model:health-url="healthUrl"
          v-model:base-url="baseUrl"
          v-model:mode="mode"
          v-model:openapi-url="openapiUrl"
          v-model:include-tags="includeTags"
          v-model:exclude-ops="excludeOps"
          v-model:manual-tools="manualTools"
          v-model:curl-input="curlInput"
          v-model:postman-text="postmanText"
          v-model:postman-file-name="postmanFileName"
        />

        <RegisterGraphqlFields
          v-else-if="kind === 'graphql'"
          v-model:graphql-url="graphqlUrl"
          v-model:graphql-health-url="graphqlHealthUrl"
          v-model:include-mutations="includeMutations"
        />

        <RegisterMcpFields v-else v-model:mcp-url="mcpUrl" v-model:mcp-transport="mcpTransport" />

        <template v-if="kind === 'rest' || kind === 'graphql'">
          <div class="preview-row">
            <button type="button" class="btn-secondary" :disabled="previewing" @click="previewFn">
              {{ previewing ? t("pages.register_server.discovering") : t("pages.register_server.preview_tools") }}
            </button>
            <span v-if="previewTools" class="preview-count">{{
              t("pages.register_server.preview_count", { count: previewTools.length })
            }}</span>
          </div>
          <FieldError :message="previewError" />
          <TableCard v-if="previewTools && previewTools.length" id="preview-table">
            <thead>
              <tr>
                <th scope="col">{{ t("common.name") }}</th>
                <th scope="col">{{ t("common.method") }}</th>
                <th scope="col">{{ t("common.endpoint") }}</th>
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

    <ConfirmDialog
      :open="pendingLeave"
      :title="t('pages.register_server.confirm.leave_title')"
      :message="t('pages.register_server.confirm.leave_message')"
      :confirm-label="t('pages.register_server.confirm.leave_cta')"
      danger
      @confirm="confirmLeave"
      @cancel="cancelLeave"
    />
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
.hint {
  font-size: 0.82rem;
  color: var(--text-secondary);
  margin: 0;
}
.hint.warn {
  color: var(--canary);
  font-weight: 600;
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
