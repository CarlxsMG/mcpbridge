# Guardrails & resilience

Every tool call runs through a uniform stack at the dispatch point (`proxyToolCall`) — see
the [request path](/guide/architecture#the-request-path). This page covers the knobs you set
per tool or per client.

## Circuit breakers

Each tool has a breaker that trips after repeated failures (`closed → open → half_open`).
While open, calls fail fast; a single probe in `half_open` tests recovery. Tune the failure
threshold and reset window per client, or reset a breaker manually from a server's detail page.

## Content guardrails

Enable any of these on a tool:

- **Input deny-rules** — reject calls whose arguments match configured patterns.
- **Secret detection** — block requests that appear to carry credentials or tokens.
- **Response sanitizing** — scan backend responses for prompt-injection payloads and wrap
  untrusted data in a safe envelope before it reaches the model.
- **Field redaction** — strip sensitive fields from responses.
- **Context-budget guard** — deterministically truncate an oversized tool response, or
  opt in to LLM summarization via a bring-your-own-key OpenAI/Anthropic-compatible endpoint,
  so one call can't blow an agent's context window.

Guardrails run **before** the circuit breaker above, so a rejected call never consumes a
breaker probe slot.

## Per-tool overrides

Set a **rate limit**, **timeout**, **circuit-breaker override** or **allowed-key**
restriction on any single tool.

## Reusable guard policies

To avoid repeating the same rate limit + timeout on every tool in a bundle, define a reusable
**guard policy** (rate + timeout only) once and apply it across the whole bundle.

## Canary & failover

Give a REST client a validated **secondary** backend URL (SSRF-checked and IP-pinned at
config time):

- **canary** — send a weighted slice of traffic to the secondary.
- **failover** — route to the secondary when the primary's breaker is open, **without**
  falsely closing the primary breaker (a secondary success must not mask a primary outage).

## Response cache & load balancing

- **Response cache** (opt-in per tool) serves identical calls from memory; bound it with
  `CACHE_MAX_ENTRIES`.
- **N-way load balancing** spreads a client across several backend targets, skipping a failed
  target for `LB_TARGET_COOLDOWN_MS`. Pairs naturally with failover.

Next: **[Observability →](/guide/observability)** · **[Scaling →](/guide/scaling)**
