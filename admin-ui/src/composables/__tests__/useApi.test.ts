// Unit coverage for the pure `loginRedirectUrl` helper extracted from useApi.ts's
// 401 handler (see rawFetch). This is the ONLY piece of useApi.ts covered here —
// the rest of rawFetch/apiFetch (real fetch(), CSRF header, JSON error parsing,
// the demo-mode branch) is not exercised: mocking `fetch` and `window.location`
// end-to-end for the 401-redirect flow is not trivial with the current test
// setup (jsdom's window.location isn't reassignable the way `href =` needs, and
// there's no existing fetch-mocking harness in this suite), so it's left out
// rather than bolted on with brittle globals. Before this file, useApi.ts had
// zero test coverage.
import { describe, expect, it } from "vitest";
import { loginRedirectUrl } from "../useApi";

describe("loginRedirectUrl", () => {
  it("strips the base prefix from the pathname so a post-login push doesn't double it up", () => {
    // The regression this whole function guards against: without stripping,
    // router.push() (base-relative under createWebHistory("/admin/")) would
    // turn a stored "/admin/keys" redirect into "/admin/admin/keys".
    const url = loginRedirectUrl("/admin/keys", "", "/admin/");
    expect(url).toBe("/admin/login?redirect=%2Fkeys");
  });

  it("falls back to / when the pathname is exactly the bare base", () => {
    const url = loginRedirectUrl("/admin", "", "/admin/");
    expect(url).toBe("/admin/login?redirect=%2F");
  });

  it("passes the pathname through unchanged when it doesn't start with the base", () => {
    const url = loginRedirectUrl("/other/path", "", "/admin/");
    expect(url).toBe("/admin/login?redirect=%2Fother%2Fpath");
  });

  it("derives the prefix from base instead of hardcoding /admin (demo build base)", () => {
    const url = loginRedirectUrl("/mcpbridge/demo/keys", "", "/mcpbridge/demo/");
    expect(url).toBe("/mcpbridge/demo/login?redirect=%2Fkeys");
  });

  it("preserves the query string in the redirect target", () => {
    const url = loginRedirectUrl("/admin/keys", "?page=2", "/admin/");
    expect(url).toBe("/admin/login?redirect=%2Fkeys%3Fpage%3D2");
  });
});
