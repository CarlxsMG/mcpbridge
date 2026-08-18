<script setup lang="ts">
/**
 * Register a server in one field.
 *
 * The flow is: paste something → see the tools it will expose → register →
 * get a config your assistant accepts. Everything else (the kind toggle, the
 * discovery-mode toggle, the name, the health/base URLs, the OpenAPI filters)
 * is either inferred by `@/utils/registerSource` or moved behind the Advanced
 * disclosure, which opens itself when inference could not fill a required
 * field.
 *
 * Two rules the layout encodes:
 *  - Nothing inferred or derived is applied silently. The resolved source is
 *    stated with a one-click correction, and the derived name/health URL are
 *    named under the field and editable in Advanced.
 *  - The tool preview stays the most prominent thing on the page. It is the
 *    only moment the user sees what they are actually getting, and REST/GraphQL
 *    submission is still gated behind it.
 */
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { api, ApiError } from "@/composables/useApi";
import { parseList } from "@/utils/fieldParsing";
import { toErrorMessage } from "@/utils/errors";
import { focusFirstInvalid } from "@/utils/focusFirstInvalid";
import {
  SOURCE_TARGETS,
  clientNameIssue,
  detectSource,
  deriveFromSourceUrl,
  type SourceId,
} from "@/utils/registerSource";
import { tk } from "@/i18n";
import type { DiscoveryPreview, DiscoveredTool, McpTransport } from "@/types/api";
import PageHeader from "@/components/ui/PageHeader.vue";
import TableCard from "@/components/ui/TableCard.vue";
import FormPage from "@/components/ui/FormPage.vue";
import FieldError from "@/components/ui/FieldError.vue";
import UnsavedChangesDialog from "@/components/ui/UnsavedChangesDialog.vue";
import RegisterSourceField from "@/components/register-server/RegisterSourceField.vue";
import RegisterAdvancedFields from "@/components/register-server/RegisterAdvancedFields.vue";
import RegisterConnectStep from "@/components/register-server/RegisterConnectStep.vue";

const { t } = useI18n({ useScope: "global" });

const source = ref("");
const sourceError = ref("");

/**
 * The user's correction, when they made one. It deliberately survives further
 * edits to the source text and is only dropped when the field is emptied: an
 * explicit choice must outrank the heuristic, and re-asking after every
 * keystroke is exactly the stranding this page exists to remove.
 *
 * That includes surviving text the form cannot register at all — `activeSource`
 * below refuses to act on it there, so the standing choice costs nothing and is
 * still waiting once the user pastes something registerable back.
 */
const override = ref<SourceId | null>(null);

const detection = computed(() => detectSource(source.value));

/**
 * The source the rest of the page acts on — `null` whenever nothing can be
 * acted on, including ahead of the user's own override.
 *
 * An unregisterable input (`detection.unsupported`) has no source that would
 * work, so an override picked for the PREVIOUS paste must not survive into it:
 * loading an openapi.json from disk after choosing "OpenAPI URL" for an
 * extension-less URL would otherwise leave Preview enabled and post the whole
 * document as `openapi_url`, producing the URL-validation error that the
 * dead-end message right above it is explaining.
 *
 * Collapsing it here rather than adding a second "not actionable" flag is what
 * keeps that contradiction unrepresentable: the preview gate, `validate()`, the
 * payload builders and the derived name/health URL all already read this one
 * value, so a future `UnsupportedInput` member is handled by all of them at once.
 */
const activeSource = computed<SourceId | null>(() =>
  detection.value.unsupported ? null : (override.value ?? detection.value.detected),
);
const kind = computed(() => (activeSource.value ? SOURCE_TARGETS[activeSource.value].kind : "rest"));
const mode = computed(() => (activeSource.value ? SOURCE_TARGETS[activeSource.value].mode : "openapi"));

const derived = computed(() => (activeSource.value ? deriveFromSourceUrl(source.value) : null));

/**
 * Only REST clients get a derived health URL. An MCP upstream has none at all
 * (it is probed with a JSON-RPC ping), and a GraphQL endpoint typically refuses
 * a bare GET — which is why the backend's own default for it, and the hint under
 * the field, both stay in charge there rather than this guess.
 */
const derivedHealthUrl = computed(() => (kind.value === "rest" ? (derived.value?.healthUrl ?? "") : ""));

/**
 * Derived values flow through until the user types over them, then their input
 * sticks — that is what `null` means here. A watcher assigning into a plain ref
 * instead would clobber an edit every time the URL changed.
 */
const nameEdit = ref<string | null>(null);
const healthUrlEdit = ref<string | null>(null);

const name = computed({
  get: () => nameEdit.value ?? derived.value?.name ?? "",
  set: (value: string) => {
    nameEdit.value = value;
  },
});
const healthUrl = computed({
  get: () => healthUrlEdit.value ?? derivedHealthUrl.value,
  set: (value: string) => {
    healthUrlEdit.value = value;
  },
});

