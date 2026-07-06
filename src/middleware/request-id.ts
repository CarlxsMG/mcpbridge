import type { Request, Response, NextFunction } from "express";
import { randomUUID } from "crypto";
import { parseTraceparent, withTraceContext } from "../observability/trace-context.js";

/**
 * Per-request middleware:
 *   - Stamps every request with an `X-Request-ID` (echoed in the response),
 *     generating one if the caller didn't supply one.
 *   - Parses a W3C `traceparent` header (when present and well-formed) and
 *     stashes the parent in an AsyncLocalStorage context, so any code that
 *     later calls `startSpan(...)` from this request's async tree inherits
 *     the upstream trace-id. A malformed or missing header is treated as
 *     "no parent, mint a fresh trace" — never a hard error.
 *   - Carries the W3C `tracestate` header through unmodified, per the
 *     forwarder rule in the W3C Trace Context spec.
 */
export function requestIdMiddleware(req: Request, res: Response, next: NextFunction): void {
  const requestId = (req.headers["x-request-id"] as string) || randomUUID();
  res.locals.requestId = requestId;
  res.setHeader("X-Request-ID", requestId);

  const traceparent = parseTraceparent(req.headers["traceparent"] as string | undefined);
  const tracestateRaw = req.headers["tracestate"];
  const tracestate = typeof tracestateRaw === "string" && tracestateRaw.length > 0 ? tracestateRaw : null;

  withTraceContext({ traceparent, tracestate, currentSpan: null }, () => next());
}
