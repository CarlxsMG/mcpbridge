/**
 * End-to-end test for MCP SESSION ACCOUNTING on the Streamable HTTP transport
 * (src/mcp/transports.ts) — the `activeSessionCount` reservation that every new
 * session is checked against before `config.maxSessions` (100 by default;
 * playwright.config.ts sets no MAX_SESSIONS) lets it in.
 *
 * This one function has shipped two production bugs, which is why it earns a
 * spec of its own:
 *
 *   - A session-counter LEAK. A sessionless POST that was NOT a valid
 *     `initialize` took the `activeSessionCount++` reservation, was then
 *     answered by the SDK with a 400 *without throwing*, and never received a
 *     session id — so neither the map insert nor the `catch` rollback ran, and
 *     the slot was gone for good. After `maxSessions` such requests the gateway
 *     answered 503 to EVERY new session until restart: a global outage, in one
 *     loop, from anyone who could reach the data plane. The rollback that fixed
 *     it is the `else` branch at transports.ts:206-219.
 *   - A DOUBLE-DECREMENT. A single departure was counted twice (the transport's
 *     own `onclose` plus the explicit DELETE/TTL/shutdown path), drifting the
 *     counter *below* the true live count until the cap stopped rejecting
 *     anything. The fix is `releaseSession`'s `if (removed)` — decrement only
 *     when this call is the one that actually removed the map entry.
 *
 * What this proves that src/mcp/__tests__/transports.test.ts does not, given
 * that it already covers both bugs: those tests import `getActiveSessionCount()`
 * and read the counter directly, against an Express app they build themselves
 * with no auth, no rate limiter, no registry and no other traffic. This spec
 * has no such privilege — there is NO HTTP endpoint that exposes the live
 * session count (`getActiveSessionCount` is referenced only by a shutdown log
 * line in src/index.ts), so every assertion here is about OBSERVABLE BEHAVIOUR
 * through the real guard chain: whether a later `initialize` still gets a slot.
 * That is the only signal an operator has, and a counter the unit tests can see
 * being correct does not imply it: the reservation sits behind originValidator,
 * mcpAuth and rateLimitMcp, and a scope mounted so that one of those answers
 * before or after the reservation would move the counter without any unit test
 * noticing.
 *
 * ── BUDGET DISCIPLINE — READ BEFORE CHANGING ANY NUMBER IN THIS FILE ────────
 * `maxSessions` is 100 for the WHOLE PROCESS and all 20 spec files share it
 * (workers: 1, one backend). Sessions live for SESSION_TTL_MS (30 min) while
 * the suite finishes in about a minute, so nothing expires mid-run: every
 * session a spec opens and does not DELETE is still holding a slot when the
 * next spec starts. Measured, the other specs collectively hold ~40 of the 100
 * by the end of the run, so roughly 60 are free — and this file runs 14th of
 * 20, so a slot leaked here breaks six later specs with 503s that look nothing
 * like their own subject. Hence: every session opened below is tracked in
 * `liveSessions` the moment it exists and swept in `afterAll`, and the two
 * stress tests are sized to hold at most 20 slots at a time. This spec
 * deliberately never drives the process to capacity — asserting the documented
 * 503 {"code":-32000,"message":"Server at capacity, retry later"} would mean
 * parking every remaining slot on one assertion, and transports.test.ts already
 * pins that envelope with maxSessions forced to 0. Here a 503 is only ever the
 * FAILURE signal, quoted in the assertion messages so a regression reads
 * straight off the report.
 *
 * Nothing here may assume the counter starts at zero — it does not. Every
 * assertion is about a delta or about reclamation across rounds.
 */
import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { APP_BASE_URL } from "./support/env";
import { apiHeaders, loginAs, mintMcpKey, registerViaApi, type AdminAuth } from "./support/admin";
import { initMcpSession, mcpToolsCall } from "./support/mcp";

/** Two shards plus a bundle: three DISTINCT scopes, which the scoping test needs. */
const SERVER_A = "e2e-sessions-alpha-api";
const SERVER_B = "e2e-sessions-beta-api";
const BUNDLE_NAME = "e2e-sessions-bundle";

const SHARD_A = `/mcp/${SERVER_A}`;
const SHARD_B = `/mcp/${SERVER_B}`;
const BUNDLE_PLANE = `/mcp-custom/${BUNDLE_NAME}`;

