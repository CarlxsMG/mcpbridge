<script setup lang="ts">
// "How it works" — the request journey. Rendered on a fixed light "card" in both
// site themes: that keeps every label dark-on-light (crisp, no ClearType subpixel
// fringe, which only bites light-on-dark text on Windows) and lets the ink bridge
// stay the one dark element. One continuous teal artery runs client -> bridge ->
// backend; several signals flow at once, passing BEHIND the gate stations.
</script>

<template>
  <figure class="hiw">
    <div class="hiw-card">
      <div class="hiw-scroll">
        <svg viewBox="0 0 820 264" role="img" aria-labelledby="hiw-title hiw-desc" class="hiw-svg">
          <title id="hiw-title">How MCP REST Bridge works</title>
          <desc id="hiw-desc">
            AI clients send tool calls over MCP; the bridge runs each call through SSRF checks,
            guardrails, per-tool policy, circuit breakers and an audit log, then dispatches it to
            your REST APIs or upstream MCP servers.
          </desc>

          <!-- eyebrows -->
          <text class="hiw-eyebrow" x="16" y="22">AI CLIENTS</text>
          <text class="hiw-eyebrow" x="808" y="22" text-anchor="end">YOUR BACKENDS</text>

          <!-- 1 · bridge card (ink; drawn first so the trunk sits on top of it) -->
          <rect class="hiw-bridge" x="256" y="44" width="288" height="192" rx="18" />

          <!-- 2 · connectors — same teal + weight as the trunk, so they read as one line -->
          <path class="hiw-wire" d="M188 70 C222 70 222 176 256 176" fill="none" />
          <path class="hiw-wire" d="M188 138 C222 138 222 176 256 176" fill="none" />
          <path class="hiw-wire" d="M188 206 C222 206 222 176 256 176" fill="none" />
          <path class="hiw-wire" d="M544 176 C596 176 596 132 624 132" fill="none" />
          <path class="hiw-wire" d="M544 176 C596 176 596 220 624 220" fill="none" />

          <!-- 3 · the teal artery / pipeline trunk (straight) -->
          <path class="hiw-spine" d="M256 176 H544" fill="none" />

          <!-- 4 · traveling signals — drawn BEFORE the gates so they pass behind them.
               Three at once, from different clients to different backends, staggered. -->
          <circle class="hiw-pulse-halo hiw-a" r="8" />
          <circle class="hiw-pulse hiw-a" r="4.4" />
          <circle class="hiw-pulse-halo hiw-b" r="8" />
          <circle class="hiw-pulse hiw-b" r="4.4" />
          <circle class="hiw-pulse-halo hiw-c" r="8" />
          <circle class="hiw-pulse hiw-c" r="4.4" />

          <!-- 5 · gate stations on the trunk (on top of the signals) -->
          <g class="hiw-gates">
            <circle class="hiw-gate" cx="288" cy="176" r="12" />
            <circle class="hiw-gate-core" cx="288" cy="176" r="3.2" />
            <circle class="hiw-gate" cx="344" cy="176" r="12" />
            <circle class="hiw-gate-core" cx="344" cy="176" r="3.2" />
            <circle class="hiw-gate" cx="400" cy="176" r="12" />
            <circle class="hiw-gate-core" cx="400" cy="176" r="3.2" />
            <circle class="hiw-gate" cx="456" cy="176" r="12" />
            <circle class="hiw-gate-core" cx="456" cy="176" r="3.2" />
            <circle class="hiw-gate" cx="512" cy="176" r="12" />
            <circle class="hiw-gate-core" cx="512" cy="176" r="3.2" />
          </g>
          <g class="hiw-gate-labels">
            <text class="hiw-gate-label" x="288" y="202">SSRF</text>
            <text class="hiw-gate-label" x="344" y="202">Guardrails</text>
            <text class="hiw-gate-label" x="400" y="202">Breaker</text>
            <text class="hiw-gate-label" x="456" y="202">Dispatch</text>
            <text class="hiw-gate-label" x="512" y="202">Audit</text>
          </g>

          <!-- 6 · bridge header -->
          <g class="hiw-glyph" transform="translate(276,60)">
            <line x1="4" y1="1" x2="4" y2="12" />
            <circle cx="14" cy="4" r="2.4" />
            <circle cx="4" cy="15" r="2.4" />
            <path d="M14 6.4a7 7 0 0 1-7 7" />
          </g>
          <text class="hiw-bridge-title" x="300" y="72">MCP REST Bridge</text>
          <text class="hiw-bridge-sub" x="276" y="92">one governed path for every call</text>
          <line class="hiw-divider" x1="276" y1="108" x2="524" y2="108" />
          <text class="hiw-pipe-label" x="276" y="132">GUARD PIPELINE</text>

          <!-- 7 · chips (cover the connector ends) -->
          <g class="hiw-chip-g">
            <rect class="hiw-chip" x="16" y="48" width="172" height="44" rx="11" />
            <circle class="hiw-node" cx="40" cy="70" r="4" />
            <text class="hiw-label" x="58" y="75">Claude</text>
          </g>
          <g class="hiw-chip-g">
            <rect class="hiw-chip" x="16" y="116" width="172" height="44" rx="11" />
            <circle class="hiw-node" cx="40" cy="138" r="4" />
            <text class="hiw-label" x="58" y="143">Cursor</text>
          </g>
          <g class="hiw-chip-g">
            <rect class="hiw-chip" x="16" y="184" width="172" height="44" rx="11" />
            <circle class="hiw-node" cx="40" cy="206" r="4" />
            <text class="hiw-label" x="58" y="211">Agents &amp; IDEs</text>
          </g>
          <g class="hiw-chip-g">
            <rect class="hiw-chip" x="624" y="110" width="184" height="44" rx="11" />
            <circle class="hiw-node" cx="648" cy="132" r="4" />
            <text class="hiw-label" x="666" y="137">REST / OpenAPI</text>
          </g>
          <g class="hiw-chip-g">
            <rect class="hiw-chip" x="624" y="198" width="184" height="44" rx="11" />
            <circle class="hiw-node" cx="648" cy="220" r="4" />
            <text class="hiw-label" x="666" y="225">MCP upstreams</text>
          </g>

          <!-- 8 · segment labels -->
          <text class="hiw-seg" x="240" y="118" text-anchor="middle">MCP</text>
          <text class="hiw-seg" x="586" y="118" text-anchor="middle">REST</text>
          <text class="hiw-seg" x="586" y="222" text-anchor="middle">MCP</text>
        </svg>
      </div>
    </div>
    <figcaption class="hiw-cap">
      Tool calls in over MCP — dispatched out to your REST APIs or MCP servers, through the
      full guard stack on every hop.
    </figcaption>
  </figure>
