/**
 * End-to-end test for the admin API's CSRF gate and session lifecycle — the
 * half of `adminAuth` (src/middleware/auth.ts) that only a real browser can
 * exercise, because it hinges on cookies the SPA's own JS is (and is not)
 * allowed to read.
 *
 * The invariants pinned here, all read straight out of src/middleware/auth.ts,
 * src/routes/auth.ts, src/security/session-store.ts and src/security/cookies.ts:
 *
 *   - A Bearer token is tried FIRST and unconditionally; the session branch is
 *     only reached when `extractBearerToken` finds no `Bearer ` credential.
 *   - A session-authenticated MUTATION requires a matching `X-CSRF-Token`.
 *     The refusal is exactly `403 CSRF_VALIDATION_FAILED`. Safe methods
 *     (GET/HEAD/OPTIONS) are exempt, and so are Bearer callers.
 *   - The header is compared with `safeCompare` against the token stored on
 *     THAT session row — so a real token minted for a *different* session must
 *     be refused, which a presence-only check would sail straight through.
 *   - Logging out revokes the session row server-side, not just the browser's
 *     copy of the cookie: replaying the captured cookie value is a 401.
 *   - Cookie NAMES track `SESSION_COOKIE_SECURE`. This stack runs it `false`
 *     over plain http (playwright.config.ts), so the names are the
 *     non-prefixed `mcp_admin_session` / `mcp_admin_csrf`. A hardcoded
 *     `__Host-` prefix once broke login outright — a client silently refuses
 *     to store a `__Host-` cookie that isn't `Secure`, with no error anywhere.
 *
 * The mutation under test is `POST /admin-api/teams` (src/routes/teams.ts),
 * chosen because its exact path also answers a GET — so the "safe methods are
 * exempt" assertion can vary nothing but the HTTP method. Nothing here mints a
 * managed MCP key: that would flip the data plane out of open mode and change
 * what auth-fail-closed.spec.ts observes.
 */
import {
  test,
  expect,
  type APIRequestContext,
  type APIResponse,
  type BrowserContext,
  type Page,
} from "@playwright/test";
import { APP_BASE_URL, BOOTSTRAP_ADMIN_PASSWORD, BOOTSTRAP_ADMIN_USERNAME } from "./support/env";
import { apiHeaders, createAdminUser, loginAs, type AdminAuth } from "./support/admin";

/**
 * One extra account of our own — the "other user" the cross-session assertion
 * needs, and the one this file signs out, so no other spec's session is ever
 * destroyed here. `role: "admin"` with no team = super-admin, which is what
 * POST /admin-api/teams requires (requireSuperAdmin, src/middleware/authz.ts);
 * new users get `team_id` NULL, so it qualifies on creation. Every other
 * assertion reuses the bootstrap admin, so this spec adds exactly one account.
 */
const SECOND_ADMIN = "e2e-csrf-second-admin";
/** >= 12 chars — the POST /admin-api/users rule. */
const SECOND_ADMIN_PASSWORD = "e2e-csrf-password-2026";

/** Teams the accepted mutations create: 201 the first time, 409 on a re-run against a reused server. */
const TEAM_OK = "e2e-csrf-team-ok";
const TEAM_SECOND = "e2e-csrf-team-second";
/** Never created by anything. Every refusal below asks for THIS name, so its absence proves the write was blocked. */
const TEAM_REFUSED = "e2e-csrf-never-created";

/** Cookie names for SESSION_COOKIE_SECURE=false (src/security/cookies.ts) — this stack's setting. */
const SESSION_COOKIE = "mcp_admin_session";
const CSRF_COOKIE = "mcp_admin_csrf";

/** Pulls `error.code` out of the admin API's standard envelope; undefined for a body that isn't that shape. */
function parseErrorCode(body: string): string | undefined {
  try {
    return (JSON.parse(body) as { error?: { code?: string } }).error?.code;
  } catch {
    return undefined;
  }
}

/**
 * Header bag for a session-authenticated call with EXPLICIT control over the
 * CSRF header — omitted entirely when `csrf` is undefined. `apiHeaders()` from
 * support/admin.ts is the correct-token counterpart.
 */
function sessionHeaders(auth: AdminAuth, csrf?: string): Record<string, string> {
  const headers: Record<string, string> = { cookie: auth.cookie, "content-type": "application/json" };
  if (csrf !== undefined) headers["x-csrf-token"] = csrf;
  return headers;
}

