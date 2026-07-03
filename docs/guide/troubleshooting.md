# Troubleshooting

Common issues and their fixes. Most are deliberate safety behaviour rather than bugs.

## A backend on localhost/private IP is rejected

SSRF protection blocks loopback and private addresses by design. For **local development
only**, set `ALLOW_PRIVATE_IPS=true` to register backends at `127.0.0.1` etc. Never enable it
in production.

## Admin login fails over http://localhost

The session cookie is `__Host-`/`Secure` by default and browsers won't store it over plain
HTTP. For local dev, set `SESSION_COOKIE_SECURE=false` **and** `NODE_ENV=development` (which
relaxes the startup guard). In production, serve over HTTPS and leave both at their defaults.

## Login was working, now the cookie won't set on localhost

Toggling `SESSION_COOKIE_SECURE` on the same origin can leave a stale `__Host-` cookie that
shadows the plain one. **Clear the site's cookies** and log in again.

## A sharded/bundle endpoint returns 404 for my session

The per-client and bundle endpoints reject a session created for a _different_ scope, and
return the **same 404** as an unknown session (so a caller can't distinguish "wrong shard"
from "no session"). Open the session against the exact URL you'll use.

## Discovery finds no tools / errors

- **No tools** — check your `include_tags` / `exclude_operations` filters aren't excluding
  everything.
- **`OPENAPI_CYCLIC_REFERENCE`** — the spec has a self-referential cycle (often a YAML anchor
  loop); the bridge rejects it rather than hang. Flatten the offending schema.

## Tool calls are rejected

- **Allowed-key restriction** — the calling key isn't in the tool's allow-list (fail-closed
  even if global auth is off).
- **Guardrail** — the input matched a deny-rule or secret pattern, or the key lacks
  _elevated_ scope for a sensitive tool.
- **Circuit breaker open** — the backend is failing; calls fail fast until it recovers.

## The admin UI isn't served

The backend serves the built SPA from `admin-ui/dist` at `/admin`. If you see a warning that
`admin-ui/dist` is missing, run `bun run build` in `admin-ui/` (the Docker image does this in
a dedicated stage).

## Still stuck?

Open an issue with the request ID from the error response (`error.request_id`) — it ties the
failure to the structured server log.
