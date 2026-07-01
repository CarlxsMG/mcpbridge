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
  }
);
</script>

<template>
  <div v-if="open" class="overlay" @keydown.esc.stop="emit('cancel')">
    <div class="dialog" role="alertdialog" aria-modal="true" :aria-label="title">
      <h2>{{ title }}</h2>
      <p>{{ message }}</p>
      <div class="actions">
        <button ref="cancelBtn" type="button" class="btn-secondary" @click="emit('cancel')">Cancel</button>
        <button type="button" :class="danger ? 'btn-danger' : 'btn-primary'" @click="emit('confirm')">
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
  background: rgba(15, 18, 22, 0.45);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 100;
}
.dialog {
  background: #fff;
  border-radius: 10px;
  padding: 1.5rem;
  max-width: 420px;
  width: 90%;
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.2);
}
.dialog h2 {
  margin: 0 0 0.5rem;
  font-size: 1.1rem;
}
.dialog p {
  margin: 0 0 1.25rem;
  color: #4a4f57;
  line-height: 1.4;
}
.actions {
  display: flex;
  justify-content: flex-end;
  gap: 0.6rem;
}
</style>