const baseUrl = ref("");
const includeTags = ref("");
const excludeOps = ref("");
const mcpTransport = ref<McpTransport>("streamable-http");
const includeMutations = ref(true);

const nameError = ref("");
const healthUrlError = ref("");

const advancedOpen = ref(false);

/** A field the user must supply because nothing could be derived for it. */
const missingRequired = computed(() => {
  if (!activeSource.value) return false;
  if (!name.value) return true;
  return kind.value === "rest" && !healthUrl.value;
});

// Only ever opens. Closing is the user's call — but hiding the field that is
// blocking submission behind a closed disclosure is not.
watch(missingRequired, (missing) => {
  if (missing) advancedOpen.value = true;
});

const previewTools = ref<DiscoveredTool[] | null>(null);
const previewStale = ref(false);
const previewing = ref(false);
const previewError = ref("");
const registering = ref(false);
const error = ref("");
const registered = ref<{ name: string; toolsCount: number } | null>(null);

const previewFallback = tk("errors.preview_failed");

/** MCP upstreams discover their tools during registration — there is no preview endpoint for them. */
const canPreview = computed(() => kind.value !== "mcp");

function parseJsonSource(label: string): unknown {
  try {
    return JSON.parse(source.value);
  } catch {
    throw new Error(t("pages.register_server.errors.invalid_json", { label }));
  }
}

function buildRestDiscoveryPayload(): Record<string, unknown> {
  const trimmed = source.value.trim();
  if (mode.value === "openapi") {
    return {
      openapi_url: trimmed,
      include_tags: parseList(includeTags.value),
      exclude_operations: parseList(excludeOps.value),
    };
  }
  if (mode.value === "curl") return { curl_input: source.value };
  if (mode.value === "postman")
    return { postman_collection: parseJsonSource(t("pages.register_server.postman_label")) };
  return { tools: parseJsonSource(t("pages.register_server.manual_label")) };
}

function pickSource(id: SourceId) {
  override.value = id;
  sourceError.value = "";
}

async function preview() {
  previewError.value = "";
  previewTools.value = null;
  if (!activeSource.value) {
    previewError.value = t("pages.register_server.errors.source_required");
    return;
  }

  let payload: Record<string, unknown>;
  try {
    payload = kind.value === "graphql" ? buildGraphqlPreviewPayload() : buildRestDiscoveryPayload();
  } catch (err) {
    previewError.value = err instanceof Error ? err.message : t("pages.register_server.errors.source_required");
    return;
  }

  const path = kind.value === "graphql" ? "/admin-api/discovery/preview-graphql" : "/admin-api/discovery/preview";
  previewing.value = true;
  try {
    const res = await api.post<DiscoveryPreview>(path, payload);
    previewTools.value = res.tools;
    previewStale.value = false;
  } catch (err) {
    previewError.value = toErrorMessage(err, previewFallback);
  } finally {
    previewing.value = false;
  }
}

function buildGraphqlPreviewPayload(): Record<string, unknown> {
  return { graphql_url: source.value.trim(), include_mutations: includeMutations.value };
}

// Any change to what would be discovered invalidates a shown preview: leaving it
// up would both mislabel the tools and keep the preview-gated submit enabled.
watch([source, activeSource, includeTags, excludeOps, includeMutations], () => {
  if (previewTools.value) previewStale.value = true;
  previewTools.value = null;
});

watch(source, (value) => {
  if (!value.trim()) override.value = null;
  sourceError.value = "";
});

function validate(): boolean {
  sourceError.value = "";
  nameError.value = "";
  healthUrlError.value = "";

  if (!activeSource.value) {
    sourceError.value = t("pages.register_server.errors.source_required");
  }
  const issue = clientNameIssue(name.value.trim());
  if (issue) nameError.value = t(`pages.register_server.errors.name_${issue}`);
  if (kind.value === "rest" && !healthUrl.value.trim()) {
    healthUrlError.value = t("pages.register_server.errors.health_required");
  }

  if (!nameError.value && !healthUrlError.value && !sourceError.value) return true;
  // The offending control may be inside the closed disclosure; open it before
  // focusing, or the focus call lands on an element the user cannot see.
  if (nameError.value || healthUrlError.value) advancedOpen.value = true;
  void focusFirstInvalid();
  return false;
}

function buildRegisterPayload(clientName: string): Record<string, unknown> {
  if (kind.value === "mcp") {
    return { kind: "mcp", name: clientName, mcp_url: source.value.trim(), mcp_transport: mcpTransport.value };
  }
  if (kind.value === "graphql") {
    return {
      kind: "graphql",
      name: clientName,
      graphql_url: source.value.trim(),
      health_url: healthUrl.value.trim() || undefined,
      include_mutations: includeMutations.value,
    };
  }
  const payload: Record<string, unknown> = { name: clientName, health_url: healthUrl.value.trim() };
  if (baseUrl.value.trim()) payload.base_url = baseUrl.value.trim();
  return { ...payload, ...buildRestDiscoveryPayload() };
}

