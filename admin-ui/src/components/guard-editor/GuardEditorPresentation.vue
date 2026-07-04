<script setup lang="ts">
import { ref, computed, watch } from "vue";
import { usePatchTool } from "@/composables/usePatchTool";
import { useFlash } from "@/composables/useFlash";
import SaveRow from "@/components/ui/SaveRow.vue";

const props = defineProps<{
  override?: { description?: string; params?: Record<string, { description?: string }>; displayName?: string };
  clientName?: string;
  toolName?: string;
}>();
const emit = defineEmits<{ saved: [] }>();

const descriptionInput = ref(props.override?.description ?? "");
const displayNameInput = ref(props.override?.displayName ?? "");
const displayNameTouched = ref(false);
const saved = ref(false);

watch(
  () => props.override,
  (o) => {
    descriptionInput.value = o?.description ?? "";
    displayNameInput.value = o?.displayName ?? "";
    displayNameTouched.value = false;
  },
);

const displayNameError = computed(() => {
  const v = displayNameInput.value.trim();
  if (!v) return null;
  return /^[a-z0-9][a-z0-9_-]{0,62}$/.test(v) ? null : "Lowercase letters, digits, - and _; 1-63 chars";
});

const advertisedName = computed(() => {
  const seg = displayNameInput.value.trim() || props.toolName || "tool";
  return `${props.clientName ?? "client"}__${seg}`;
});

const { saving, error, patchField } = usePatchTool(
  () => props.clientName ?? "",
  () => props.toolName,
);
const { flash } = useFlash();

async function saveOverrideFn() {
  if (displayNameError.value) return;
  const desc = descriptionInput.value.trim();
  const displayName = displayNameInput.value.trim();
  const params = props.override?.params;
  // Preserve any param-level overrides set via the API; the UI edits the
  // description and the display-name alias.
  const payload =
    !desc && !displayName && (!params || Object.keys(params).length === 0)
      ? null
      : { description: desc || undefined, displayName: displayName || undefined, params };
  const ok = await patchField("overrides", payload, "Failed to save the presentation override.");
  if (ok) {
    flash(saved);
    emit("saved");
  }
}
</script>

<template>
  <h3>Presentation</h3>
  <div class="field">
    <label for="tool-display-name">Display name (alias)</label>
    <p class="hint">
      Renames the tool for MCP clients. The <code>{{ clientName ?? "client" }}__</code> prefix is always kept. Leave
      blank to use the registered name. Advertised as: <code>{{ advertisedName }}</code>
    </p>
    <input
      id="tool-display-name"
      v-model="displayNameInput"
      type="text"
      placeholder="e.g. issues"
      @keydown.enter.prevent
      @blur="displayNameTouched = true"
    />
    <p v-if="displayNameTouched && displayNameError" class="field-error">{{ displayNameError }}</p>
  </div>

  <div class="field">
    <label for="tool-desc">Advertised description override</label>
    <p class="hint">
      Replaces what MCP clients see for this tool in tools/list. Leave blank to use the registered description.
    </p>
    <textarea
      id="tool-desc"
      v-model="descriptionInput"
      rows="3"
      placeholder="Registered description is used when blank"
    ></textarea>
    <SaveRow label="Save presentation" :saving="saving" :saved="saved" :error="error" @save="saveOverrideFn" />
  </div>
</template>