/** The mutation every assertion below drives, with fully explicit headers. */
function postTeam(request: APIRequestContext, headers: Record<string, string>, name: string): Promise<APIResponse> {
  return request.post(`${APP_BASE_URL}/admin-api/teams`, { headers, data: { name } });
}

/** GET the same path (a safe method), asserting it answered 200, and return the team names. */
async function listTeamNames(request: APIRequestContext, headers: Record<string, string>): Promise<string[]> {
  const res = await request.get(`${APP_BASE_URL}/admin-api/teams`, { headers });
  expect(res.status(), `GET /admin-api/teams failed: ${await res.text()}`).toBe(200);
  const body = (await res.json()) as { items: { name: string }[] };
  return body.items.map((t) => t.name);
}

/** Asserts the request was stopped by adminAuth's CSRF gate, and by nothing else. */
async function expectCsrfRefusal(res: APIResponse, what: string): Promise<void> {
  const body = await res.text();
  expect(res.status(), `${what} — expected the CSRF gate's 403, got ${res.status()}: ${body}`).toBe(403);
  expect(parseErrorCode(body), `${what} — 403, but not from the CSRF gate: ${body}`).toBe("CSRF_VALIDATION_FAILED");
}

/**
 * Asserts the request got PAST adminAuth and was answered by the route handler:
 * 201 the first time, 409 ALREADY_EXISTS on a re-run against a server the
 * previous run left behind (playwright.config.ts sets reuseExistingServer
 * outside CI). Both codes are written by the handler, i.e. after the gate.
 */
async function expectReachedHandler(res: APIResponse, what: string): Promise<void> {
  const body = await res.text();
  expect([201, 409], `${what} — expected the handler to answer, got ${res.status()}: ${body}`).toContain(res.status());
  if (res.status() === 409) {
    expect(parseErrorCode(body), `${what} — 409 from something other than the name conflict`).toBe("ALREADY_EXISTS");
  }
}

/**
 * A same-length, same-alphabet token differing from the real one by exactly one
 * character, so a refusal can't be explained away by a length or presence check.
 */
function oneCharOff(token: string): string {
  return `${token.startsWith("a") ? "b" : "a"}${token.slice(1)}`;
}

/**
 * Sign out through the sidebar's own button (TheSidebar.vue -> useAuth.logout()
 * -> POST /admin-api/auth/logout), then wait for the redirect to the login page.
 *
 * Deliberately NOT support/admin.ts's `logout()`: that helper navigates to
 * /admin/account and clicks `getByRole("button", { name: "Sign out" })` without
 * `exact`, and getByRole's name match is a case-insensitive SUBSTRING — on that
 * page it also matches the per-session "Sign out device" buttons the account
 * table renders, so once the sessions list has loaded the locator resolves to
 * 2+ elements and trips Playwright's strict mode. Scoping to #sidebar-nav with
 * exact:true has neither problem, and works from any authenticated page.
 */
async function signOutViaSidebar(page: Page): Promise<void> {
  await page.locator("#sidebar-nav").getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(page).toHaveURL(/\/admin\/login$/);
}

