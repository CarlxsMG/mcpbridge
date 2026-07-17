<script setup lang="ts">
import { ref, watch, nextTick } from "vue";
import { useFocusTrap, focusFirst } from "@/composables/useFocusTrap";

const props = defineProps<{
  open: boolean;
  // Accessible name for the dialog. Named `label` (not `ariaLabel`) so callers
  // bind `:label` without tripping vue/attribute-hyphenation on `:ariaLabel`.
  label: string;
  // Optional id of an element inside the panel describing it (bound as
  // aria-describedby so screen readers announce the body when the dialog opens).
  describedById?: string;
  alert?: boolean;
  maxWidth?: string;
}>();
const emit = defineEmits<{ close: [] }>();

const panelEl = ref<HTMLElement | null>(null);
const { onKeydown } = useFocusTrap(panelEl);
let previouslyFocused: HTMLElement | null = null;

// Mirrors the focus-restore behavior of the 3 dialogs this shell replaces:
// stash whatever had focus before opening, land focus on the first focusable
// element inside the panel once it's mounted, then give it back on close.
watch(
  () => props.open,
  async (isOpen) => {
    if (isOpen) {
      previouslyFocused = document.activeElement as HTMLElement | null;
      await nextTick();
      focusFirst(panelEl.value);
    } else {
      previouslyFocused?.focus();
      previouslyFocused = null;
    }
  },
);
</script>

<template>
  <div v-if="open" class="overlay" @keydown.esc.stop="emit('close')" @keydown="onKeydown">
    <div
      ref="panelEl"
      class="panel"
      :role="alert ? 'alertdialog' : 'dialog'"
      aria-modal="true"
      :aria-label="label"
      :aria-describedby="describedById"
      :style="{ maxWidth: maxWidth ?? '40rem' }"
    >
      <slot />
    </div>
  </div>
</template>

<style scoped>
.overlay {
  position: fixed;
  inset: 0;
  background: var(--overlay-backdrop);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: var(--z-overlay);
  padding: var(--space-4);
}
.panel {
  background: var(--surface);
  border-radius: var(--radius-lg);
  padding: var(--space-6);
  width: 100%;
  max-height: 90vh;
  overflow-y: auto;
  box-shadow: var(--shadow-lg);
}
</style>
