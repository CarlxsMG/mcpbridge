import type { Request, Response } from "express";

/**
 * Reads the per-request correlation id (set by the requestId middleware) off
 * res.locals. Returns null if that middleware hasn't run for this response
 * (e.g. a handler invoked outside the normal request pipeline) rather than
 * throwing — every route in src/routes/ used to redeclare this exact
 * function, so it now lives here as the single source of truth.
 */
export function requestId(res: Response): string | null {
  return (res.locals?.requestId as string) ?? null;
}

/**
 * Sends the standard admin-API error envelope:
 * `{ error: { code, message, request_id } }`. This is the shape every route
 * handler in src/routes/ builds by hand today; centralizing it keeps the
 * envelope (and its request_id sourcing) byte-identical everywhere.
 */
export function sendError(res: Response, status: number, code: string, message: string): Response {
  return res.status(status).json({ error: { code, message, request_id: requestId(res) } });
}

/** 400 with the near-universal "VALIDATION_ERROR" code (by far the most common call site). */
export function validationError(res: Response, message: string): Response {
  return sendError(res, 400, "VALIDATION_ERROR", message);
}

/** 404 — code varies per resource (TOOL_NOT_FOUND, CLIENT_NOT_FOUND, ...), so it's a parameter. */
export function notFound(res: Response, code: string, message: string): Response {
  return sendError(res, 404, code, message);
}

/** 403 — code varies (FORBIDDEN, IMMUTABLE_ENTRY, ...), so it's a parameter. */
export function forbidden(res: Response, code: string, message: string): Response {
  return sendError(res, 403, code, message);
}

/**
 * Gives Express's untyped `req.body` a usable object shape. The `?? {}` fallback
 * is load-bearing: Express leaves `req.body` `undefined` when no body-parsing
 * middleware matched (or the parsed body was empty), so every route handler in
 * src/routes/ used to write `(req.body as Record<string, unknown>) ?? {}` by hand.
 */
export function bodyOf(req: Request): Record<string, unknown> {
  return (req.body as Record<string, unknown>) ?? {};
}

/**
 * Like {@link bodyOf} but preserves a `null`/absent body instead of defaulting
 * to `{}` — for handlers (auth login / password change) that read fields via
 * optional chaining and must not conflate "no body" with an empty object.
 */
export function bodyOrNull(req: Request): Record<string, unknown> | null {
  return req.body as Record<string, unknown> | null;
}
