<script setup lang="ts">
import { GitBranch } from "lucide-vue-next";

const isDemo = import.meta.env.VITE_DEMO === "true";
</script>

<template>
  <a
    v-if="isDemo"
    class="demo-ribbon"
    href="https://github.com/aico-dot-team-code/mcpbridge"
    target="_blank"
    rel="noopener"
  >
    <GitBranch :size="13" stroke-width="2.5" aria-hidden="true" /> Live demo — data is mocked · View source ↗
  </a>
</template>

<style scoped>
.demo-ribbon {
  position: fixed;
  top: var(--space-2);
  left: 50%;
  transform: translateX(-50%);
  z-index: var(--z-banner);
  display: inline-flex;
  align-items: center;
  gap: var(--space-1-5);
  padding: var(--space-1-5) var(--space-3);
  background: var(--ink);
  color: #fff;
  border: 1px solid var(--signal);
  border-radius: var(--radius-pill);
  font-size: var(--text-sm);
  font-weight: 600;
  text-decoration: none;
  box-shadow: var(--shadow-md);
}
.demo-ribbon svg {
  color: var(--signal);
}
.demo-ribbon:hover {
  background: var(--ink-raised);
}
@media (max-width: 768px) {
  .demo-ribbon {
    top: auto;
    bottom: var(--space-2);
  }
}
</style>
