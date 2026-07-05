<script setup lang="ts">
import { ref } from "vue";
import { useRouter } from "vue-router";
import { api } from "@/composables/useApi";
import { useConfirmAction } from "@/composables/useConfirmAction";
import { toolPath } from "@/utils/apiPaths";
import { toErrorMessage } from "@/utils/errors";
import type { ToolDetail, UpstreamKind } from "@/types/api";
import ConfirmDialog from "@/components/ui/ConfirmDialog.vue";
import EmptyState from "@/components/ui/EmptyState.vue";
import TableCard from "@/components/ui/TableCard.vue";
import { Wrench } from "lucide-vue-next";

const props = defineProps<{ tools: ToolDetail[]; kind: UpstreamKind; clientName: string }>();

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
  return toggleToolField(tool, "enabled", (t) => !t.enabled, "Failed to update.");
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
  return toggleToolField(tool, "sensitive", (t) => t.sensitive !== true, "Failed to update sensitivity.");
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
      text: toErrorMessage(err, "Test call failed."),
      isError: true,
    };
  } finally {
    testingTool.value = null;
  }
}
</script>

<template>
  <h2>Tools ({{ tools.length }})</h2>
  <TableCard v-if="tools.length">
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
  </TableCard>
  <EmptyState v-else :icon="Wrench">This server has no tools registered.</EmptyState>

  <div v-if="testResult" class="test-result" :class="testResult.isError ? 'test-error' : 'test-ok'">
    <strong>{{ testResult.tool }}</strong>
    <pre>{{ testResult.text }}</pre>
  </div>

  <ConfirmDialog
    :open="pendingToolDisable !== null"
    title="Disable this tool?"
    :message="
      pendingToolDisable
        ? `'${pendingToolDisable.name}' will stop working for all connected MCP agents until re-enabled.`
        : ''
    "
    :confirm-label="pendingToolDisable ? `Disable ${pendingToolDisable.name}` : 'Disable'"
    danger
    @confirm="confirmToolDisable"
    @cancel="cancelToolDisable"
  />
</template>
