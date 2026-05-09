---
id: file_96ceeb54dc85168c
kind: file
source_path: src/middleware/request-id.ts
title: "Request ID Middleware"
run_id: 9e628494-d1e3-4ccc-a704-a37300cef0ce
generated_at: 2026-05-07T21:09:04.791Z
---

# Request ID Middleware

**Path:** `src/middleware/request-id.ts`  
**Kind:** `file`  
**Model:** `sonnet`  
**Generated:** `sonnet@item-doc/v1`

> Express middleware that ensures every HTTP request carries a unique identifier throughout its lifecycle. On each request it reads the incoming `X-Request-ID` header — honouring a caller-supplied ID for distributed-tracing continuity — or generates a fresh UUID v4 via Node's built-in `crypto.randomUUID`. The resolved ID is stored on `res.locals.requestId` for downstream handlers and mirrored back to the client as the `X-Request-ID` response header. Enables consistent correlation of logs, errors, and responses across services without any external dependency.

# Request ID Middleware

## Purpose
Attaches a unique request identifier to every incoming HTTP request. The ID is propagated forward via `res.locals` for downstream middleware and controllers, and echoed back to the caller via a response header, enabling end-to-end request tracing.

## Export
| Symbol | Type | Description |
|---|---|---|
| `requestIdMiddleware` | `(req, res, next) => void` | Standard Express middleware that resolves or generates a request ID |

## Key Flow
1. **Header inspection** — reads `req.headers["x-request-id"]` (cast to `string`).
2. **Fallback generation** — if the header is absent or falsy, calls `crypto.randomUUID()` to produce a UUID v4.
3. **Propagation** — assigns the resolved ID to `res.locals.requestId` so any subsequent handler can access it via `res.locals.requestId`.
4. **Response header** — calls `res.setHeader("X-Request-ID", requestId)` so the client and reverse proxies can correlate the response.
5. **Delegation** — calls `next()` unconditionally; the middleware never terminates the request.

## Usage
Register early in the Express application stack so the ID is available to all later middleware (e.g. loggers, error handlers):

```ts
import { requestIdMiddleware } from "./middleware/request-id";
app.use(requestIdMiddleware);
```

Downstream access:
```ts
const id = res.locals.requestId; // string (UUID or caller-supplied value)
```

## Edge Cases & Gotchas
- **Header injection risk** — the middleware accepts any caller-supplied value for `x-request-id` without validation or sanitisation. A malicious or misconfigured upstream could inject an arbitrary string (e.g. very long value, special characters) into logs/responses.
- **Type cast** — `req.headers["x-request-id"]` is cast directly to `string`; if a client sends multiple `x-request-id` headers, Express collapses them into a comma-separated string rather than an array, which is silently accepted.
- **No uniqueness guarantee for caller-supplied IDs** — when the header is forwarded, the middleware trusts the upstream value without checking for collisions.
- **Crypto availability** — `crypto.randomUUID` requires Node.js ≥ 14.17.0; environments older than this will throw at runtime.

---

## References

### has_dep
- [other:node:crypto](../knowledge/deps/other-node-crypto.md)
- [npm:express](../knowledge/deps/npm-express.md)

### has_failure_mode
- [Header Injection via Unsanitised Caller ID](../knowledge/failure-modes/header-injection-via-unsanitised-caller-id.md)
- [Multiple X-Request-ID Headers Collapsed Silently](../knowledge/failure-modes/multiple-x-request-id-headers-collapsed-silently.md)
- [Runtime Crash on Old Node.js](../knowledge/failure-modes/runtime-crash-on-old-node-js.md)

### has_pattern
- [Request-Scoped Context via res.locals](../knowledge/patterns/request-scoped-context-via-res-locals.md)
- [Pass-Through Header Propagation](../knowledge/patterns/pass-through-header-propagation.md)
- [Echo Response Header](../knowledge/patterns/echo-response-header.md)

### uses_concept
- [Request ID](../knowledge/concepts/request-id.md)
- [res.locals](../knowledge/concepts/res-locals.md)
- [Distributed Tracing](../knowledge/concepts/distributed-tracing.md)
- [UUID v4](../knowledge/concepts/uuid-v4.md)
- [Express Middleware](../knowledge/concepts/express-middleware.md)

## Backlinks

### references
- [Application Entry Point — MCP REST Bridge Server](src--index.ts.md)

### parent_of
- [src/middleware — HTTP Security & Request Pipeline](../dirs/src--middleware.md)




