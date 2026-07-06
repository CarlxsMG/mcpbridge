# Two planes, three endpoints — the /mcp split

* Status: accepted
* Date: 2026-07-06
* Deciders: CarlxsMG (architecture), Claude Sonnet 5 (review + hardening)

## Context and Problem Statement

`/mcp` used to be a single endpoint that aggregated every enabled client's
backend tools into one flattened session. That collided with the actual
per-client data endpoints (`/mcp/:clientName`) and the curated cross-client
endpoints (`/mcp-custom/:bundleName`) in three concrete ways:

1. **No way to manage the gateway itself over MCP.** Operators connecting an
   admin LLM to the bridge had to drop out of MCP to call REST admin
   endpoints for the day-to-day: list clients, register a new backend, mint
   or revoke MCP keys, tail the audit log, reset a circuit breaker.
2. **Composite (macro) tools leaked.** A composite registered against one
   bundle could be invoked from a session scoped to a different bundle, or
   from the aggregate, which broke the "this bundle's API surface" invariant.
3. **The legacy SSE transport (`GET /sse` + `POST /messages`) was tied to
   the aggregate.** Streamable HTTP had to be added alongside SSE rather than
   replacing it, doubling the transport surface area to maintain.

The question: how do we restructure `/mcp` so the bridge is both governable
(an admin LLM can drive it via MCP) and bounded (a session can only see the
tools it was scoped to)?

## Decision Drivers

* **Auth plane separation.** The data plane (`/mcp/:clientName`,
  `/mcp-custom/:bundleName`) uses `mcpAuth` which has an explicit
  "no auth material configured → allow all" fallback (dev-only). The
  control plane (gateway management) cannot have that fallback — an
  unconfigured admin API would let anyone mint keys. The two planes
  need different auth logic.
* **Composites belong to bundles, not to the bridge.** A composite is
  "this bundle's macro", not a standalone tool. Its scope must be the
  bundle it was added to, not the global session.
* **Streamable HTTP only.** Carrying both SSE and Streamable HTTP doubles
  the surface area for tests, transport errors, and proxy quirks
  (see REVIEW §2.6).
* **No breaking change to the per-client endpoints.** Existing MCP
  clients connecting to `/mcp/:clientName` should not need to know
  anything changed.

## Considered Options

* **A. Keep `/mcp` as the aggregate, add `/mcp/admin` as a sibling.**
  Two endpoints, same hostname, different auth. Rejected: the aggregate
  remains the "magic endpoint that flattens everything", which is
  exactly what we're trying to delete; and the composites issue stays
  because they still live in the aggregate.
* **B. Rename `/mcp` to `/mcp/:clientName` and create `/mcp/admin`.**
  Rejected: requires every existing MCP client (potentially external)
  to update its base URL. Breaks the public contract on day one of the
  refactor.
* **C. Repurpose `/mcp` as the control plane; keep
  `/mcp/:clientName` and `/mcp-custom/:bundleName` as the data plane.**
  Chosen. The control plane's auth (`rootMcpAuth` /
  `resolveSystemRole`) is fail-closed by design and resolves only from
  the env admin Bearer or a managed MCP key's `adminRole` column
  (migration 51). The data plane's auth stays unchanged.

## Decision Outcome

Chosen option: **C — two planes, three endpoints**.

`/mcp` is now the **system control plane**: `sys_*` tools (list/register/
enable clients, mint/revoke MCP keys, tail the audit log, reset a circuit
breaker, …) backed by the same domain functions the REST admin API
already calls. `/mcp/:clientName` and `/mcp-custom/:bundleName` are the
**data plane** shards. Composites moved into bundle membership (migration
52, `mcp_bundle_composites`) — a composite must be added to a bundle's
`composites[]` to be reachable. The legacy SSE transport is removed;
Streamable HTTP is the only inbound MCP transport now.

Each system tool carries a role tier (read / operate / admin, mirroring
`requireOperator` / `requireAdminRole` in the REST authz middleware) and a
sensitive / `__confirm` step-up gate, reusing the same mechanism
`proxy.ts` already applies to sensitive backend tools.

### Consequences

* Good, because the bridge is now fully governable over MCP — an admin
  LLM can drive the whole lifecycle (register, configure, mint key, call)
  through one protocol.
* Good, because the data plane's existing auth contract is unchanged;
  no MCP client needs a config update.
* Good, because removing the aggregate scope also removes the composite
  leakage: composites can only be invoked via the bundle they belong to.
* Good, because removing SSE cuts the transport matrix in half — every
  e2e and integration test runs against one transport now.
* Bad, because any operator who was relying on `/mcp` as a shortcut
  (one URL, all tools) has to choose between `/mcp` (control) and the
  per-client / bundle shards (data).
* Bad, because `mcp-server.ts`'s client-scope check used to be a name
  prefix test instead of exact tool→client membership; the refactor
  surfaced this by being the first time the data plane was exercised
  in isolation against its own auth gate. Closed in the same commit
  (exact `Set` membership, matching what the bundle branch already did).

### Confirmation

* `src/mcp/system-tools.ts` registers every `sys_*` tool with an explicit
  role tier and the same `__confirm` / elevated-credential step-up the
  proxy already enforces on sensitive backend tools.
* `src/security/system-role.ts` `resolveSystemRole` rejects callers with
  no system-role credential — there is **no** unconfigured-admin open
  mode. Covered by `src/__tests__/system-tools.test.ts`.
* `e2e/auth-fail-closed.spec.ts` and `e2e/mcp-protocol.spec.ts` exercise
  the data plane against the post-split `/mcp/:clientName` endpoint, with
  each spec minting its own managed MCP key so the suite is
  order-independent.

## More Information

* Commit: `69fd8eb` — `feat(mcp): split /mcp into a system control plane,
  separate from data-plane shards`
* Review: `docs/REVIEW.md` §0 (Modularidad ★★★☆☆) and §2.4 (Cobertura).
* Related code: `src/mcp/system-tools.ts`,
  `src/security/system-role.ts`, `src/mcp/transports.ts`.