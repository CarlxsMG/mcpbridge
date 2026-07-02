<script setup lang="ts">
// "How it works" — the request journey: a tool call comes in over MCP, crosses
// the ink bridge through the guard pipeline, and fans out to REST + MCP backends.
// Theme-adaptive (surfaces use VitePress vars; the bridge stays ink in both modes).
// The teal "signal" traveling the pipeline is the page's signature motif.
</script>

<template>
  <figure class="hiw">
    <div class="hiw-scroll">
      <svg viewBox="0 0 820 290" role="img" aria-labelledby="hiw-title hiw-desc" class="hiw-svg">
        <title id="hiw-title">How MCP REST Bridge works</title>
        <desc id="hiw-desc">
          AI clients send tool calls over MCP; the bridge runs each call through SSRF checks,
          guardrails, per-tool policy, circuit breakers and an audit log, then dispatches it to
          your REST APIs or upstream MCP servers.
        </desc>

        <!-- eyebrows -->
        <text class="hiw-eyebrow" x="16" y="22">AI CLIENTS</text>
        <text class="hiw-eyebrow" x="804" y="22" text-anchor="end">YOUR BACKENDS</text>

        <!-- 1 · bridge card (ink background — drawn first so the spine shows on top) -->
        <rect class="hiw-bridge" x="256" y="40" width="288" height="210" rx="18" />

        <!-- 2 · wires (tuck under chips + spine) -->
        <path class="hiw-wire" d="M188 78 C205 78 205 150 214 150" fill="none" />
        <path class="hiw-wire" d="M188 150 H214" fill="none" />
        <path class="hiw-wire" d="M188 222 C205 222 205 150 214 150" fill="none" />
        <path class="hiw-wire" d="M600 150 C620 150 622 116 648 116" fill="none" />
        <path class="hiw-wire" d="M600 150 C620 150 622 186 648 186" fill="none" />

        <!-- 3 · the teal spine / pipeline track (on top of the card) -->
        <path
          class="hiw-spine"
          d="M214 150 C248 150 258 182 300 182 H540 C588 182 600 150 600 150"
          fill="none"
        />

        <!-- 4 · gate stations on the track -->
        <g class="hiw-gates">
          <circle class="hiw-gate" cx="300" cy="182" r="13" />
          <circle class="hiw-gate-core" cx="300" cy="182" r="3.4" />
          <circle class="hiw-gate" cx="360" cy="182" r="13" />
          <circle class="hiw-gate-core" cx="360" cy="182" r="3.4" />
          <circle class="hiw-gate" cx="420" cy="182" r="13" />
          <circle class="hiw-gate-core" cx="420" cy="182" r="3.4" />
          <circle class="hiw-gate" cx="480" cy="182" r="13" />
          <circle class="hiw-gate-core" cx="480" cy="182" r="3.4" />
          <circle class="hiw-gate" cx="540" cy="182" r="13" />
          <circle class="hiw-gate-core" cx="540" cy="182" r="3.4" />
        </g>
        <g class="hiw-gate-labels">
          <text class="hiw-gate-label" x="300" y="210">SSRF</text>
          <text class="hiw-gate-label" x="360" y="210">Guardrails</text>
          <text class="hiw-gate-label" x="420" y="210">Breaker</text>
          <text class="hiw-gate-label" x="480" y="210">Dispatch</text>
          <text class="hiw-gate-label" x="540" y="210">Audit</text>
        </g>

        <!-- 5 · bridge header (on top of the card, clear of the pipeline) -->
        <g class="hiw-glyph" transform="translate(276,58)">
          <line x1="4" y1="1" x2="4" y2="12" />
          <circle cx="14" cy="4" r="2.4" />
          <circle cx="4" cy="15" r="2.4" />
          <path d="M14 6.4a7 7 0 0 1-7 7" />
        </g>
        <text class="hiw-bridge-title" x="300" y="70">MCP REST Bridge</text>
        <text class="hiw-bridge-sub" x="276" y="90">one governed path for every call</text>
        <line class="hiw-divider" x1="276" y1="104" x2="524" y2="104" />
        <text class="hiw-pipe-label" x="276" y="126">GUARD PIPELINE</text>

        <!-- 6 · client + backend chips (cover the wire ends) -->
        <g class="hiw-chip-g">
          <rect class="hiw-chip" x="16" y="56" width="172" height="44" rx="11" />
          <circle class="hiw-node" cx="40" cy="78" r="4" />
          <text class="hiw-label" x="58" y="83">Claude</text>
        </g>
        <g class="hiw-chip-g">
          <rect class="hiw-chip" x="16" y="128" width="172" height="44" rx="11" />
          <circle class="hiw-node" cx="40" cy="150" r="4" />
          <text class="hiw-label" x="58" y="155">Cursor</text>
        </g>
        <g class="hiw-chip-g">
          <rect class="hiw-chip" x="16" y="200" width="172" height="44" rx="11" />
          <circle class="hiw-node" cx="40" cy="222" r="4" />
          <text class="hiw-label" x="58" y="227">Agents &amp; IDEs</text>
        </g>
        <g class="hiw-chip-g">
          <rect class="hiw-chip" x="648" y="94" width="156" height="44" rx="11" />
          <circle class="hiw-node" cx="672" cy="116" r="4" />
          <text class="hiw-label" x="690" y="121">REST / OpenAPI</text>
        </g>
        <g class="hiw-chip-g">
          <rect class="hiw-chip" x="648" y="164" width="156" height="44" rx="11" />
          <circle class="hiw-node" cx="672" cy="186" r="4" />
          <text class="hiw-label" x="690" y="191">MCP upstreams</text>
        </g>

        <!-- 7 · segment labels -->
        <text class="hiw-seg" x="222" y="140" text-anchor="middle">MCP</text>
        <text class="hiw-seg" x="614" y="128" text-anchor="middle">REST</text>
        <text class="hiw-seg" x="614" y="180" text-anchor="middle">MCP</text>

        <!-- 8 · traveling signal -->
        <circle class="hiw-dot-halo" r="9" />
        <circle class="hiw-dot" r="4.5" />
      </svg>
    </div>
    <figcaption class="hiw-cap">
      One tool call in over MCP — dispatched out to your REST APIs or MCP servers, through the
      full guard stack on every hop.
    </figcaption>
  </figure>
