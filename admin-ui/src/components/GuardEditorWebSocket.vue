<script setup lang="ts">
import { ref, computed, watch } from "vue";
import { usePatchTool } from "../composables/usePatchTool";
import { useFlash } from "../composables/useFlash";

const props = defineProps<{
  ws?: { enabled: boolean; wsUrl: string; persistent: boolean };
  clientName?: string;
  toolName?: string;
}>();
const emit = defineEmits<{ saved: [] }>();

const wsEnabledInput = ref(Boolean(props.ws?.enabled));
const wsUrlInput = ref(props.ws?.wsUrl ?? "");
const wsPersistentInput = ref(props.ws?.persistent ?? false);
const saved = ref(false);

watch(
  () => props.ws,
  (w) => {
    wsEnabledInput.value = Boolean(w?.enabled);
    wsUrlInput.value = w?.wsUrl ?? "";
    wsPersistentInput.value = w?.persistent ?? false;
  },
);

const wsUrlError = computed(() => {
  if (!wsEnabledInput.value) return null;
  return /^wss?:\/\//.test(wsUrlInput.value.trim()) ? null : "Must start with ws:// or wss://";
});

const { saving, error, patchField } = usePatchTool(
  () => props.clientName ?? "",
  () => props.toolName,
);
const { flash } = useFlash();

async function saveWsFn() {
  if (!wsEnabledInput.value) {
    const ok = await patchField("ws", null, "Failed to save WebSocket settings.");
    if (ok) {
      flash(saved);
      emit("saved");
    }
    return;
  }
  if (wsUrlError.value) return;
  const ok = await patchField(
    "ws",
    { enabled: true, wsUrl: wsUrlInput.value.trim(), persistent: wsPersistentInput.value },
    "Failed to save WebSocket settings.",
  );
  if (ok) {
    flash(saved);
    emit("saved");
  }
}
</script>

<template>
  <h3>WebSocket backend</h3>
  <div class="field">
    <label class="checkline"
      ><input v-model="wsEnabledInput" type="checkbox" /> Dispatch this tool over a WebSocket instead of REST</label
    >
    <template v-if="wsEnabledInput">
      <label for="ws-url">WebSocket URL</label>
      <input id="ws-url" v-model="wsUrlInput" type="text" placeholder="wss://example.com/socket" />
      <p v-if="wsUrlError" class="field-error">{{ wsUrlError }}</p>
      <label class="checkline"
        ><input v-model="wsPersistentInput" type="checkbox" /> Persistent connection — forward every message as
        progress instead of closing after the first</label
      >
      <p class="hint">
        Non-persistent (default) opens a fresh connection per call and returns the first message. Persistent stays
        open and resolves with the last message once the connection closes or the timeout elapses — intermediate
        messages are forwarded as MCP progress notifications to callers that requested them.
      </p>
    </template>
    <button
      type="button"
      class="btn-secondary desc-save"
      :disabled="saving || (wsEnabledInput && Boolean(wsUrlError))"
      @click="saveWsFn"
    >
      {{ saving ? "Saving…" : "Save WebSocket settings" }}
    </button>
    <span v-if="saved" class="save-ok">Saved</span>
    <p v-if="error" class="field-error">{{ error }}</p>
  </div>
</template>