</template>

<style scoped>
.hiw {
  margin: 2rem 0 1.5rem;
}

/* Fixed light "card" in both themes — keeps all text dark-on-light (crisp) and
   makes the ink bridge the single dark element. Grey fill, rounded, no border. */
.hiw-card {
  background: #edeff2;
  border-radius: 16px;
  padding: 1.5rem 1.25rem 0.75rem;
  box-shadow:
    0 1px 2px rgba(14, 17, 22, 0.05),
    0 6px 20px rgba(14, 17, 22, 0.06);
}
.hiw-scroll {
  overflow-x: auto;
}
.hiw-svg {
  width: 100%;
  min-width: 560px;
  height: auto;
  display: block;
  text-rendering: geometricPrecision;
}

.hiw-chip {
  fill: #ffffff;
  stroke: #dfe3e8;
  stroke-width: 1;
  filter: drop-shadow(0 1px 3px rgba(14, 17, 22, 0.07));
}
.hiw-label {
  fill: #14171c;
  font-family: 'Space Grotesk', var(--vp-font-family-base);
  font-size: 15px;
  font-weight: 600;
}
.hiw-node {
  fill: #00a99a;
}
.hiw-eyebrow {
  fill: #6b7280;
  font-family: 'Space Grotesk', var(--vp-font-family-base);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.14em;
}
.hiw-seg {
  fill: #565d6b;
  font-family: var(--vp-font-family-mono);
  font-size: 11px;
}