test.describe("Admin session auth — CSRF gate and session lifecycle", () => {
  // One long-lived bootstrap-admin session drives the single-session
  // assertions, so they don't each pay for a fresh argon2id login. It is never
  // signed out. The tests that need a second identity (or that destroy their
  // session) open their own context and close it in a finally.
  let sessionContext: BrowserContext;
  let sessionAuth: AdminAuth;

  test.beforeAll(async ({ browser }) => {
    // Provision the second account as the bootstrap super-admin, in a context
    // thrown away immediately — nothing below depends on its session.
    const bootstrap = await browser.newContext();
    try {
      const page = await bootstrap.newPage();
      const auth = await loginAs(page, BOOTSTRAP_ADMIN_USERNAME, BOOTSTRAP_ADMIN_PASSWORD);
      await createAdminUser(page.context().request, auth, {
        username: SECOND_ADMIN,
        password: SECOND_ADMIN_PASSWORD,
        role: "admin",
      });
    } finally {
      await bootstrap.close();
    }

    sessionContext = await browser.newContext();
    const page = await sessionContext.newPage();
    sessionAuth = await loginAs(page, BOOTSTRAP_ADMIN_USERNAME, BOOTSTRAP_ADMIN_PASSWORD);
  });

  test.afterAll(async () => {
    await sessionContext.close();
  });

  test("the session cookie is httpOnly, the CSRF cookie deliberately is not", async () => {
    const byName = new Map((await sessionContext.cookies()).map((c) => [c.name, c]));
    const present = [...byName.keys()].join(", ");

    const session = byName.get(SESSION_COOKIE);
    const csrf = byName.get(CSRF_COOKIE);
    if (!session || !csrf) throw new Error(`expected ${SESSION_COOKIE} + ${CSRF_COOKIE}, got: ${present}`);

    // The SPA reads the CSRF cookie from JS to echo it back as a header
    // (admin-ui/src/utils/cookies.ts), so it must NOT be httpOnly — while the
    // session token must never be reachable from script.
    expect(session.httpOnly, "the session cookie must be httpOnly").toBe(true);
    expect(csrf.httpOnly, "the CSRF cookie must be readable from JS").toBe(false);
    expect(session.sameSite, "the session cookie must be SameSite=Lax").toBe("Lax");

    // SESSION_COOKIE_SECURE=false here, so neither cookie is Secure — and
    // therefore neither may carry the __Host- prefix, which mandates Secure.
    expect(session.secure).toBe(false);
    expect(csrf.secure).toBe(false);
    expect(byName.has(`__Host-${SESSION_COOKIE}`), `unexpected __Host- cookie among: ${present}`).toBe(false);
    expect(byName.has(`__Host-${CSRF_COOKIE}`), `unexpected __Host- cookie among: ${present}`).toBe(false);
  });

  test("a session mutation with no X-CSRF-Token is refused", async ({ request }) => {
    const res = await postTeam(request, sessionHeaders(sessionAuth), TEAM_REFUSED);
    await expectCsrfRefusal(res, "POST /admin-api/teams with no X-CSRF-Token");

    // And the refusal has teeth: the write never reached the handler.
    expect(await listTeamNames(request, apiHeaders(sessionAuth))).not.toContain(TEAM_REFUSED);
  });

  test("a mismatched X-CSRF-Token is refused too, not just a missing one", async ({ request }) => {
    const good = sessionAuth.csrf;

    const oneOff = await postTeam(request, sessionHeaders(sessionAuth, oneCharOff(good)), TEAM_REFUSED);
    await expectCsrfRefusal(oneOff, "a token differing from the session's by one character");

    // Truncated: pins that the comparison is whole-value (safeCompare hashes
    // both sides), not a prefix or length check.
    const truncated = await postTeam(request, sessionHeaders(sessionAuth, good.slice(0, -1)), TEAM_REFUSED);
    await expectCsrfRefusal(truncated, "a token truncated by one character");

    expect(await listTeamNames(request, apiHeaders(sessionAuth))).not.toContain(TEAM_REFUSED);
  });

  test("the same mutation succeeds with the session's own token", async ({ request }) => {
    // Positive control: the two refusals above are about CSRF specifically, not
    // about this session, this endpoint or this payload being unusable.
    const res = await postTeam(request, apiHeaders(sessionAuth), TEAM_OK);
    await expectReachedHandler(res, "POST /admin-api/teams with the session's own token");
    expect(await listTeamNames(request, apiHeaders(sessionAuth))).toContain(TEAM_OK);
  });

  test("safe methods are exempt: the same URL answers a GET with no token", async ({ request }) => {
    const headers = sessionHeaders(sessionAuth); // session cookie, no X-CSRF-Token
    const get = await request.get(`${APP_BASE_URL}/admin-api/teams`, { headers });
    expect(get.status(), `a GET must not be gated on CSRF: ${await get.text()}`).toBe(200);

    // Same URL, same header bag — only the method differs, and now it's refused.
    const post = await postTeam(request, headers, TEAM_REFUSED);
    await expectCsrfRefusal(post, "POST on the very path whose GET just succeeded");
  });

  test("a bogus Bearer beats a valid session: Authorization is checked first", async ({ request }) => {
    // Cookie and CSRF token are both perfect here, so a 201/409 would mean the
    // session branch ran. It must not: adminAuth checks the Bearer FIRST and
    // unconditionally, and this key is not in ADMIN_API_KEYS (empty in this
    // stack), so the request dies as an invalid API key.
    //
    // The other half of the invariant — that a VALID static Bearer is exempt
    // from CSRF — is not testable here: playwright.config.ts sets
    // ADMIN_API_KEYS="", so no static key exists to authenticate with, and
    // inventing one would only test a config this stack doesn't run.
    const headers = apiHeaders(sessionAuth, { authorization: "Bearer e2e-csrf-not-a-configured-admin-key" });
    const res = await postTeam(request, headers, TEAM_REFUSED);
    const body = await res.text();
    expect(res.status(), `expected the Bearer branch to reject, got ${res.status()}: ${body}`).toBe(403);
    expect(parseErrorCode(body), `the session/CSRF branch must not have run: ${body}`).toBe("FORBIDDEN");

    // Only a "Bearer " prefix counts as an offered credential: any other scheme
    // leaves extractBearerToken() null, so the session branch runs normally and
    // its CSRF token is honoured. (auth.ts's own comment and CLAUDE.md both
    // phrase this as "no Authorization header at all" — the code is narrower.)
    const basicHeaders = apiHeaders(sessionAuth, { authorization: "Basic ZTJlOmNzcmY=" });
    await expectReachedHandler(await postTeam(request, basicHeaders, TEAM_OK), "a non-Bearer Authorization header");
  });

  test("a CSRF token from another session is refused, both directions", async ({ browser, request }) => {
    const contextA = await browser.newContext();
    const contextB = await browser.newContext();
    try {
      // Two different users, each in its own isolated browser context.
      const authA = await loginAs(await contextA.newPage(), BOOTSTRAP_ADMIN_USERNAME, BOOTSTRAP_ADMIN_PASSWORD);
      const authB = await loginAs(await contextB.newPage(), SECOND_ADMIN, SECOND_ADMIN_PASSWORD);
      expect(authA.csrf, "two sessions must not share a CSRF token").not.toBe(authB.csrf);

      // Both pairs are individually valid — so neither token is "a bad token".
      await expectReachedHandler(await postTeam(request, apiHeaders(authA), TEAM_OK), "user A with its own token");
      await expectReachedHandler(await postTeam(request, apiHeaders(authB), TEAM_SECOND), "user B with its own token");

      // Crossing them is refused both ways: a valid-looking token is not enough,
      // it has to be the token stored on THIS session's row.
      await expectCsrfRefusal(
        await postTeam(request, sessionHeaders(authA, authB.csrf), TEAM_REFUSED),
        "user A's cookie paired with user B's token",
      );
      await expectCsrfRefusal(
        await postTeam(request, sessionHeaders(authB, authA.csrf), TEAM_REFUSED),
        "user B's cookie paired with user A's token",
      );

      // Sharpest form of the same rule: `sessionAuth` and `authA` are two
      // sessions of the SAME user, so this refusal cannot be explained by the
      // identities differing — the token is bound to the session row itself.
      await expectCsrfRefusal(
        await postTeam(request, sessionHeaders(sessionAuth, authA.csrf), TEAM_REFUSED),
        "one session's cookie paired with another session of the same user",
      );

      expect(await listTeamNames(request, apiHeaders(authA))).not.toContain(TEAM_REFUSED);
    } finally {
      await contextA.close();
      await contextB.close();
    }
  });

  test("logging out revokes the session server-side, not just the cookie", async ({ browser, request }) => {
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      const auth = await loginAs(page, SECOND_ADMIN, SECOND_ADMIN_PASSWORD);

      // Positive control: the captured cookie authenticates right now (and does
      // so on a GET with no CSRF header, per the exemption above).
      const before = await request.get(`${APP_BASE_URL}/admin-api/auth/me`, { headers: sessionHeaders(auth) });
      expect(before.status(), `pre-logout /auth/me failed: ${await before.text()}`).toBe(200);
      const me = (await before.json()) as { auth_method?: string; user?: { username?: string } };
      expect(me.auth_method).toBe("session");
      expect(me.user?.username).toBe(SECOND_ADMIN);

      await signOutViaSidebar(page);

      // The cookie VALUE captured before the logout must no longer authenticate.
      // POST /admin-api/auth/logout stamps revoked_at on the row and
      // validateSession() refuses a revoked row — so a browser that kept the
      // cookie, or anyone who copied it, gains nothing. Landing on /admin/login
      // proves only that the SPA navigated; this is what proves the session died.
      const after = await request.get(`${APP_BASE_URL}/admin-api/auth/me`, { headers: sessionHeaders(auth) });
      const afterBody = await after.text();
      expect(after.status(), `the revoked session still authenticates: ${afterBody}`).toBe(401);
      expect(parseErrorCode(afterBody)).toBe("UNAUTHORIZED");

      // Same for a mutation carrying that session's still-valid-looking CSRF
      // token: session validation runs BEFORE the CSRF check, so this is a 401,
      // not a 403 — the session is gone, not merely unverified.
      const mutation = await postTeam(request, apiHeaders(auth), TEAM_REFUSED);
      const mutationBody = await mutation.text();
      expect(mutation.status(), `the revoked session still mutates: ${mutationBody}`).toBe(401);
      expect(parseErrorCode(mutationBody)).toBe("UNAUTHORIZED");
    } finally {
      await context.close();
    }
  });
});
