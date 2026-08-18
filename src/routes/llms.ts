/**
 * `GET /llms.txt` — the llms.txt convention: a public, machine-readable
 * self-description an agent handed nothing but this gateway's URL can read to
 * work out what it is talking to and how to connect.
 *
 * PUBLIC AND UNAUTHENTICATED, which is the whole point and also the whole
 * risk. The document describes the SHAPE of the API — which endpoints exist,
 * what each one is for, how to authenticate — and must never describe THIS
 * deployment's contents. No client names, no tool names, no bundle names, no
 * counts, nothing read out of the registry or the database: an anonymous
 * caller learning which backends are registered here is an information
 * disclosure, and `tools/list` behind a key is the authoritative inventory
 * anyway. The body is therefore a constant plus exactly one interpolated
 * value, the resolved base URL — there is no code path that echoes anything
 * else the caller sent.
 */
import type { Request, Response, Express } from "express";
import { config } from "../config.js";
import { rateLimitExpensive } from "../middleware/rate-limiter.js";

/** Used when no base URL can be resolved or the caller's Host is unusable. */
const FALLBACK_BASE_URL = "http://localhost";

const DOCS_SITE = "https://carlxsmg.github.io/mcpbridge";
const SOURCE_REPO = "https://github.com/CarlxsMG/mcpbridge";

/**
 * The scheme the advertised base URL carries.
 *
 * `req.protocol` is Express's own accessor and is already the
 * `X-Forwarded-Proto`-aware one: it returns the forwarded scheme ONLY when
 * `app.set("trust proxy", …)` — set from `TRUST_PROXY` in `createApp` —
 * accepts the immediate peer as a trusted proxy, and the socket's own scheme
 * otherwise. Reading the header directly here instead would hand any anonymous
 * caller control of the scheme this public document gives the next agent, so
 * don't. The cost of that fail-safe is that a gateway behind a TLS-terminating
 * proxy with `TRUST_PROXY` unset resolves `http`, which is why the rendered
 * document tells the reader to prefer their own URL and the operator to set
 * `GATEWAY_PUBLIC_URL`.
 *
 * Clamped to the two schemes an MCP endpoint can be reached over. A trusted
 * proxy is trusted input, not validated input, and a non-special scheme would
 * otherwise reach the body as the literal `null`: `new URL("javascript://h")`
 * parses, and its `.origin` is the string `"null"`.
 */
function resolveGatewayScheme(req: Request): "http" | "https" {
  return req.protocol === "https" ? "https" : "http";
}

/**
 * Resolves the base URL this document advertises, mirroring the fallback order
 * in install-links.ts (`GATEWAY_PUBLIC_URL`, else the request's own
 * protocol + Host).
 *
 * `config.gatewayPublicUrl` is operator-configured and taken verbatim — a
 * deployment reverse-proxied under a path prefix needs that path to survive.
 * The Host header, by contrast, is caller-controlled, so it is round-tripped
 * through the URL parser and reduced to a bare origin before it can reach the
 * response body; anything the parser rejects falls back to the constant. That
 * is what keeps the rendered document "a constant plus one validated origin"
 * rather than a reflection point.
 */
function resolveGatewayBaseUrl(req: Request): string {
  if (config.gatewayPublicUrl) return config.gatewayPublicUrl;
  const host = req.get("host");
  if (!host) return FALLBACK_BASE_URL;
  try {
    return new URL(`${resolveGatewayScheme(req)}://${host}`).origin;
  } catch {
    return FALLBACK_BASE_URL;
  }
}

