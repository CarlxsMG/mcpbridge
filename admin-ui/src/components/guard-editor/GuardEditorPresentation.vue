<script setup lang="ts">
import { ref, computed, watch } from "vue";
import { useI18n } from "vue-i18n";
import { usePatchTool } from "@/composables/usePatchTool";
import { useFlash } from "@/composables/useFlash";
import { usePropDraft } from "@/composables/useFieldDraft";
import SaveRow from "@/components/ui/SaveRow.vue";
import { tk } from "@/i18n";

const props = defineProps<{
  override?: { description?: string; params?: Record<string, { description?: string }>; displayName?: string };
  clientName?: string;
  toolName?: string;
}>();
const emit = defineEmits<{ saved: [] }>();
const { t } = useI18n({ useScope: "global" });

const descriptionInput = usePropDraft(() => props.override?.description ?? "");
const displayNameInput = usePropDraft(() => props.override?.displayName ?? "");
const displayNameTouched = ref(false);
const saved = ref(false);

// Drawer isn't remounted on tool switch, so the touched flag needs its own reset here.
watch(
  () => props.override,
  () => {
    displayNameTouched.value = false;
  },
);

const displayNameError = computed(() => {
  const v = displayNameInput.value.trim();
  if (!v) return null;
  return /^[a-z0-9][a-z0-9_-]{0,62}$/.test(v) ? null : t("components.guard_editor_presentation.name_error");
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
  const ok = await patchField("overrides", payload, tk("components.guard_editor_presentation.errors.save_failed"));
  if (ok) {
    flash(saved);
    emit("saved");
  }
}
</script>

<template>
  <h3>{{ t("components.guard_editor_presentation.title") }}</h3>
  <div class="field">
    <label for="tool-display-name">{{ t("components.guard_editor_presentation.name_label") }}</label>
    <p class="hint">
      {{ t("components.guard_editor_presentation.name_hint_p1") }}
      <code>{{ clientName ?? "client" }}__</code>
      {{ t("components.guard_editor_presentation.name_hint_p2") }}
      {{ t("components.guard_editor_presentation.advertised_as") }}: <code>{{ advertisedName }}</code>
    </p>
    <input
      id="tool-display-name"
      v-model="displayNameInput"
      type="text"
      :placeholder="t('components.guard_editor_presentation.name_placeholder')"
      @keydown.enter.prevent
      @blur="displayNameTouched = true"
    />
    <p v-if="displayNameTouched && displayNameError" class="field-error" role="alert">{{ displayNameError }}</p>
  </div>

  <div class="field">
    <label for="tool-desc">{{ t("components.guard_editor_presentation.desc_label") }}</label>
    <p class="hint">
      {{ t("components.guard_editor_presentation.desc_hint") }}
    </p>
    <textarea
      id="tool-desc"
      v-model="descriptionInput"
      rows="3"
      :placeholder="t('components.guard_editor_presentation.desc_placeholder')"
    ></textarea>
    <SaveRow
      :label="t('components.guard_editor_presentation.save')"
      :saving="saving"
      :saved="saved"
      :error="error"
      @save="saveOverrideFn"
    />
  </div>
</template>
