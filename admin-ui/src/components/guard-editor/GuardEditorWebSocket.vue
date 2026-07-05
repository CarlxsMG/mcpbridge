<script setup lang="ts">
import { ref, computed } from "vue";
import { useI18n } from "vue-i18n";
import { usePatchTool } from "@/composables/usePatchTool";
import { useFlash } from "@/composables/useFlash";
import { usePropDraft } from "@/composables/useFieldDraft";
import SaveRow from "@/components/ui/SaveRow.vue";
import { tk } from "@/i18n";

const props = defineProps<{
  ws?: { enabled: boolean; wsUrl: string; persistent: boolean };
  clientName?: string;
  toolName?: string;
}>();
const emit = defineEmits<{ saved: [] }>();
const { t } = useI18n({ useScope: "global" });

const wsEnabledInput = usePropDraft(() => Boolean(props.ws?.enabled));
const wsUrlInput = usePropDraft(() => props.ws?.wsUrl ?? "");
const wsPersistentInput = usePropDraft(() => props.ws?.persistent ?? false);
const saved = ref(false);

const wsUrlError = computed(() => {
  if (!wsEnabledInput.value) return null;
  return /^wss?:\/\//.test(wsUrlInput.value.trim()) ? null : t("components.guard_editor_websocket.url_error");
});

const { saving, error, patchField } = usePatchTool(
  () => props.clientName ?? "",
  () => props.toolName,
);
const { flash } = useFlash();

async function saveWsFn() {
  if (!wsEnabledInput.value) {
    const ok = await patchField("ws", null, tk("components.guard_editor_websocket.errors.save_failed"));
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
    tk("components.guard_editor_websocket.errors.save_failed"),
  );
  if (ok) {
    flash(saved);
    emit("saved");
  }
}
</script>

<template>
  <h3>{{ t("components.guard_editor_websocket.title") }}</h3>
  <div class="field">
    <label class="checkline"
      ><input v-model="wsEnabledInput" type="checkbox" />
      {{ t("components.guard_editor_websocket.enable_label") }}</label
    >
    <template v-if="wsEnabledInput">
      <label for="ws-url">{{ t("components.guard_editor_websocket.url_label") }}</label>
      <input id="ws-url" v-model="wsUrlInput" type="text" placeholder="wss://example.com/socket" />
      <p v-if="wsUrlError" class="field-error">{{ wsUrlError }}</p>
      <label class="checkline"
        ><input v-model="wsPersistentInput" type="checkbox" />
        {{ t("components.guard_editor_websocket.persistent_label") }}</label
      >
      <p class="hint">
        {{ t("components.guard_editor_websocket.hint") }}
      </p>
    </template>
    <SaveRow
      :label="t('components.guard_editor_websocket.save')"
      :saving="saving"
      :saved="saved"
      :error="error"
      @save="saveWsFn"
    />
  </div>
</template>
