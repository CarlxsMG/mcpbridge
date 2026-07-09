/**
 * Stryker mutation-testing backstop for src/routes/http-errors.ts — domain 8.
 *
 * Baseline: 9 mutants, 2 killed / 3 survived / 4 timeouts. All line:col
 * citations below were read directly from reports/mutation/result.json.
 *
 * The 4 timeouts (20:99-22:2, 25:75-27:2, 30:82-32:2, 35:83-37:2 — each one
 * of sendError/validationError/notFound/forbidden's own whole-body-emptied
 * BlockStatement mutant) are accepted per this program's established
 * "genuine Stryker timeout = detected" convention: emptying any of these
 * functions makes them return `undefined` instead of the chained
 * `res.status(...).json(...)` Response, so any real HTTP-level test that
 * exercises this call path (a route handler expecting a real response to be
 * sent) hangs waiting for a response that never gets sent, and Stryker
 * correctly times it out rather than marking it Killed. Not chased with a
 * dedicated test.
 */
import { describe, test, expect } from "bun:test";
import type { Response } from "express";
import { requestId, sendError, validationError, notFound, forbidden } from "../../routes/http-errors.js";

/** Minimal Express Response mock: captures the status code + JSON body sent. */
function mockRes(requestIdValue?: string): Response & { sentStatus?: number; sentBody?: unknown } {
  const res: Partial<Response> & { sentStatus?: number; sentBody?: unknown } = {
    locals: requestIdValue !== undefined ? { requestId: requestIdValue } : {},
  };
  res.status = ((code: number) => {
    res.sentStatus = code;
    return res as Response;
  }) as Response["status"];
  res.json = ((body: unknown) => {
    res.sentBody = body;
    return res as Response;
  }) as Response["json"];
  return res as Response & { sentStatus?: number; sentBody?: unknown };
}

describe("requestId — reads res.locals.requestId, using ?? not &&", () => {
  // Kills 10:57-12:2 BlockStatement (whole body emptied -> returns
  // undefined) and 11:10-11:51 LogicalOperator (`??` -> `&&`, which would
  // return the RIGHT operand `null` whenever the left side is truthy).
  test("returns the real request id when one is present", () => {
    const res = mockRes("req-abc-123");
    expect(requestId(res)).toBe("req-abc-123");
  });

  test("returns null when no request id was ever set", () => {
    const res = mockRes();
    expect(requestId(res)).toBeNull();
  });
});

describe("validationError — the exact VALIDATION_ERROR code", () => {
  // Kills 26:30-26:48 StringLiteral (the "VALIDATION_ERROR" literal emptied).
  test("sends status 400 with the exact VALIDATION_ERROR code", () => {
    const res = mockRes("req-1");
    validationError(res, "bad input");
    expect(res.sentStatus).toBe(400);
    expect(res.sentBody).toEqual({
      error: { code: "VALIDATION_ERROR", message: "bad input", request_id: "req-1" },
    });
  });
});

describe("sendError / notFound / forbidden — exact envelope shape", () => {
  test("sendError builds the exact { error: { code, message, request_id } } envelope", () => {
    const res = mockRes("req-2");
    sendError(res, 418, "TEAPOT", "I am a teapot");
    expect(res.sentStatus).toBe(418);
    expect(res.sentBody).toEqual({ error: { code: "TEAPOT", message: "I am a teapot", request_id: "req-2" } });
  });

  test("notFound sends status 404 with the caller-supplied code", () => {
    const res = mockRes("req-3");
    notFound(res, "TOOL_NOT_FOUND", "no such tool");
    expect(res.sentStatus).toBe(404);
    expect(res.sentBody).toEqual({
      error: { code: "TOOL_NOT_FOUND", message: "no such tool", request_id: "req-3" },
    });
  });

  test("forbidden sends status 403 with the caller-supplied code", () => {
    const res = mockRes("req-4");
    forbidden(res, "IMMUTABLE_ENTRY", "cannot modify");
    expect(res.sentStatus).toBe(403);
    expect(res.sentBody).toEqual({
      error: { code: "IMMUTABLE_ENTRY", message: "cannot modify", request_id: "req-4" },
    });
  });
});
