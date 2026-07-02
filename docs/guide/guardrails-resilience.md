# Guardrails, policies & resilience

Every tool call runs through a uniform stack at the dispatch point (`proxyToolCall`) — see
the [request path](/guide/architecture#the-request-path). This page covers the knobs you set
per tool or per client.

## Content guardrails

Enable any of these on a tool:

- **Input deny-rules** — reject calls whose arguments match configured patterns.
- **Secret detection** — block requests that appear to carry credentials or tokens.
- **Response sanitizing** — scan backend responses for prompt-injection payloads and wrap
  untrusted data in a safe envelope before it reaches the model.
- **Field redaction** — strip sensitive fields from responses.

Guardrails run **before** the circuit breaker, so a rejected call never consumes a breaker
probe slot.

## Per-tool policy & reusable policies

Set a **rate limit**, **timeout**, **circuit-breaker override** or **allowed-key**
restriction on any single tool. To avoid repetition, define a reusable **guard policy**
(rate + timeout) once and apply it across a whole bundle of tools.

## Circuit breakers

Each tool has a breaker that trips after repeated failures (`closed → open → half_open`).
While open, calls fail fast; a single probe in `half_open` tests recovery. Tune the failure
threshold and reset window per client, or reset a breaker manually from a server's detail page.

## Canary & failover

Give a REST client a validated **secondary** backend URL (SSRF-checked and IP-pinned at
config time):

- **canary** — send a weighted slice of traffic to the secondary.
- **failover** — route to the secondary when the primary's breaker is open, **without**
  falsely closing the primary breaker (a secondary success must not mask a primary outage).

## Response cache & load balancing

- **Response cache** (opt-in per tool) serves identical calls from memory; bound it with
  `CACHE_MAX_ENTRIES`.
- **N-way load balancing** spreads a tool across several backend targets, skipping a failed
  target for `LB_TARGET_COOLDOWN_MS`. Pairs naturally with failover.

Next: **[Observability →](/guide/observability)** · **[Scaling →](/guide/scaling)**
