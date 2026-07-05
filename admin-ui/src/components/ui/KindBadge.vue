<script setup lang="ts">
defineProps<{
  kind: string;
}>();
</script>

<template>
  <span class="kind-badge" :class="kind === 'mcp' ? 'kind-badge-mcp' : 'kind-badge-neutral'">
    {{ kind === "mcp" ? "MCP" : kind.toUpperCase() }}
  </span>
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
.kind-badge-neutral {
  background: var(--surface-sunken);
  color: var(--text-secondary);
}
</style>
