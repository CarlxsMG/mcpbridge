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
