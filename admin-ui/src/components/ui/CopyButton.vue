<script setup lang="ts">
import { Copy, Check } from "lucide-vue-next";
import { useClipboard } from "@/composables/useClipboard";

const props = defineProps<{
  /** Value copied to the clipboard on click. */
  text: string;
  /** Rendered next to the icon when provided; otherwise the button is icon-only with an aria-label. */
  label?: string;
}>();

const { copied, copy } = useClipboard();

function copyText() {
  copy(props.text);
}
</script>

<template>
  <button
    type="button"
    class="btn-secondary copy-btn"
    :aria-label="label ? undefined : copied ? 'Copied' : 'Copy'"
    @click="copyText"
  >
    <Check v-if="copied" :size="14" stroke-width="2" aria-hidden="true" />
    <Copy v-else :size="14" stroke-width="2" aria-hidden="true" />
    <template v-if="label">{{ copied ? "Copied" : label }}</template>
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
</style>
