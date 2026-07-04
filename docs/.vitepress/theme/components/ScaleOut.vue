<script setup lang="ts">
// Horizontal-scaling topology: MCP clients → load balancer → N identical bridge
// instances → one shared SQLite that coordinates them (config, shared rate
// counters, registry sync, leader lease). Same visual system as HowItWorks.
const instances = [1, 2, 3];
const cx = [170, 360, 550]; // centre x of each instance
const ix = (i: number) => cx[i] - 84; // left x (width 168)
</script>

<template>
  <figure class="so">
    <div class="so-card">
      <div class="so-scroll">
        <svg viewBox="0 0 720 424" role="img" aria-labelledby="so-title so-desc" class="so-svg">
          <title id="so-title">Scaling MCP REST Bridge horizontally</title>
          <desc id="so-desc">
            MCP clients reach a load balancer, which spreads traffic across several identical bridge instances. Every
            instance shares one SQLite database for config, cross-instance rate counters, registry sync and the leader
            lease.
          </desc>

          <defs>
            <marker
              id="so-arrow"
              markerUnits="userSpaceOnUse"
              markerWidth="9"
              markerHeight="9"
              refX="8"
              refY="4.5"
              orient="auto-start-reverse"
            >
              <path d="M0 0 L9 4.5 L0 9 z" fill="#00a99a" />
            </marker>
          </defs>

          <!-- Arrows leave the LB diagonally (a natural fan) and arrive vertically; each ends
               with a short straight run so the stroke tucks under the arrowhead. -->
          <!-- clients → LB -->
          <path class="so-flow" d="M360 58 V90" marker-end="url(#so-arrow)" fill="none" />
          <!-- LB → each instance -->
          <path class="so-flow" d="M360 140 C336 176 170 172 170 200 V212" marker-end="url(#so-arrow)" fill="none" />
          <path class="so-flow" d="M360 140 V212" marker-end="url(#so-arrow)" fill="none" />
          <path class="so-flow" d="M360 140 C384 176 550 172 550 200 V212" marker-end="url(#so-arrow)" fill="none" />
          <!-- each instance ↕ shared SQLite (spread out along the SQLite top) -->
          <path
            class="so-flow"
            d="M170 288 V300 C170 336 280 340 280 356 V368"
            marker-start="url(#so-arrow)"
            marker-end="url(#so-arrow)"
            fill="none"
          />
          <path
            class="so-flow"
            d="M360 288 V368"
            marker-start="url(#so-arrow)"
            marker-end="url(#so-arrow)"
            fill="none"
          />
          <path
            class="so-flow"
            d="M550 288 V300 C550 336 440 340 440 356 V368"
            marker-start="url(#so-arrow)"
            marker-end="url(#so-arrow)"
            fill="none"
          />

          <!-- clients -->
          <g class="so-chip-g">
            <rect class="so-chip" x="280" y="18" width="160" height="42" rx="11" />
            <circle class="so-cnode" cx="306" cy="39" r="4" />
            <text class="so-label" x="322" y="44">MCP clients</text>
          </g>

          <!-- load balancer -->
          <g class="so-chip-g">
            <rect class="so-chip" x="205" y="90" width="310" height="50" rx="12" />
            <text class="so-label so-mid" x="360" y="111">Load balancer</text>
            <text class="so-sub so-mid" x="360" y="128">health-check /health · sticky MCP sessions</text>
          </g>

          <!-- bridge instances (ink) -->
          <g v-for="(n, i) in instances" :key="n" class="so-inst-g">
            <rect class="so-inst" :x="ix(i)" y="212" width="168" height="76" rx="14" />
            <g class="so-glyph" :transform="`translate(${ix(i) + 18},${228})`">
              <polyline points="15.4,8.4 12.6,8.4 10.5,14.7 6.3,2.1 4.2,8.4 1.4,8.4" />
            </g>
            <text class="so-inst-title" :x="ix(i) + 42" y="237">MCP REST Bridge</text>
            <text class="so-inst-sub" :x="ix(i) + 18" y="266">instance {{ n }}</text>
          </g>

          <!-- shared SQLite -->
          <g class="so-chip-g">
            <rect class="so-db" x="200" y="368" width="320" height="54" rx="12" />
            <text class="so-db-title so-mid" x="360" y="391">Shared SQLite</text>
            <text class="so-db-sub so-mid" x="360" y="408">config · rate counters · registry sync · leader lease</text>
          </g>
        </svg>
      </div>
    </div>
    <figcaption class="so-cap">
      Identical instances behind a load balancer, coordinated through one shared SQLite. Each still proxies to your REST
      &amp; MCP backends; background loops run on the elected leader only.
    </figcaption>
  </figure>
</template>

<style scoped>
.so {
  margin: 1.75rem 0 1.5rem;
}
.so-card {
  background: #edeff2;
  border-radius: 16px;
  padding: 1.25rem 1rem 0.75rem;
  box-shadow:
    0 1px 2px rgba(14, 17, 22, 0.05),
    0 6px 20px rgba(14, 17, 22, 0.06);
}
.so-scroll {
  overflow-x: auto;
}
.so-svg {
  width: 100%;
  min-width: 560px;
  height: auto;
  display: block;
  text-rendering: geometricPrecision;
}

.so-chip {
  fill: #ffffff;
  stroke: #dfe3e8;
  stroke-width: 1;
  filter: drop-shadow(0 1px 3px rgba(14, 17, 22, 0.07));
}
.so-cnode {
  fill: #00a99a;
}
.so-label {
  fill: #14171c;
  font-family: "Space Grotesk", var(--vp-font-family-base);
  font-size: 15px;
  font-weight: 600;
}
.so-mid {
  text-anchor: middle;
}
.so-sub {
  fill: #565d6b;
  font-family: var(--vp-font-family-mono);
  font-size: 9.5px;
}

.so-flow {
  stroke: #00a99a;
  stroke-width: 2;
  fill: none;
}

/* bridge instances — the dark element, repeated */
.so-inst {
  fill: #0e1116;
  stroke: #262c3a;
  stroke-width: 1;
  filter: drop-shadow(0 8px 20px rgba(14, 17, 22, 0.16));
}
.so-glyph {
  fill: none;
  stroke: #00a99a;
  stroke-width: 2;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.so-inst-title {
  fill: #ffffff;
  font-family: "Space Grotesk", var(--vp-font-family-base);
  font-size: 12.5px;
  font-weight: 600;
}
.so-inst-sub {
  fill: #9aa1ae;
  font-family: var(--vp-font-family-mono);
  font-size: 9.5px;
}

/* shared datastore — teal-tinted to mark it as the coordination layer */
.so-db {
  fill: #e1f5f2;
  stroke: #9bdcd3;
  stroke-width: 1;
}
.so-db-title {
  fill: #0e4f49;
  font-family: "Space Grotesk", var(--vp-font-family-base);
  font-size: 14px;
  font-weight: 600;
}
.so-db-sub {
  fill: #2c6f68;
  font-family: var(--vp-font-family-mono);
  font-size: 9px;
}

.so-cap {
  margin-top: 1rem;
  text-align: center;
  color: var(--vp-c-text-2);
  font-size: 0.9rem;
  max-width: 42rem;
  margin-inline: auto;
}
</style>
