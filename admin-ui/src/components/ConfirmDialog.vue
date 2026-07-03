<script setup lang="ts">
import { ref, watch, nextTick } from "vue";

const props = defineProps<{
  open: boolean;
  title: string;
  message: string;
  confirmLabel: string;
  danger?: boolean;
}>();

const emit = defineEmits<{ confirm: []; cancel: [] }>();

const cancelBtn = ref<HTMLButtonElement | null>(null);
const confirmBtn = ref<HTMLButtonElement | null>(null);
let previouslyFocused: HTMLElement | null = null;

// Escape only reaches the handler below once focus is inside the dialog —
// move it there on open, and give it back to whatever triggered the dialog
// on close so keyboard position isn't lost.
watch(
  () => props.open,
  async (isOpen) => {
    if (isOpen) {
      previouslyFocused = document.activeElement as HTMLElement | null;
      await nextTick();
      cancelBtn.value?.focus();
    } else {
      previouslyFocused?.focus();
      previouslyFocused = null;
    }
  },
);

// Cancel/Confirm are the only two focusable elements — cycle Tab/Shift+Tab
// between them so focus can't escape to the page behind the overlay.
function trapFocus(e: KeyboardEvent) {
  if (e.key !== "Tab") return;
  if (e.shiftKey) {
    if (document.activeElement === cancelBtn.value) {
      e.preventDefault();
      confirmBtn.value?.focus();
    }
  } else if (document.activeElement === confirmBtn.value) {
    e.preventDefault();
    cancelBtn.value?.focus();
  }
}
</script>

<template>
  <div v-if="open" class="overlay" @keydown.esc.stop="emit('cancel')" @keydown="trapFocus">
    <div class="dialog" role="alertdialog" aria-modal="true" :aria-label="title">
      <h2>{{ title }}</h2>
      <p>{{ message }}</p>
      <div class="actions">
        <button ref="cancelBtn" type="button" class="btn-secondary" @click="emit('cancel')">Cancel</button>
        <button ref="confirmBtn" type="button" :class="danger ? 'btn-danger' : 'btn-primary'" @click="emit('confirm')">
          {{ confirmLabel }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.overlay {
  position: fixed;
  inset: 0;
  background: rgba(14, 17, 22, 0.55);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: var(--z-overlay);
}
.dialog {
  background: var(--surface);
  border-radius: var(--radius-lg);
  padding: var(--space-6);
  max-width: 420px;
  width: 90%;
  box-shadow: var(--shadow-lg);
}
.dialog h2 {
  margin: 0 0 var(--space-2);
  font-size: var(--text-lg);
}
.dialog p {
  margin: 0 0 var(--space-5);
  color: var(--text-secondary);
  line-height: 1.4;
  font-family: var(--font-body);
}
.actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-2);
}
</style>
