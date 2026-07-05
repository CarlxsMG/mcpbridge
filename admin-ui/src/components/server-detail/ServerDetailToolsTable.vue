<script setup lang="ts">
import { ref } from "vue";
import { useI18n } from "vue-i18n";
import { useRouter } from "vue-router";
import { api } from "@/composables/useApi";
import { useConfirmAction } from "@/composables/useConfirmAction";
import { toolPath } from "@/utils/apiPaths";
import { toErrorMessage } from "@/utils/errors";
import { tk } from "@/i18n";
import type { ToolDetail, UpstreamKind } from "@/types/api";
import ConfirmDialog from "@/components/ui/ConfirmDialog.vue";
import EmptyState from "@/components/ui/EmptyState.vue";
import TableCard from "@/components/ui/TableCard.vue";
import { Wrench } from "lucide-vue-next";

const props = defineProps<{ tools: ToolDetail[]; kind: UpstreamKind; clientName: string }>();
const { t } = useI18n({ useScope: "global" });

const router = useRouter();
const rowError = ref<Record<string, string>>({});
const testingTool = ref<string | null>(null);
const testResult = ref<{ tool: string; text: string; isError: boolean } | null>(null);

async function toggleToolField(
  tool: ToolDetail,
  field: "enabled" | "sensitive",
  computeNext: (tool: ToolDetail) => boolean,
  failureMessage: string,
) {
  const previous = tool[field];
  const next = computeNext(tool);
  (tool[field] as boolean) = next; // optimistic
  delete rowError.value[tool.name];
  try {
    await api.patch(toolPath(props.clientName, tool.name), { [field]: next });
  } catch (err) {
    (tool[field] as boolean | null | undefined) = previous;
    rowError.value[tool.name] = toErrorMessage(err, failureMessage);
  }
}

function toggleToolEnabled(tool: ToolDetail) {
  return toggleToolField(tool, "enabled", (t) => !t.enabled, tk("components.server_detail_tools.errors.update_failed"));
}

const {
  pending: pendingToolDisable,
  request: requestToolDisable,
  cancel: cancelToolDisable,
  confirm: confirmToolDisableAction,
} = useConfirmAction<ToolDetail>();

function onToolToggleClick(tool: ToolDetail) {
  if (tool.enabled) {
    requestToolDisable(tool);
  } else {
    toggleToolEnabled(tool);
  }
}

function confirmToolDisable() {
  return confirmToolDisableAction(async (tool) => {
    await toggleToolEnabled(tool);
  });
}

function toggleSensitive(tool: ToolDetail) {
  return toggleToolField(tool, "sensitive", (t) => t.sensitive !== true, tk("components.server_detail_tools.errors.update_sensitivity_failed"));
}

function openGuardEditor(tool: ToolDetail) {
  router.push(`/servers/${encodeURIComponent(props.clientName)}/tools/${encodeURIComponent(tool.name)}`);
}

async function testTool(tool: ToolDetail) {
  testingTool.value = tool.name;
  testResult.value = null;
  try {
    const result = await api.post<{ content: { type: string; text: string }[]; isError?: boolean }>(
      toolPath(props.clientName, tool.name, "test"),
      {},
    );
    testResult.value = {
      tool: tool.name,
      text: result.content.map((c) => c.text).join("\n"),
      isError: Boolean(result.isError),
    };
  } catch (err) {
    testResult.value = {
      tool: tool.name,
      text: toErrorMessage(err, tk("components.server_detail_tools.errors.test_failed")),
      isError: true,
    };
  } finally {
    testingTool.value = null;
  }
}
</script>

<template>
  <h2>{{ t('components.server_detail_tools.heading', { count: tools.length }) }}</h2>
  <TableCard v-if="tools.length" id="tools-table">
    <thead>
      <tr>
        <th>{{ t('components.server_detail_tools.table.name') }}</th>
        <th>{{ t('components.server_detail_tools.table.method') }}</th>
        <th>{{ t('components.server_detail_tools.table.endpoint') }}</th>
        <th>{{ t('components.server_detail_tools.table.guards') }}</th>
        <th>{{ t('components.server_detail_tools.table.sensitive') }}</th>
        <th>{{ t('components.server_detail_tools.table.enabled') }}</th>
        <th></th>
      </tr>
    </thead>
    <tbody>
      <tr v-for="tool in tools" :key="tool.name">
        <td>
          {{ tool.name }}
          <span v-for="tag in tool.tags" :key="tag" class="tag-chip">{{ tag }}</span>
        </td>
        <td>
          <code>{{ kind === "mcp" ? "MCP" : tool.method }}</code>
        </td>
        <td class="url-cell">{{ kind === "mcp" ? tool.upstreamName : tool.endpoint }}</td>
        <td>
          <button type="button" class="link-btn" @click="openGuardEditor(tool)">
            {{ tool.guards ? t('components.server_detail_tools.edit_guards') : t('components.server_detail_tools.add_guards') }}
          </button>
        </td>
        <td>
          <button type="button" class="link-btn" @click="toggleSensitive(tool)">
            {{ tool.sensitive === true ? t('components.server_detail_tools.sensitive_marked') : t('components.server_detail_tools.mark_sensitive') }}
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
            {{ tool.enabled ? t('common.enabled') : t('common.disabled') }}
          </button>
          <p v-if="rowError[tool.name]" class="row-error">{{ rowError[tool.name] }}</p>
        </td>
        <td>
          <button type="button" class="btn-secondary" :disabled="testingTool === tool.name" @click="testTool(tool)">
            {{ testingTool === tool.name ? t('components.server_detail_tools.testing') : t('components.server_detail_tools.test') }}
          </button>
        </td>
      </tr>
    </tbody>
  </TableCard>
  <EmptyState v-else :icon="Wrench">{{ t('components.server_detail_tools.empty') }}</EmptyState>

  <div v-if="testResult" class="test-result" :class="testResult.isError ? 'test-error' : 'test-ok'">
    <strong>{{ testResult.tool }}</strong>
    <pre>{{ testResult.text }}</pre>
  </div>

  <ConfirmDialog
    :open="pendingToolDisable !== null"
    :title="t('components.server_detail_tools.confirm.disable_title')"
    :message="pendingToolDisable ? t('components.server_detail_tools.confirm.disable_message', { name: pendingToolDisable.name }) : ''"
    :confirm-label="pendingToolDisable ? t('components.server_detail_tools.confirm.disable_cta', { name: pendingToolDisable.name }) : t('common.disable')"
    danger
    @confirm="confirmToolDisable"
    @cancel="cancelToolDisable"
  />
</template>