/** What the bridge sees as this spec's client identity in `initialize`. */
const CLIENT_LABEL = "e2e-sessions";

/** Bearer for the data plane, minted in beforeAll. Every helper below reads it. */
let authHeader = "";

/**
 * Every session this file has opened and not yet released, mapped to the scope
 * path that owns it.
 *
 * The path is part of the record and not an afterthought: DELETE is
 * scope-checked (`handleStreamableDelete` compares `sessionScope` against the
 * URL before it looks the transport up), so a session can only be released
 * through the endpoint that created it. A sweep that guessed the path would
 * silently 404 and leak the slot anyway.
 *
 * Entries are added the instant the gateway hands back an id — before any
 * assertion runs — so a test that throws half way through a batch still leaves
 * every session it opened on the sweep list.
 */
const liveSessions = new Map<string, string>();

/** The JSON-RPC-ish error envelope both the gateway and the SDK answer with. */
interface JsonRpcErrorBody {
  jsonrpc?: string;
  /** Numeric for JSON-RPC errors (-32000), a string code for the gateway's own middleware errors. */
  error?: { code?: number | string; message?: string };
  id?: unknown;
}

/** A raw HTTP verdict — status, body and the session header, nothing interpreted. */
interface RawResponse {
  status: number;
  body: string;
  /** Set by the Streamable HTTP transport only on a successful initialize. */
  sessionId: string | null;
}

function parseJsonRpcError(bodyText: string): JsonRpcErrorBody {
  try {
    return JSON.parse(bodyText) as JsonRpcErrorBody;
  } catch {
    return {};
  }
}

/**
 * One POST to an MCP endpoint, reported raw.
 *
 * Hand-rolled rather than routed through `support/mcp.ts` because almost every
 * assertion in this file is on a REJECTION: `initMcpSession` throws on a
 * non-200 and `mcpCall` discards the body of one, and the body is exactly what
 * distinguishes the gateway's 404 from the SDK's.
 */