/* One continuous teal line: connectors match the trunk's colour + weight. */
.hiw-wire {
  stroke: #00a99a;
  stroke-width: 2.25;
  stroke-linecap: round;
}
.hiw-spine {
  stroke: #00a99a;
  stroke-width: 2.25;
  stroke-linecap: round;
}

/* The ink bridge — the one dark element. */
.hiw-bridge {
  fill: #0e1116;
  stroke: #262c3a;
  stroke-width: 1;
  filter: drop-shadow(0 10px 24px rgba(14, 17, 22, 0.18));
}
.hiw-glyph {
  fill: none;
  stroke: #00a99a;
  stroke-width: 2;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.hiw-bridge-title {
  fill: #ffffff;
  font-family: 'Space Grotesk', var(--vp-font-family-base);
  font-size: 16px;
  font-weight: 600;
}
.hiw-bridge-sub {
  fill: #9aa1ae;
  font-family: var(--vp-font-family-mono);
  font-size: 10.5px;
}
.hiw-divider {
  stroke: #2a3040;
  stroke-width: 1;
}
.hiw-pipe-label {
  fill: #2fd4c4;
  font-family: 'Space Grotesk', var(--vp-font-family-base);
  font-size: 9.5px;
  font-weight: 600;
  letter-spacing: 0.16em;
}
.hiw-gate {
  fill: #171b24;
  stroke: #00a99a;
  stroke-width: 1.5;
}
.hiw-gate-core {
  fill: #00a99a;
}
.hiw-gate-label {
  fill: #c3c9d2;
  font-family: var(--vp-font-family-mono);
  font-size: 10px;
  text-anchor: middle;
}

/* ── Traveling signals ── */
.hiw-pulse {
  fill: #2fd4c4;
  opacity: 0;
  offset-distance: 0%;
}
.hiw-pulse-halo {
  fill: #00a99a;
  opacity: 0;
  offset-distance: 0%;
}
.hiw-a {
  offset-path: path('M188 70 C222 70 222 176 256 176 H544 C596 176 596 132 624 132');
}
.hiw-b {
  offset-path: path('M188 206 C222 206 222 176 256 176 H544 C596 176 596 220 624 220');
}
.hiw-c {
  offset-path: path('M188 138 C222 138 222 176 256 176 H544 C596 176 596 132 624 132');
}
@media (prefers-reduced-motion: no-preference) {
  .hiw-pulse {
    animation: hiw-flow 5s linear infinite;
  }
  .hiw-pulse-halo {
    animation: hiw-flow-halo 5s linear infinite;
  }
  .hiw-a {
    animation-delay: -0.2s;
  }
  .hiw-b {
    animation-delay: -1.9s;
  }
  .hiw-c {
    animation-delay: -3.6s;
  }
}
@keyframes hiw-flow {
  0% {
    offset-distance: 0%;
    opacity: 0;
  }
  8% {
    opacity: 1;
  }
  88% {
    opacity: 1;
  }
  100% {
    offset-distance: 100%;
    opacity: 0;
  }
}
@keyframes hiw-flow-halo {
  0% {
    offset-distance: 0%;
    opacity: 0;
  }
  8% {
    opacity: 0.22;
  }
  88% {
    opacity: 0.22;
  }
  100% {
    offset-distance: 100%;
    opacity: 0;
  }
}

.hiw-cap {
  margin-top: 1rem;
  text-align: center;
  color: var(--vp-c-text-2);
  font-size: 0.9rem;
  max-width: 44rem;
  margin-inline: auto;
}
</style>
