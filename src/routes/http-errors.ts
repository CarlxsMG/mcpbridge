import type { Response } from "express";

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
