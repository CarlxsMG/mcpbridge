import type { Request, Response, NextFunction } from "express";
import { config } from "../config.js";
import { matchesOriginEntry } from "../lib/origin-match.js";

/**
 * Resolves whether a request `Origin` header is in the configured allowlist.
 *
 * Entries in `config.corsOrigins` are already canonicalised by
 * `parseCorsOrigins` in `config.ts`: scheme is exact, host is lowercased,
 * port is included only when non-default. The raw `Origin` header value from
 * the browser is compared against each entry via {@link matchesOriginEntry}
 * (with `supportsPortWildcard: false` — this allowlist has no ":*" syntax),
 * which parses+lowercases the same way, so casing differences in the host
 * segment do not cause false negatives.
 *
 * @returns The matching entry (i.e. the canonical form of the request
 *   origin) if allowed, or `null` if not.
 */
function matchAllowedOrigin(requestOrigin: string): string | null {
  const origins = config.corsOrigins;
  if (origins.length === 0) return null;

  // Wildcard mode — allow any origin (credentials are never sent in this mode)
  if (origins[0] === "*") return requestOrigin;

  return origins.find((entry) => matchesOriginEntry(requestOrigin, entry, { supportsPortWildcard: false })) ?? null;
}

/**
 * Express middleware that enforces strict CORS origin validation.
 *
 * Behaviour:
 *   - Requests without an `Origin` header pass through unmodified (same-origin
 *     or non-browser requests).
 *   - Requests whose `Origin` is in `config.corsOrigins` receive the exact
 *     matching origin in `Access-Control-Allow-Origin` (never `*`) plus
 *     appropriate CORS headers and `Vary: Origin`.
 *   - Preflight (`OPTIONS`) requests from an allowed origin receive HTTP 204
 *     and the middleware short-circuits (no downstream handler runs).
 *   - Preflight requests from a disallowed origin receive HTTP 403 with no
 *     CORS headers so the browser blocks the actual request.
 *   - Non-preflight requests from a disallowed origin continue to the next
 *     handler without CORS headers; the browser will block the response itself.
 */
export function corsMiddleware(req: Request, res: Response, next: NextFunction): void {
  const requestOrigin = req.headers.origin as string | undefined;

  if (!requestOrigin) {
    // No Origin header — same-origin request or non-browser client; skip CORS
    if (req.method === "OPTIONS") {
      res.sendStatus(204);
      return;
    }
    next();
    return;
  }

  const allowedOrigin = matchAllowedOrigin(requestOrigin);
  const isWildcard = config.corsOrigins[0] === "*";

  if (allowedOrigin !== null) {
    // Vary must be set whenever the response depends on the Origin value so
    // that shared caches serve the correct headers to each origin.
    res.setHeader("Vary", "Origin");

    if (isWildcard) {
      // Wildcard mode: reflect the request origin but never send credentials
      res.setHeader("Access-Control-Allow-Origin", requestOrigin);
    } else {
      res.setHeader("Access-Control-Allow-Origin", allowedOrigin);
    }

    res.setHeader("Access-Control-Allow-Methods", config.corsAllowedMethods.join(", "));
    res.setHeader("Access-Control-Allow-Headers", config.corsAllowedHeaders.join(", "));
    res.setHeader("Access-Control-Expose-Headers", config.corsExposedHeaders.join(", "));
    res.setHeader("Access-Control-Max-Age", String(config.corsMaxAgeSeconds));

    // Credentials only when explicitly enabled AND not in wildcard mode
    if (config.corsAllowCredentials && !isWildcard) {
      res.setHeader("Access-Control-Allow-Credentials", "true");
    }

    if (req.method === "OPTIONS") {
      res.sendStatus(204);
      return;
    }
  } else {
    // Origin not in allowlist
    if (req.method === "OPTIONS") {
      // Reject preflight so the browser never sends the actual request
      res.sendStatus(403);
      return;
    }
    // For non-preflight, omit CORS headers; browser will block the response
  }

  next();
}