async function postJson(path: string, body: Record<string, unknown>, sessionId?: string): Promise<RawResponse> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    authorization: authHeader,
  };
  if (sessionId !== undefined) headers["mcp-session-id"] = sessionId;
  const res = await fetch(`${APP_BASE_URL}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
  // Read the header before draining the body — `res.text()` is a one-shot
  // stream reader (same ordering discipline as 00-auth-fail-closed.spec.ts).
  const headerSessionId = res.headers.get("mcp-session-id");
  return { status: res.status, body: await res.text(), sessionId: headerSessionId };
}

/** A well-formed `initialize`, as a fresh object per call. */
function initializeBody(): Record<string, unknown> {
  return {
    jsonrpc: "2.0",
    method: "initialize",
    id: 1,
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: CLIENT_LABEL, version: "1.0" },
    },
  };
}

/**
 * Open a session with the `initialize` POST alone, and track it.
 *
 * The `notifications/initialized` follow-up that `initMcpSession` sends is
 * deliberately skipped: the slot is reserved, the id assigned and the map entry
 * written entirely within the initialize request, and the transport's
 * `_initialized` flag is set there too — so the session is fully DELETE-able
 * without it. For the churn tests that halves the round trips, and none of them
 * ever call a tool. Where a session has to actually WORK, `openLiveSession`
 * below does the complete handshake instead.
 */
async function openSession(path: string): Promise<RawResponse> {
  const res = await postJson(path, initializeBody());
  if (res.sessionId !== null) liveSessions.set(res.sessionId, path);
  return res;
}

/** A fully handshaken session (initialize + notifications/initialized), tracked. */
async function openLiveSession(path: string): Promise<string> {
  const { sessionId } = await initMcpSession(path, { authHeader, clientName: CLIENT_LABEL });
  liveSessions.set(sessionId, path);
  return sessionId;
}

/** DELETE `sessionId` against `path`, whatever the tracker thinks. Used directly for the double-delete probe. */
async function rawDelete(path: string, sessionId: string): Promise<{ status: number; body: string }> {
  const res = await fetch(`${APP_BASE_URL}${path}`, {
    method: "DELETE",
    headers: { "mcp-session-id": sessionId, authorization: authHeader },
  });
  return { status: res.status, body: await res.text() };
}

/** DELETE a tracked session through the endpoint that owns it, and stop tracking it once it is provably gone. */
async function closeSession(sessionId: string): Promise<{ status: number; body: string }> {
  const path = liveSessions.get(sessionId);
  if (path === undefined) throw new Error(`closeSession: ${sessionId} is not tracked as live`);
  const res = await rawDelete(path, sessionId);
  // Untrack only on a verdict that means the slot is not held any more: 200 (we
  // released it) or 404 (it was already gone). Anything else — including a
  // thrown fetch, which never reaches this line — leaves it on the sweep list.
  if (res.status === 200 || res.status === 404) liveSessions.delete(sessionId);
  return res;
}

test.describe("MCP session accounting — the maxSessions reservation on Streamable HTTP", () => {
  let page: Page;
  let request: APIRequestContext;
  let auth: AdminAuth;

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage();
    request = page.context().request;
    auth = await loginAs(page);

    // Both shards are REAL registered clients. That is load-bearing for the
    // leak test, not scenery: `scopeNotFound` is checked BEFORE the
    // `activeSessionCount++` reservation, so a stray POST aimed at a client
    // that does not exist 404s without ever touching the counter — it would
    // exercise nothing at all.
    await registerViaApi(request, auth, SERVER_A);
    await registerViaApi(request, auth, SERVER_B);

    // The data plane is fail-closed as soon as any auth material exists, and by
    // the time this file runs (14th) another spec has certainly minted a key.
    // Mint our own so this spec never depends on which.
    const key = await mintMcpKey(request, auth, "e2e-sessions");
    authHeader = key.authHeader;

    // A real bundle, so the cross-scope test aims a client session at a scope
    // that genuinely exists and would have served a session of its own. 409 is
    // the local re-run meeting the database the previous run left behind; the
    // membership does not matter here, only that the scope resolves.
    const bundle = await request.post(`${APP_BASE_URL}/admin-api/bundles`, {
      headers: apiHeaders(auth),
      data: {
        name: BUNDLE_NAME,
        description: "e2e session-scope target",
        tools: [{ client: SERVER_A, tool: "list-users" }],
      },
    });
    expect([201, 409], `bundle create failed: ${bundle.status()} ${await bundle.text()}`).toContain(bundle.status());
  });

  test.afterAll(async () => {
    // THE most important eight lines in this file. Anything still held here is
    // charged to every spec that runs after this one, so the sweep tolerates
    // every individual failure and `page.close()` happens either way.
    try {
      const pending = [...liveSessions];
      liveSessions.clear();
      await Promise.all(pending.map(([sessionId, path]) => rawDelete(path, sessionId).catch(() => undefined)));
    } finally {
      await page.close();
    }
  });

  // ── (1) DELETE frees the slot, and is idempotent ──────────────────────────

  test("DELETE releases the session, and deleting the same id twice is a safe no-op", async () => {
    const opened = await openSession(SHARD_A);
    expect(opened.status, `initialize failed: ${opened.body}`).toBe(200);
    if (opened.sessionId === null) throw new Error("a 200 initialize carried no mcp-session-id header");
    const sessionId = opened.sessionId;

    const first = await closeSession(sessionId);
    expect(first.status, `first DELETE: ${first.body}`).toBe(200);

    // The map entry is gone — a POST on the id we just released is refused.
    // That entry is exactly what `releaseSession` keys its single decrement off
    // (`const removed = streamableSessions.delete(id); if (removed) …`), so its
    // absence is the closest thing to a direct observation of the decrement
    // that this process exposes.
    const replayed = await postJson(SHARD_A, { jsonrpc: "2.0", method: "tools/list", id: 2, params: {} }, sessionId);
    expect(replayed.status, `a deleted session was still usable: ${replayed.body}`).toBe(404);

    // The second DELETE. It never reaches `releaseSession` at all: the gateway's
    // own `streamableSessions.get()` misses first and answers 404, which is the
    // structural reason a repeat cannot over-credit the counter.
    const second = await rawDelete(SHARD_A, sessionId);
    expect(second.status).toBe(404);
    const envelope = parseJsonRpcError(second.body);
    expect(envelope.jsonrpc).toBe("2.0");
    expect(envelope.error?.code).toBe(-32000);
    // Note the wording: the DELETE/GET handlers say "Session not found", the
    // POST handler says "Session not found or expired". Two different literals
    // in transports.ts, pinned separately so a merge cannot quietly swap them.
    expect(envelope.error?.message).toBe("Session not found");
    expect(envelope.id).toBeNull();

    // ── What this test can and cannot see ────────────────────────────────────
    // CAN: that the release happened (the id stops working) and that a repeat
    // is refused before any accounting code runs.
    // CANNOT: the counter. An over-credit makes it too LOW, and a counter that
    // is too low has exactly one symptom — the cap admitting more sessions than
    // it should — which is only observable by driving the process to capacity.
    // This suite shares one 100-slot budget, so that is deliberately not done
    // here (see the file header). The opposite direction, an under-credit, IS
    // observable without any of that risk, and the reclamation test below is
    // what covers it.
  });

  // ── (2) A released id is indistinguishable from one that never existed ────

  test("an unknown session id — and a deleted one — are refused with the identical 404 envelope", async () => {
    // Well-formed UUID v4 (so it clears `isValidSessionId`) that no session has
    // ever had, versus an id that existed and was released. The two must be
    // byte-identical: a released session that answered differently would be an
    // existence oracle over other callers' session ids.
    const probe = { jsonrpc: "2.0", method: "tools/list", id: 77, params: {} };
    const neverExisted = "1b4e28ba-2fa1-4d1e-b13c-0000e2e50000";

    const unknown = await postJson(SHARD_A, probe, neverExisted);
    expect(unknown.status).toBe(404);
    const unknownEnvelope = parseJsonRpcError(unknown.body);
    expect(unknownEnvelope.jsonrpc).toBe("2.0");
    expect(unknownEnvelope.error?.code).toBe(-32000);
    expect(unknownEnvelope.error?.message).toBe("Session not found or expired");
    // The echoed request id is the discriminator that proves WHO answered. This
    // 404 is the gateway's own guard (`id: req.body?.id ?? null`); had the
    // request fallen through to a transport, the SDK's `validateSession` would
    // have answered -32001 "Session not found" with `id: null` instead.
    expect(unknownEnvelope.id).toBe(77);

    const opened = await openSession(SHARD_A);
    expect(opened.status, `initialize failed: ${opened.body}`).toBe(200);
    if (opened.sessionId === null) throw new Error("a 200 initialize carried no mcp-session-id header");
    const released = await closeSession(opened.sessionId);
    expect(released.status, `DELETE: ${released.body}`).toBe(200);

    const afterRelease = await postJson(SHARD_A, probe, opened.sessionId);
    expect(afterRelease.status).toBe(404);
    expect(afterRelease.body, "a released session id is distinguishable from an unknown one").toBe(unknown.body);

    // A malformed id is a different rejection entirely, and it matters here:
    // `isValidSessionId` runs at the very top of the POST handler, so this
    // request is turned away before the map lookup, before `scopeNotFound` and
    // before the reservation — garbage in the header can never cost a slot.
    const malformed = await postJson(SHARD_A, probe, "not-a-uuid-v4");
    expect(malformed.status).toBe(400);
    const malformedEnvelope = parseJsonRpcError(malformed.body);
    expect(malformedEnvelope.error?.code).toBe("INVALID_SESSION_ID");
    expect(malformedEnvelope.error?.message).toBe("Session ID must be a UUID v4");
    expect(malformed.sessionId, "a rejected request must not be handed a session").toBeNull();
  });

  // ── (3) Sessions are bound to the scope that created them ────────────────

  test("a shard session is refused on another shard and on a bundle, and a cross-scope DELETE cannot release it", async () => {
    // bundles.spec.ts already pins BUNDLE → shard. This covers the two
    // directions it does not (shard → shard, shard → bundle) and, more
    // importantly, the DELETE verb, which no spec pins at all: `sessionScope`
    // is checked independently in all three handlers, and a cross-scope DELETE
    // that slipped through would let any holder of a session id tear down a
    // session belonging to a shard it has no access to.
    const sessionId = await openLiveSession(SHARD_A);

    // Positive control. Without it, every 404 below would also pass against a
    // session that had simply died.
    const onOwnScope = await mcpToolsCall(SHARD_A, sessionId, `${SERVER_A}__list-users`, authHeader);
    expect(onOwnScope.status).toBe(200);
    expect(onOwnScope.isError, `own-scope call failed: ${onOwnScope.text}`).toBeFalsy();
    expect(onOwnScope.text).toContain("Ada Lovelace");

    const probe = { jsonrpc: "2.0", method: "tools/list", id: 91, params: {} };

    const onShardB = await postJson(SHARD_B, probe, sessionId);
    expect(onShardB.status, `a session leaked across shards: ${onShardB.body}`).toBe(404);
    const crossEnvelope = parseJsonRpcError(onShardB.body);
    expect(crossEnvelope.error?.code).toBe(-32000);
    expect(crossEnvelope.error?.message).toBe("Session not found or expired");
    expect(crossEnvelope.id).toBe(91);

    // Same id, a scope of a different KIND. Sessions are namespaced
    // `client:<name>` / `bundle:<name>`, so a client and a bundle that happened
    // to share a literal name still cannot be confused.
    const onBundle = await postJson(BUNDLE_PLANE, probe, sessionId);
    expect(onBundle.status, `a client session was accepted on a bundle: ${onBundle.body}`).toBe(404);
    expect(onBundle.body, "the refusal must not reveal which scope the id really belongs to").toBe(onShardB.body);

    const crossDelete = await rawDelete(SHARD_B, sessionId);
    expect(crossDelete.status).toBe(404);
    expect(parseJsonRpcError(crossDelete.body).error?.message).toBe("Session not found");

    // …and that refused DELETE did not release the slot behind our back. Two
    // independent witnesses: the session still dispatches on its own shard, and
    // the correctly-scoped DELETE below still finds it (it would answer 404,
    // not 200, if the cross-scope call had already freed it).
    const stillAlive = await mcpToolsCall(SHARD_A, sessionId, `${SERVER_A}__list-users`, authHeader);
    expect(stillAlive.status).toBe(200);
    expect(stillAlive.text, "a cross-scope DELETE tore down the session").toContain("Ada Lovelace");

    const released = await closeSession(sessionId);
    expect(released.status, `the owning scope could not release its own session: ${released.body}`).toBe(200);
  });

  // ── (4) THE LEAK PROOF: slots come back, round after round ────────────────

  test("slots are reclaimed across rounds — 160 sessions opened, never more than 20 held at once", async () => {
    // 8 rounds x 20 sessions, each round fully released before the next opens.
    //
    // Why those numbers prove reclamation with no counter to read:
    //
    //   DETECTION. `maxSessions` is 100. 160 total opens is 1.6x the ENTIRE
    //   cap, not 1.6x the free part of it — so the proof holds for any starting
    //   occupancy, including the ~40 slots the rest of the suite is already
    //   holding, and including 0. If a completed round failed to hand its slots
    //   back, the counter would climb monotonically and cross 100 partway
    //   through, and every subsequent `initialize` would answer 503 instead of
    //   200. At the measured ~60 free, rounds 1-3 would consume all of it and
    //   round 4 of the 8 would fail outright — a wide margin between "would be
    //   caught" and "ran out of rounds to catch it in".
    //
    //   SAFETY. Peak usage is 20 slots — a third of the ~60 free — held for the
    //   few milliseconds between a round's opens and its deletes. This test
    //   cannot itself be what pushes the process to capacity, which is the one
    //   outcome that would break the six spec files that run after this one.
    //
    // Raised above the 30s default because this is ~320 round trips; it
    // normally finishes in a couple of seconds.
    test.setTimeout(120_000);

    const SESSIONS_PER_ROUND = 20;
    const ROUNDS = 8;

    for (let round = 1; round <= ROUNDS; round++) {
      // Opened concurrently on purpose: the reservation is taken before any
      // await precisely so two requests cannot both read the same under-cap
      // count, and a serial loop would never exercise that.
      const opened = await Promise.all(Array.from({ length: SESSIONS_PER_ROUND }, () => openSession(SHARD_A)));

      const ids: string[] = [];
      for (const res of opened) {
        expect(
          res.status,
          `round ${round}: initialize answered ${res.status}. A 503 here is THE regression — ` +
            `"Server at capacity, retry later" means round ${round - 1}'s slots were never given back. ` +
            `Body: ${res.body}`,
        ).toBe(200);
        if (res.sessionId === null) throw new Error(`round ${round}: a 200 initialize carried no session header`);
        ids.push(res.sessionId);
      }

      // Distinct ids. A transport handing the same id to two callers would make
      // the counter and the session map disagree about how many are live, which
      // is the same class of drift as the double-decrement.
      expect(new Set(ids).size, `round ${round}: duplicate session ids issued`).toBe(SESSIONS_PER_ROUND);

      const closed = await Promise.all(ids.map((id) => closeSession(id)));
      for (const res of closed) {
        expect(res.status, `round ${round}: DELETE answered ${res.status}: ${res.body}`).toBe(200);
      }
    }

    // Belt and braces for the spec files that follow: the tracker agrees that
    // this test gave every slot back.
    expect(liveSessions.size, "the churn left sessions behind").toBe(0);
  });

  // ── (5) THE P0: a sessionless non-initialize POST must not cost a slot ────

  test("120 sessionless non-initialize POSTs leak no slots — a fresh initialize still succeeds", async () => {
    test.setTimeout(120_000);

    // 120 > maxSessions (100) >= any free budget this file could have inherited.
    // Pre-fix each of these leaked exactly one slot, so the counter would be
    // pinned at the cap long before the 120th and the initialize at the end
    // could not possibly get through. Post-fix the rollback at
    // transports.ts:217 gives every one of them back.
    //
    // The honest limit of this measurement: it detects a leak RATE of about one
    // per stray request, which is exactly the bug that shipped. A leak on, say,
    // one request in fifty would need far more traffic than a shared 100-slot
    // budget can supply, and this test would pass with it present.
    const STRAY_POSTS = 120;
    const BATCH = 20;

    const statuses = new Set<number>();
    let firstBody: string | null = null;
    let sawSessionHeader = false;

    for (let sent = 0; sent < STRAY_POSTS; sent += BATCH) {
      const size = Math.min(BATCH, STRAY_POSTS - sent);
      const batch = await Promise.all(
        // Well-formed JSON-RPC, a real method, no `mcp-session-id` header — a
        // client that lost its session and just kept talking. The gateway takes
        // it for a new session (no header), reserves a slot, builds a transport
        // and hands the body to the SDK, which answers without throwing.
        Array.from({ length: size }, () =>
          postJson(SHARD_A, { jsonrpc: "2.0", method: "tools/list", id: 1, params: {} }),
        ),
      );
      for (const res of batch) {
        statuses.add(res.status);
        if (res.sessionId !== null) sawSessionHeader = true;
        if (firstBody === null) firstBody = res.body;
      }
    }

    // Every one of them, identically. A 503 appearing partway through would
    // itself be the leak becoming visible mid-test.
    expect([...statuses], `stray-POST statuses seen: ${[...statuses].join(", ")}`).toEqual([400]);

    // No session id was ever assigned — which is precisely the condition
    // (`if (transport.sessionId) … else` rollback) the fix hangs on. If this
    // were ever true, the request would have taken the map-insert branch and
    // the rest of the test would be measuring something else.
    expect(sawSessionHeader, "a stray POST was handed an mcp-session-id").toBe(false);

    const envelope = parseJsonRpcError(firstBody ?? "");
    expect(envelope.jsonrpc).toBe("2.0");
    expect(envelope.error?.code).toBe(-32000);
    // The SDK's own wording, from `validateSession` on a brand-new transport
    // whose `_initialized` is still false — not the gateway's. `id` is null
    // even though we sent 1, because the SDK's error envelope always is; that
    // is what identifies the answer as the SDK's rather than the gateway's.
    expect(envelope.error?.message).toBe("Bad Request: Server not initialized");
    expect(envelope.id).toBeNull();

    // The whole point. One success is logically sufficient — a 120-slot leak
    // puts the counter over the cap no matter where it started — but five make
    // the signal unambiguous in the report.
    const fresh = await Promise.all(Array.from({ length: 5 }, () => openSession(SHARD_A)));
    const ids: string[] = [];
    for (const res of fresh) {
      expect(
        res.status,
        `initialize answered ${res.status} after ${STRAY_POSTS} stray POSTs. A 503 ` +
          `("Server at capacity, retry later") is the leak: each stray request kept the slot it reserved. ` +
          `Body: ${res.body}`,
      ).toBe(200);
      if (res.sessionId === null) throw new Error("a 200 initialize carried no session header");
      ids.push(res.sessionId);
    }

    const closed = await Promise.all(ids.map((id) => closeSession(id)));
    for (const res of closed) expect(res.status, `DELETE answered ${res.status}: ${res.body}`).toBe(200);
    expect(liveSessions.size, "the leak test left sessions behind").toBe(0);
  });
});
