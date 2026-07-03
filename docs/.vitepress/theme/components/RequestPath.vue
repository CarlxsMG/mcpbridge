<script setup lang="ts">
// "The request path" — a vertical view of how one tool call flows through the
// bridge: in over MCP from the client, down the guard pipeline (proxyToolCall),
// out to the backend at Dispatch, then back to the same client as the result.
// Same visual system as HowItWorks: fixed light card, one ink bridge, teal
// artery, crisp dark-on-light chips.

const stages = [
  "Scope filter",
  "Guardrails",
  "Per-tool policy",
  "Circuit breaker",
  "Dispatch",
  "Sanitize · redact",
  "Audit · trace",
];
const TOP = 196;
const GAP = 36;
const y = (i: number) => TOP + i * GAP;
const DISPATCH = 4; // index of the Dispatch stage → y = 196 + 4*36 = 340
</script>

<template>
  <figure class="rp">
    <div class="rp-card">
      <div class="rp-scroll">
        <svg viewBox="0 0 680 540" role="img" aria-labelledby="rp-title rp-desc" class="rp-svg">
          <title id="rp-title">The request path through MCP REST Bridge</title>
          <desc id="rp-desc">
            A tool call arrives over MCP, descends the guard pipeline — scope filter, guardrails, per-tool policy,
            circuit breaker, dispatch, response sanitizing, audit — is dispatched to a REST or MCP backend at the
            Dispatch stage, and the result returns to the caller.
          </desc>

          <defs>
            <marker
              id="rp-arrow"
              viewBox="0 0 10 10"
              refX="8"
              refY="5"
              markerWidth="6.5"
              markerHeight="6.5"
              orient="auto-start-reverse"
            >
              <path d="M0 0 L10 5 L0 10 z" fill="#00a99a" />
            </marker>
          </defs>

          <!-- 1 · bridge card (ink) -->
          <rect class="rp-bridge" x="206" y="104" width="268" height="344" rx="18" />

          <!-- 2 · request-in / result-out arrows (client <-> bridge) -->
          <path class="rp-flow" d="M340 64 V100" marker-end="url(#rp-arrow)" fill="none" />
          <path class="rp-flow" d="M340 448 V484" marker-end="url(#rp-arrow)" fill="none" />

          <!-- 3 · Dispatch <-> Backend — starts INSIDE the bridge so it reads as linked -->
          <path
            class="rp-flow"
            d="M344 340 H548"
            marker-start="url(#rp-arrow)"
            marker-end="url(#rp-arrow)"
            fill="none"
          />

          <!-- 4 · the teal artery / pipeline spine -->
          <path class="rp-spine" d="M248 188 V420" fill="none" />

          <!-- 5 · travelling signals (before nodes → pass behind them) -->
          <circle class="rp-pulse-halo rp-a" r="8" />
          <circle class="rp-pulse rp-a" r="4.2" />
          <circle class="rp-pulse-halo rp-b" r="8" />
          <circle class="rp-pulse rp-b" r="4.2" />

          <!-- 6 · stage stations -->
          <g class="rp-stations">
            <template v-for="(s, i) in stages" :key="s">
              <circle class="rp-node" :cx="248" :cy="y(i)" r="7" />
              <circle class="rp-node-core" :cx="248" :cy="y(i)" r="2.6" />
              <text class="rp-stage" :class="{ 'is-dispatch': i === DISPATCH }" x="268" :y="y(i) + 4">{{ s }}</text>
            </template>
          </g>

          <!-- 7 · bridge header -->
          <g class="rp-glyph" transform="translate(230,124)">
            <line x1="4" y1="1" x2="4" y2="12" />
            <circle cx="14" cy="4" r="2.4" />
            <circle cx="4" cy="15" r="2.4" />
            <path d="M14 6.4a7 7 0 0 1-7 7" />
          </g>
          <text class="rp-bridge-title" x="256" y="137">MCP REST Bridge</text>
          <text class="rp-bridge-sub" x="230" y="157">proxyToolCall — one guarded path</text>
          <line class="rp-divider" x1="230" y1="169" x2="450" y2="169" />

          <!-- 8 · client (top: request, bottom: result) + backend chips -->
          <g class="rp-chip-g">
            <rect class="rp-chip" x="254" y="14" width="172" height="46" rx="11" />
            <circle class="rp-cnode" cx="278" cy="37" r="4" />
            <text class="rp-label" x="296" y="42">MCP client</text>
          </g>
          <g class="rp-chip-g">
            <rect class="rp-chip" x="254" y="486" width="172" height="46" rx="11" />
            <circle class="rp-cnode" cx="278" cy="509" r="4" />
            <text class="rp-label" x="296" y="514">MCP client</text>
          </g>
          <g class="rp-chip-g">
            <rect class="rp-chip" x="556" y="316" width="120" height="48" rx="11" />
            <circle class="rp-cnode" cx="578" cy="340" r="4" />
            <text class="rp-label rp-label-sm" x="594" y="336">Backend</text>
            <text class="rp-backend-sub" x="594" y="352">REST or MCP</text>
          </g>

          <!-- 9 · flow labels -->
          <text class="rp-seg" x="352" y="86">tools/call · POST /mcp</text>
          <text class="rp-seg" x="512" y="332" text-anchor="middle">call</text>
          <text class="rp-seg" x="512" y="357" text-anchor="middle">result</text>
          <text class="rp-seg" x="352" y="470">result</text>
        </svg>
      </div>
    </div>
    <figcaption class="rp-cap">
      Every policy runs at the dispatch point inside <code>proxyToolCall</code> — after the call is demultiplexed to a
      specific tool, before it reaches your backend.
    </figcaption>
  </figure>
