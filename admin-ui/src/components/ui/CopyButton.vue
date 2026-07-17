<script setup lang="ts">
import { useI18n } from "vue-i18n";
import { Copy, Check } from "lucide-vue-next";
import { useClipboard } from "@/composables/useClipboard";

const props = defineProps<{
  /** Value copied to the clipboard on click. */
  text: string;
  /** Rendered next to the icon when provided; otherwise the button is icon-only with an aria-label. */
  label?: string;
}>();

const { copied, copy } = useClipboard();
const { t } = useI18n({ useScope: "global" });

function copyText() {
  copy(props.text);
}
</script>

<template>
  <button
    type="button"
    class="btn-secondary copy-btn"
    :aria-label="label ? undefined : copied ? t('common.copied') : t('common.copy')"
    @click="copyText"
  >
    <Check v-if="copied" :size="14" stroke-width="2" aria-hidden="true" />
    <Copy v-else :size="14" stroke-width="2" aria-hidden="true" />
    <template v-if="label">{{ copied ? t("common.copied") : label }}</template>
    <!-- Announce copy-success to assistive tech: a focused button silently
         swapping its aria-label isn't reliably re-announced. Teleported to
         <body> so it stays out of the button's accessible name and, crucially,
         keeps this component single-root — callers rely on fallthrough
         class/attrs landing on the button itself (e.g. HoverPreview positions
         it via a passed-in absolute class). -->
    <Teleport to="body">
      <span class="sr-only" role="status">{{ copied ? t("common.copied") : "" }}</span>
    </Teleport>
  </button>
</template>

<style scoped>
.copy-btn {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1-5);
  padding: 0.3rem 0.7rem;
  font-size: var(--text-sm);
}
/* The teleported role="status" region uses the global `.sr-only` utility
   (style.css) — unscoped there so it reaches the node once it's mounted under
   <body>, outside this component's scoped-attribute tree. */
</style>
