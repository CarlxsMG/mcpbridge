<script setup lang="ts">
import { computed } from "vue";
import WidgetCard from "./WidgetCard.vue";
import { renderMarkdown } from "./markdown";
import type { WidgetInstance } from "./widgetCatalog";

const props = defineProps<{ widget: WidgetInstance }>();
// Safe: renderMarkdown HTML-escapes all input before emitting its own tags, so
// there is no XSS path here despite the v-html (see markdown.ts / markdown.test.ts).
const html = computed(() => renderMarkdown(props.widget.options.text ?? ""));
</script>

<template>
  <WidgetCard :title="widget.options.title">
    <!-- eslint-disable-next-line vue/no-v-html -->
    <div class="w-note" v-html="html" />
  </WidgetCard>
</template>

<style scoped>
.w-note {
  font-size: var(--text-sm);
  color: var(--text-secondary);
  line-height: 1.5;
  word-break: break-word;
}
.w-note :deep(h3),
.w-note :deep(h4),
.w-note :deep(h5) {
  margin: 0 0 var(--space-2);
  color: var(--text-primary);
  font-family: var(--font-display);
}
.w-note :deep(h3) {
  font-size: var(--text-md);
}
.w-note :deep(h4),
.w-note :deep(h5) {
  font-size: var(--text-base);
}
.w-note :deep(p) {
  margin: 0 0 var(--space-2);
}
.w-note :deep(ul) {
  margin: 0 0 var(--space-2);
  padding-left: var(--space-5);
}
.w-note :deep(a) {
  color: var(--signal-strong);
}
.w-note :deep(code) {
  font-family: var(--font-mono);
  font-size: 0.9em;
}
</style>