</template>

<style scoped>
.rp {
  margin: 1.75rem 0 1.5rem;
}
.rp-card {
  background: #edeff2;
  border-radius: 16px;
  padding: 1.25rem 1rem 0.75rem;
  box-shadow:
    0 1px 2px rgba(14, 17, 22, 0.05),
    0 6px 20px rgba(14, 17, 22, 0.06);
}
.rp-scroll {
  overflow-x: auto;
}
.rp-svg {
  width: 100%;
  max-width: 540px;
  height: auto;
  display: block;
  margin-inline: auto;
  text-rendering: geometricPrecision;
}

/* Caller + backend chips — crisp dark-on-white. */
.rp-chip {
  fill: #ffffff;
  stroke: #dfe3e8;
  stroke-width: 1;
  filter: drop-shadow(0 1px 3px rgba(14, 17, 22, 0.07));
}
.rp-label {
  fill: #14171c;
  font-family: "Space Grotesk", var(--vp-font-family-base);
  font-size: 15px;
  font-weight: 600;
}
.rp-label-sm {
  font-size: 14px;
}
.rp-backend-sub {
  fill: #565d6b;
  font-family: var(--vp-font-family-mono);
  font-size: 9.5px;
}
.rp-cnode {
  fill: #00a99a;
}
.rp-seg {
  fill: #565d6b;
  font-family: var(--vp-font-family-mono);
  font-size: 10.5px;
}

/* Teal artery + arrows. */
.rp-flow {
  stroke: #00a99a;
  stroke-width: 2;
  stroke-linecap: round;
}
.rp-spine {
  stroke: #00a99a;
  stroke-width: 2.25;
  stroke-linecap: round;
}

/* The ink bridge — the one dark element. */
.rp-bridge {
  fill: #0e1116;
  stroke: #262c3a;
  stroke-width: 1;
  filter: drop-shadow(0 10px 24px rgba(14, 17, 22, 0.18));
}
.rp-glyph {
  fill: none;
  stroke: #00a99a;
  stroke-width: 2;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.rp-bridge-title {
  fill: #ffffff;
  font-family: "Space Grotesk", var(--vp-font-family-base);
  font-size: 15px;
  font-weight: 600;
}
.rp-bridge-sub {
  fill: #9aa1ae;
  font-family: var(--vp-font-family-mono);
  font-size: 10px;
}
.rp-divider {
  stroke: #2a3040;
  stroke-width: 1;
}
.rp-node {
  fill: #171b24;
  stroke: #00a99a;
  stroke-width: 1.5;
}
.rp-node-core {
  fill: #00a99a;
}
.rp-stage {
  fill: #e7eaef;
  font-family: "Space Grotesk", var(--vp-font-family-base);
  font-size: 13px;
  font-weight: 500;
}
.rp-stage.is-dispatch {
  fill: #ffffff;
  font-weight: 600;
}

/* Travelling signals down the pipeline. */
.rp-pulse {
  fill: #2fd4c4;
  opacity: 0;
  offset-distance: 0%;
}
.rp-pulse-halo {
  fill: #00a99a;
  opacity: 0;
  offset-distance: 0%;
}
.rp-a,
.rp-b {
  offset-path: path("M248 188 V420");
}
@media (prefers-reduced-motion: no-preference) {
  .rp-pulse {
    animation: rp-flow 4.4s linear infinite;
  }
  .rp-pulse-halo {
    animation: rp-flow-halo 4.4s linear infinite;
  }
  .rp-a {
    animation-delay: -0.3s;
  }
  .rp-b {
    animation-delay: -2.5s;
  }
}
@keyframes rp-flow {
  0% {
    offset-distance: 0%;
    opacity: 0;
  }
  10% {
    opacity: 1;
  }
  85% {
    opacity: 1;
  }
  100% {
    offset-distance: 100%;
    opacity: 0;
  }
}
@keyframes rp-flow-halo {
  0% {
    offset-distance: 0%;
    opacity: 0;
  }
  10% {
    opacity: 0.22;
  }
  85% {
    opacity: 0.22;
  }
  100% {
    offset-distance: 100%;
    opacity: 0;
  }
}

.rp-cap {
  margin-top: 1rem;
  text-align: center;
  color: var(--vp-c-text-2);
  font-size: 0.9rem;
  max-width: 42rem;
  margin-inline: auto;
}
</style>
