<script setup lang="ts">
import { ref, computed } from "vue";
import { api } from "@/composables/useApi";
import { toErrorMessage } from "@/utils/errors";
import type { ClientDetail, DiscoveredTool, DiscoveryPreview } from "@/types/api";
import ConfigSection from "./ConfigSection.vue";

const props = defineProps<{ detail: ClientDetail }>();
const emit = defineEmits<{ resynced: [] }>();

const resyncOpen = ref(false);
const resyncUrl = ref("");
const resyncPreview = ref<DiscoveredTool[] | null>(null);
const resyncing = ref(false);
const applyingResync = ref(false);
const resyncError = ref("");

const resyncDiff = computed(() => {
  if (!resyncPreview.value) return null;
  const current = new Set(props.detail.tools.map((t) => t.name));
  const next = new Set(resyncPreview.value.map((t) => t.name));
  return {
    added: [...next].filter((n) => !current.has(n)),
    removed: [...current].filter((n) => !next.has(n)),
    kept: [...next].filter((n) => current.has(n)),
  };
});

async function previewResync() {
  resyncError.value = "";
  resyncPreview.value = null;
  if (!resyncUrl.value.trim()) {
    resyncError.value = "Enter the OpenAPI URL.";
    return;
  }
  resyncing.value = true;
  try {
    const res = await api.post<DiscoveryPreview>("/admin-api/discovery/preview", {
      openapi_url: resyncUrl.value.trim(),
    });
    resyncPreview.value = res.tools;
  } catch (err) {
    resyncError.value = toErrorMessage(err, "Preview failed.");
  } finally {
    resyncing.value = false;
  }
}

async function applyResync() {
  applyingResync.value = true;
  resyncError.value = "";
  try {
    await api.post("/register", {
      name: props.detail.name,
      health_url: props.detail.healthUrl,
      base_url: props.detail.baseUrl,
      openapi_url: resyncUrl.value.trim(),
    });
    resyncOpen.value = false;
    resyncPreview.value = null;
    resyncUrl.value = "";
    emit("resynced");
  } catch (err) {
    resyncError.value = toErrorMessage(err, "Re-sync failed.");
  } finally {
    applyingResync.value = false;
  }
}

async function rediscoverMcp() {
  if (!props.detail.mcpUrl) return;
  applyingResync.value = true;
  resyncError.value = "";
  try {
    await api.post("/register", {
      kind: "mcp",
      name: props.detail.name,
      mcp_url: props.detail.mcpUrl,
      mcp_transport: props.detail.mcpTransport ?? "streamable-http",
    });
    emit("resynced");
  } catch (err) {
    resyncError.value = toErrorMessage(err, "Re-discovery failed.");
  } finally {
    applyingResync.value = false;
  }
}
</script>

<template>
  <ConfigSection v-if="detail.kind === 'mcp'" title="Re-discover tools">
    <template #actions>
      <button type="button" class="btn-secondary" :disabled="applyingResync" @click="rediscoverMcp">
        {{ applyingResync ? "Discovering…" : "Re-discover from MCP server" }}
      </button>
    </template>
    <p class="ua-status">
      Re-connects to <code>{{ detail.mcpUrl }}</code> and refreshes this server's tool list.
    </p>
    <p v-if="resyncError" class="error">{{ resyncError }}</p>
  </ConfigSection>

  <ConfigSection v-else title="Re-sync from OpenAPI">
    <template #actions>
      <button type="button" class="btn-secondary" @click="resyncOpen = !resyncOpen">
        {{ resyncOpen ? "Cancel" : "Re-sync" }}
      </button>
    </template>
    <div v-if="resyncOpen" class="resync-body">
      <div class="field-inline">
        <input v-model="resyncUrl" type="url" placeholder="https://api.example.com/openapi.json" />
        <button type="button" class="btn-secondary" :disabled="resyncing" @click="previewResync">
          {{ resyncing ? "Discovering…" : "Preview diff" }}
        </button>
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
  </ConfigSection>
</template>
