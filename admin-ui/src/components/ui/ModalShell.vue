<script setup lang="ts">
import { ref, watch, nextTick, onUnmounted } from "vue";
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
    lockBodyScroll(isOpen);
  },
);

/**
 * Freezes the page behind the dialog. The focus trap already keeps the keyboard
 * inside the panel, but the wheel and touch scroll the document underneath — so a
 * confirm dialog on a long list let the list slide away behind it, and on iOS the
 * background is what scrolls first.
 *
 * Restores whatever `overflow` the body had rather than clearing it, so nesting (a
 * ConfirmDialog opened from inside the guard-editor drawer) cannot leave the page
 * permanently unscrollable.
 */
let previousOverflow: string | null = null;
function lockBodyScroll(locked: boolean): void {
  if (locked) {
    if (previousOverflow === null) previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
  } else if (previousOverflow !== null) {
    document.body.style.overflow = previousOverflow;
    previousOverflow = null;
  }
}

// A dialog can be unmounted while open (its whole page navigates away), which never
// fires the watcher's close branch — without this the body stays locked.
onUnmounted(() => lockBodyScroll(false));
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