async function register() {
  error.value = "";
  if (!validate()) return;

  const clientName = name.value.trim();
  registering.value = true;
  try {
    // `tools_count` is on every branch of POST /register's success body; the
    // preview length is the fallback for a response shape that ever loses it.
    const res = await api.post<{ tools_count?: number }>("/register", buildRegisterPayload(clientName));
    registered.value = {
      name: clientName,
      toolsCount: typeof res.tools_count === "number" ? res.tools_count : (previewTools.value?.length ?? 0),
    };
  } catch (err) {
    if (err instanceof ApiError) error.value = err.message;
    else if (err instanceof Error) error.value = err.message;
    else error.value = t("pages.register_server.errors.registration_failed");
  } finally {
    registering.value = false;
  }
}

function startOver() {
  registered.value = null;
  source.value = "";
  override.value = null;
  nameEdit.value = null;
  healthUrlEdit.value = null;
  baseUrl.value = "";
  includeTags.value = "";
  excludeOps.value = "";
  previewTools.value = null;
  previewStale.value = false;
  previewError.value = "";
  error.value = "";
  advancedOpen.value = false;
}

const isDirty = computed(
  () =>
    Boolean(source.value.trim()) ||
    Boolean(nameEdit.value) ||
    Boolean(healthUrlEdit.value) ||
    Boolean(baseUrl.value.trim()) ||
    Boolean(includeTags.value.trim()) ||
    Boolean(excludeOps.value.trim()),
);
</script>

<template>
  <section>
    <FormPage max-width="50rem">
      <PageHeader
        :title="t('pages.register_server.title')"
        :back-link="{ to: '/servers', label: t('pages.register_server.back_to_servers') }"
      />

      <RegisterConnectStep
        v-if="registered"
        :server-name="registered.name"
        :tools-count="registered.toolsCount"
        @add-another="startOver"
      />

      <form v-else class="reg-form" novalidate @submit.prevent="register">
        <RegisterSourceField
          v-model:source="source"
          :detection="detection"
          :active-source="activeSource"
          :overridden="override !== null"
          :error="sourceError"
          @pick="pickSource"
        />

        <!-- Derived values are stated here, not just written into the closed
             disclosure, so a name or health URL the user never typed can never
             reach POST /register unseen. -->
        <p v-if="derived && name" class="derived">
          {{
            healthUrl
              ? t("pages.register_server.derived_note", { name, healthUrl })
              : t("pages.register_server.derived_name_note", { name })
          }}
        </p>

        <template v-if="canPreview">
          <div class="preview-row">
            <button type="button" class="btn-secondary" :disabled="previewing || !activeSource" @click="preview">
              {{ previewing ? t("pages.register_server.discovering") : t("pages.register_server.preview_tools") }}
            </button>
            <span v-if="previewTools" class="preview-count">{{
              t("pages.register_server.preview_count", { count: previewTools.length }, previewTools.length)
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
          <p v-if="!previewTools && !previewStale" class="hint">{{ t("pages.register_server.preview_hint") }}</p>
          <p v-if="!previewTools && previewStale" class="hint warn">
            {{ t("pages.register_server.preview_stale_hint") }}
          </p>
        </template>
        <p v-else class="hint">{{ t("pages.register_server.mcp_no_preview_hint") }}</p>

        <RegisterAdvancedFields
          v-model:open="advancedOpen"
          v-model:name="name"
          v-model:health-url="healthUrl"
          v-model:base-url="baseUrl"
          v-model:include-tags="includeTags"
          v-model:exclude-ops="excludeOps"
          v-model:mcp-transport="mcpTransport"
          v-model:include-mutations="includeMutations"
          :kind="kind"
          :mode="mode"
          :name-error="nameError"
          :health-url-error="healthUrlError"
        />

        <FieldError :message="error" />
        <button type="submit" class="btn-primary" :disabled="registering || (canPreview && !previewTools)">
          {{ registering ? t("pages.register_server.registering") : t("pages.register_server.register_server") }}
        </button>
      </form>
    </FormPage>

    <UnsavedChangesDialog :dirty="isDirty" :bypass="registering || registered !== null" />
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
.derived {
  font-size: 0.82rem;
  color: var(--text-secondary);
  margin: 0;
}
.hint {
  font-size: 0.82rem;
  color: var(--text-secondary);
  margin: 0;
}
.hint.warn {
  color: var(--canary-text);
  font-weight: 600;
}
/* The preview is the payoff step, so its trigger and count sit on their own row
   above the table rather than being folded into the field stack. */
.preview-row {
  display: flex;
  align-items: center;
  gap: 0.75rem;
}
.preview-count {
  font-size: 0.85rem;
  color: var(--ok-text);
}
:deep(.data-table .ep) {
  color: var(--text-secondary);
}
</style>