</template>

<style scoped>
.hiw {
  margin: 2rem 0 1.5rem;
}
.hiw-scroll {
  overflow-x: auto;
  padding-bottom: 0.25rem;
}
.hiw-svg {
  width: 100%;
  min-width: 620px;
  height: auto;
  display: block;
}

/* Chips adapt to light/dark via VitePress surface vars. */
.hiw-chip {
  fill: var(--vp-c-bg);
  stroke: var(--vp-c-border);
  stroke-width: 1;
}
.hiw-chip-g {
  filter: drop-shadow(0 2px 5px rgba(14, 17, 22, 0.06));
}
.hiw-label {
  fill: var(--vp-c-text-1);
  font-family: 'Space Grotesk', var(--vp-font-family-base);
  font-size: 15px;
  font-weight: 500;
}
.hiw-node {
  fill: #00a99a;
}
.hiw-eyebrow {
  fill: var(--vp-c-text-3);
  font-family: 'Space Grotesk', var(--vp-font-family-base);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.14em;
}
.hiw-seg {
  fill: var(--vp-c-text-2);
  font-family: var(--vp-font-family-mono);
  font-size: 11px;
}

/* Wires + the teal spine. */
.hiw-wire {
  stroke: var(--vp-c-divider);
  stroke-width: 1.5;
}
.hiw-spine {
  stroke: #00a99a;
  stroke-width: 2.25;
  stroke-linecap: round;
}

/* The bridge — ink in both themes (echoes the admin sidebar). */
.hiw-bridge {
  fill: #0e1116;
  stroke: #262c3a;
  stroke-width: 1;
  filter: drop-shadow(0 14px 30px rgba(14, 17, 22, 0.22));
}
/* Lift the card off the ink page background in dark mode so it still reads as a device. */
:global(.dark) .hiw-bridge {
  fill: #171b24;
  stroke: #313848;
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
  fill: #8d94a3;
  font-family: var(--vp-font-family-mono);
  font-size: 10.5px;
}
.hiw-divider {
  stroke: #262c3a;
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
  fill: #c3c8d0;
  font-family: var(--vp-font-family-mono);
  font-size: 10px;
  text-anchor: middle;
}

/* Traveling signal — the signature motif. */
.hiw-dot {
  fill: #2fd4c4;
}
.hiw-dot-halo {
  fill: #00a99a;
  opacity: 0.25;
}
.hiw-dot,
.hiw-dot-halo {
  offset-path: path('M214 150 C248 150 258 182 300 182 H540 C588 182 600 150 600 150');
  offset-distance: 0%;
}
@media (prefers-reduced-motion: no-preference) {
  .hiw-dot {
    animation: hiw-travel 4.4s cubic-bezier(0.6, 0, 0.4, 1) infinite;
  }
  .hiw-dot-halo {
    animation: hiw-travel-halo 4.4s cubic-bezier(0.6, 0, 0.4, 1) infinite;
  }
}
@keyframes hiw-travel {
  0% {
    offset-distance: 0%;
    opacity: 0;
  }
  10% {
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
@keyframes hiw-travel-halo {
  0% {
    offset-distance: 0%;
    opacity: 0;
  }
  10% {
    opacity: 0.25;
  }
  88% {
    opacity: 0.25;
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
