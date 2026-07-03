<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount } from "vue";

// An auto-crossfading reel of real screenshots from the live demo, framed as an
// app window. Crisper than a GIF, tiny, and it pauses for reduced-motion users.
const base = import.meta.env.BASE_URL;
const demoUrl = "https://aico-dot-team-code.github.io/mcpbridge/demo/";

const frames = [
  { src: "reel-overview.png", label: "Overview" },
  { src: "reel-servers.png", label: "Servers" },
  { src: "reel-usage.png", label: "Usage" },
];

const active = ref(0);
let timer: ReturnType<typeof setInterval> | undefined;

function go(i: number) {
  active.value = (i + frames.length) % frames.length;
}

onMounted(() => {
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (reduce) return;
  timer = setInterval(() => go(active.value + 1), 3000);
});
onBeforeUnmount(() => {
  if (timer) clearInterval(timer);
});
</script>

<template>
  <figure class="reel">
    <div class="reel-window">
      <div class="reel-bar" aria-hidden="true">
        <span class="reel-dot reel-dot--r"></span>
        <span class="reel-dot reel-dot--y"></span>
        <span class="reel-dot reel-dot--g"></span>
        <span class="reel-url">localhost:3000/admin</span>
      </div>
      <div class="reel-stage">
        <img
          v-for="(f, i) in frames"
          :key="f.src"
          :src="base + 'screenshots/' + f.src"
          :alt="'MCP REST Bridge admin — ' + f.label"
          class="reel-img"
          :class="{ 'is-active': i === active }"
          width="1280"
          height="800"
          loading="lazy"
        />
        <a class="reel-cta" :href="demoUrl" target="_blank" rel="noopener">▶ Open the live demo</a>
      </div>
    </div>
    <div class="reel-tabs">
      <button
        v-for="(f, i) in frames"
        :key="f.label"
        type="button"
        class="reel-tab"
        :class="{ 'is-on': i === active }"
        @click="go(i)"
      >
        {{ f.label }}
      </button>
    </div>
  </figure>
</template>

<style scoped>
.reel {
  margin: 1.75rem 0 0.5rem;
}
.reel-window {
  border: 1px solid var(--vp-c-border);
  border-radius: 14px;
  overflow: hidden;
  background: var(--vp-c-bg);
  box-shadow:
    0 18px 44px rgba(14, 17, 22, 0.16),
    0 4px 12px rgba(14, 17, 22, 0.06);
}
.reel-bar {
  position: relative;
  display: flex;
  align-items: center;
  gap: 7px;
  height: 38px;
  padding: 0 14px;
  background: var(--vp-c-bg-soft);
  border-bottom: 1px solid var(--vp-c-border);
}
.reel-dot {
  width: 11px;
  height: 11px;
  border-radius: 50%;
  flex-shrink: 0;
}
.reel-dot--r {
  background: #ff5f57;
}
.reel-dot--y {
  background: #febc2e;
}
.reel-dot--g {
  background: #28c840;
}
.reel-url {
  position: absolute;
  left: 50%;
  transform: translateX(-50%);
  font-family: var(--vp-font-family-mono);
  font-size: 12px;
  color: var(--vp-c-text-3);
  white-space: nowrap;
}
.reel-stage {
  position: relative;
  width: 100%;
  aspect-ratio: 1280 / 800;
  background: var(--vp-c-bg);
}
.reel-img {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
  object-position: top left;
  opacity: 0;
  transition: opacity 0.7s ease;
}
.reel-img.is-active {
  opacity: 1;
}
.reel-cta {
  position: absolute;
  bottom: 14px;
  left: 50%;
  transform: translateX(-50%);
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  padding: 0.4rem 0.9rem;
  border-radius: 999px;
  background: #00a99a;
  color: #fff;
  font-size: 0.82rem;
  font-weight: 600;
  text-decoration: none;
  box-shadow: 0 6px 18px rgba(0, 135, 123, 0.4);
  transition:
    transform 0.12s ease,
    background-color 0.12s ease;
}
.reel-cta:hover {
  background: #00877b;
  transform: translateX(-50%) translateY(-1px);
}
.reel-tabs {
  display: flex;
  justify-content: center;
  gap: 0.4rem;
  margin-top: 0.85rem;
}
.reel-tab {
  border: 1px solid var(--vp-c-border);
  background: var(--vp-c-bg);
  color: var(--vp-c-text-2);
  border-radius: 999px;
  padding: 0.22rem 0.7rem;
  font-size: 0.78rem;
  font-weight: 500;
  cursor: pointer;
  transition:
    color 0.12s ease,
    border-color 0.12s ease,
    background-color 0.12s ease;
}
.reel-tab:hover {
  color: var(--vp-c-text-1);
  border-color: var(--vp-c-text-3);
}
.reel-tab.is-on {
  color: #fff;
  background: #00a99a;
  border-color: #00a99a;
}
</style>