/** The whole document. Everything here is static except `base`. */
function renderLlmsTxt(base: string): string {
  return `# MCP REST Bridge

> A self-hosted MCP (Model Context Protocol) gateway. It fronts backend REST
> APIs, GraphQL APIs and other MCP servers, and re-exposes their tools to MCP
> clients through one uniform request path (SSRF check, guardrails, per-tool
> policy, circuit breaker, response sanitizing, audit).

This document describes the shape of this gateway's API. It deliberately names
no registered backend, tool or bundle — that inventory is available only to an
authenticated caller, from \`tools/list\` on an endpoint your key can reach, or
from the administrator who runs this gateway.

## Endpoints

The MCP endpoints below all speak MCP over the Streamable HTTP transport: POST
carries JSON-RPC 2.0 requests, GET opens the server-to-client event stream,
DELETE ends a session. The session id travels in the \`Mcp-Session-Id\` header.

- \`${base}/mcp\` — control plane. Exposes only this gateway's own \`sys_*\`
  management and reporting tools (inspect the registry, read guards and usage,
  operate the gateway), never a registered backend's tools. It is fail-closed:
  the caller must resolve to a gateway system role, each tool additionally
  carries its own read/operate/admin tier, and the sensitive ones require an
  explicit confirmation or an elevated credential.
- \`${base}/mcp/<clientName>\` — data plane, per-client shard. Exposes the tools
  of exactly one registered backend.
- \`${base}/mcp-custom/<bundleName>\` — data plane, curated bundle. Exposes an
  administrator-defined, cross-client subset of tools, plus any composite
  ("macro") tools that bundle includes.

Both data-plane forms are narrowing filters over the same dispatch pipeline —
guards, quotas, circuit breakers and SSRF protection behave identically no
matter which one a call arrived through.

### About the base URL above

\`${base}\` is what this gateway resolved for your request: the public URL its
operator configured, or failing that the scheme and \`Host\` this request
arrived with. Treat it as a hint, not as authoritative — prefer the URL you
were given. An \`http://\` scheme on a gateway you reached over HTTPS is the
usual tell that it is wrong, because a gateway whose TLS is terminated by a
reverse proxy cannot see the public scheme unless it is configured to trust
that proxy. Operators: set \`GATEWAY_PUBLIC_URL\` to the address clients
actually use, and this document (plus every generated connection snippet) will
advertise it verbatim.

Supporting HTTP endpoints:

- \`GET ${base}/health\` — status and uptime. Unauthenticated.
- \`GET ${base}/livez\`, \`GET ${base}/readyz\` — liveness and readiness probes.
- \`${base}/docs\` — Swagger UI over the full OpenAPI specification. Admin
  authenticated unless the operator opted into serving it publicly.
- \`${base}/admin\` — the human-facing admin UI.

## Authentication

Every MCP endpoint expects a bearer token:

    Authorization: Bearer <mcp-api-key>

Keys are minted by a gateway administrator; there is no self-service
registration and no anonymous access to the data plane. A key is scoped — it
may be restricted to a subset of tools, attributed to a named consumer with a
call quota, and revoked at any time — so a key that works on one endpoint is
not automatically accepted on another. If you do not have one, ask whoever
gave you this URL.

## Connecting a client

Most MCP clients take a JSON entry of this shape:

    {
      "mcpServers": {
        "mcp-rest-bridge": {
          "type": "streamable-http",
          "url": "${base}/mcp",
          "headers": { "Authorization": "Bearer <mcp-api-key>" }
        }
      }
    }

Point \`url\` at whichever endpoint above matches what you need: the control
plane to manage the gateway, a per-client shard or a bundle to call backend
tools. Then run the standard MCP handshake — \`initialize\`, then \`tools/list\`
to discover what your key can actually reach.

## Documentation

- Full documentation: ${DOCS_SITE}/
- Getting started: ${DOCS_SITE}/guide/getting-started
- Core concepts: ${DOCS_SITE}/guide/concepts
- Architecture: ${DOCS_SITE}/guide/architecture
- Connecting clients: ${DOCS_SITE}/guide/connecting-clients
- Access control: ${DOCS_SITE}/guide/access-control
- Source code: ${SOURCE_REPO}
`;
}

export function llmsRoutes(app: Express): void {
  app.get(
    "/llms.txt",
    // Its own budget rather than the install-link tier's: sharing that bucket
    // would let a crawler pulling this document lock a teammate out of
    // /install/:token from the same IP. `rateLimitExpensive` is keyed by
    // routeTag precisely so a route can get an independent per-IP ceiling
    // without inventing another config knob; the global limit is far too
    // coarse to be the only thing in front of an anonymous endpoint.
    rateLimitExpensive("llms_txt", config.rateLimitExpensive),
    (req: Request, res: Response) => {
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.status(200).send(renderLlmsTxt(resolveGatewayBaseUrl(req)));
    },
  );
}
