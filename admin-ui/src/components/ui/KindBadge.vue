<script setup lang="ts">
import { computed } from "vue";

const props = defineProps<{
  kind: string;
}>();

// Wordmarks, not `toUpperCase()`: "GRAPHQL" is not how GraphQL is written, and
// an unknown kind arriving from a newer backend should still render as-is
// rather than being mangled.
const LABELS: Record<string, string> = { mcp: "MCP", rest: "REST", graphql: "GraphQL" };
const label = computed(() => LABELS[props.kind] ?? props.kind);
const variant = computed(() => (props.kind === "mcp" || props.kind === "graphql" ? props.kind : "neutral"));
</script>

<template>
  <span class="kind-badge" :class="`kind-badge-${variant}`">{{ label }}</span>
</template>

<style scoped>
.kind-badge {
  display: inline-flex;
  align-items: center;
  padding: 0.15rem 0.5rem;
  border-radius: var(--radius-pill);
  font-size: 0.72rem;
  font-weight: 700;
  letter-spacing: 0.02em;
  white-space: nowrap;
}
.kind-badge-mcp {
  background: var(--kind-mcp-soft);
  color: var(--kind-mcp-text);
}
.kind-badge-graphql {
  background: var(--kind-graphql-soft);
  color: var(--kind-graphql-text);
}
.kind-badge-neutral {
  background: var(--surface-sunken);
  color: var(--text-secondary);
}
</style>
