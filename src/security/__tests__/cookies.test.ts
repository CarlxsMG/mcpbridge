import { describe, test, expect } from "bun:test";
import {
  sessionCookieName,
  csrfCookieName,
  SESSION_COOKIE_NAME,
  CSRF_COOKIE_NAME,
  parseCookies,
} from "../../security/cookies.js";

describe("sessionCookieName / csrfCookieName", () => {
  test("use the __Host- prefix when secure=true (it requires the Secure attribute, which secure=true supplies)", () => {
    expect(sessionCookieName(true)).toBe("__Host-mcp_admin_session");
    expect(csrfCookieName(true)).toBe("__Host-mcp_admin_csrf");
  });

  test("drop the __Host- prefix when secure=false — that prefix mandates Secure, and a __Host- cookie without it is silently rejected by every spec-compliant client", () => {
    expect(sessionCookieName(false)).toBe("mcp_admin_session");
    expect(csrfCookieName(false)).toBe("mcp_admin_csrf");
  });

  test("the two names never collide with each other regardless of secure", () => {
    expect(sessionCookieName(true)).not.toBe(csrfCookieName(true));
    expect(sessionCookieName(false)).not.toBe(csrfCookieName(false));
  });
});

describe("SESSION_COOKIE_NAME / CSRF_COOKIE_NAME (module constants, computed from real config)", () => {
  test("match the secure=true naming by default (config.sessionCookieSecure defaults to true)", () => {
    expect(SESSION_COOKIE_NAME).toBe("__Host-mcp_admin_session");
    expect(CSRF_COOKIE_NAME).toBe("__Host-mcp_admin_csrf");
  });
});

describe("parseCookies", () => {
  test("parses either cookie name correctly regardless of which one is present", () => {
    expect(parseCookies("mcp_admin_session=abc; mcp_admin_csrf=def")).toEqual({
      mcp_admin_session: "abc",
      mcp_admin_csrf: "def",
    });
    expect(parseCookies("__Host-mcp_admin_session=abc")).toEqual({ "__Host-mcp_admin_session": "abc" });
  });
});

describe("parseCookies — edge cases (mutation backstop for src/security/cookies.ts)", () => {
  test("undefined or empty header yields an empty object", () => {
    expect(parseCookies(undefined)).toEqual({});
    expect(parseCookies("")).toEqual({});
  });

  // Kills L35 ConditionalExpression (`if (idx === -1) continue` → `if (false)`):
  // a segment with no "=" must be skipped, not stored mangled.
  test("a segment without '=' is skipped, not mangled (kills L35 ConditionalExpression)", () => {
    expect(parseCookies("novalue; a=b")).toEqual({ a: "b" });
  });

  // Kills L35 UnaryOperator (`idx === -1` → `idx === +1`): a single-char name
  // puts "=" at index 1, so the mutant would `continue` and drop the pair.
  test("a single-char cookie name is kept (kills L35 UnaryOperator -1→+1)", () => {
    expect(parseCookies("a=b")).toEqual({ a: "b" });
  });

  // Kills L37 MethodExpression (drops `.trim()` from the value).
  test("surrounding whitespace in the value is trimmed (kills L37 .trim removal)", () => {
    expect(parseCookies("k= v ")).toEqual({ k: "v" });
  });

  // Kills L38 ConditionalExpression (`if (!name) continue` → `if (false)`): an
  // empty name ("=orphan") must be dropped, not stored under the "" key.
  test("a segment with an empty name is dropped (kills L38 ConditionalExpression)", () => {
    expect(parseCookies("=orphan; a=b")).toEqual({ a: "b" });
  });

  // Kills L41 BlockStatement (the `catch {}` emptied): a malformed percent-escape
  // makes decodeURIComponent throw, and the catch must fall back to the raw value.
  test("a malformed percent-escape falls back to the raw value (kills L41 catch BlockStatement)", () => {
    expect(parseCookies("k=%ZZ")).toEqual({ k: "%ZZ" });
  });

  test("a well-formed percent-escape is decoded", () => {
    expect(parseCookies("k=%20end")).toEqual({ k: " end" });
  });
});
