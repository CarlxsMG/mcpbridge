/**
 * Tests for `requestIdMiddleware` — the correlation-id + W3C trace-context
 * entry point. The header/res.locals stamping is the pre-existing behavior; the
 * added coverage is that the middleware binds the id as the ambient correlation
 * id (via the logger's ALS) for the duration of `next()`, so any `log()` call
 * downstream is auto-tagged with `request_id` without editing each call site.
 */
import { describe, test, expect, spyOn } from "bun:test";
import type { Request, Response, NextFunction } from "express";
import { requestIdMiddleware } from "../request-id.js";
import { log } from "../../logger.js";
import { config } from "../../config.js";

interface FakeRes {
  locals: Record<string, unknown>;
  headers: Record<string, string>;
  setHeader(key: string, value: string): void;
}

function makeReqRes(headers: Record<string, string> = {}): { req: Request; res: Response; fake: FakeRes } {
  const fake: FakeRes = {
    locals: {},
    headers: {},
    setHeader(key: string, value: string) {
      this.headers[key] = value;
    },
  };
  return {
    req: { headers } as unknown as Request,
    res: fake as unknown as Response,
    fake,
  };
}

describe("requestIdMiddleware", () => {
  test("echoes a caller-supplied X-Request-ID onto the response and res.locals", () => {
    const { req, res, fake } = makeReqRes({ "x-request-id": "hdr-123" });
    let called = false;
    requestIdMiddleware(req, res, (() => {
      called = true;
    }) as NextFunction);
    expect(called).toBe(true);
    expect(fake.headers["X-Request-ID"]).toBe("hdr-123");
    expect(fake.locals.requestId).toBe("hdr-123");
  });

  test("mints a fresh UUID when the caller sends no X-Request-ID", () => {
    const { req, res, fake } = makeReqRes();
    requestIdMiddleware(req, res, (() => {}) as NextFunction);
    const id = fake.locals.requestId;
    expect(typeof id).toBe("string");
    // RFC-4122 v4 shape.
    expect(String(id)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(fake.headers["X-Request-ID"]).toBe(String(id));
  });

  test("binds the id as the ambient correlation id for logs emitted inside next()", () => {
    const original = config.logFormat;
    (config as Record<string, unknown>).logFormat = "json";
    const spy = spyOn(console, "log").mockImplementation(() => {});
    try {
      const { req, res } = makeReqRes({ "x-request-id": "corr-777" });
      requestIdMiddleware(req, res, (() => {
        log("info", "handler ran");
      }) as NextFunction);
      const line = spy.mock.calls.at(-1)?.[0];
      const entry = JSON.parse(String(line)) as Record<string, unknown>;
      expect(entry.request_id).toBe("corr-777");
      expect(entry.message).toBe("handler ran");
    } finally {
      spy.mockRestore();
      (config as Record<string, unknown>).logFormat = original;
    }
  });

  test("the ambient correlation id does not leak past next() (scoped to the request subtree)", () => {
    const original = config.logFormat;
    (config as Record<string, unknown>).logFormat = "json";
    const spy = spyOn(console, "log").mockImplementation(() => {});
    try {
      const { req, res } = makeReqRes({ "x-request-id": "scoped-1" });
      requestIdMiddleware(req, res, (() => {}) as NextFunction);
      // Logging AFTER the synchronous middleware returned must not carry the id.
      log("info", "after middleware");
      const line = spy.mock.calls.at(-1)?.[0];
      const entry = JSON.parse(String(line)) as Record<string, unknown>;
      expect("request_id" in entry).toBe(false);
    } finally {
      spy.mockRestore();
      (config as Record<string, unknown>).logFormat = original;
    }
  });
});
