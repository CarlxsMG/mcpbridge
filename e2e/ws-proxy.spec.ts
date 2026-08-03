/**
 * End-to-end coverage for the WebSocket proxy (`/ws-proxy/:name`).
 *
 * This is the one surface in the codebase that upgrades a connection, and it
 * had no e2e coverage at all — despite carrying a fix for a P1 DNS-rebinding
 * hole. That fix is the reason this spec exists:
 *
 *   `pinnedWsDial` (src/net/ip-validator.ts) dials the SSRF-validated IP
 *   LITERAL while carrying the original hostname in the `Host` header, closing
 *   the TOCTOU window between validation and dial. It replaced a
 *   `dns.lookup`-override approach that Bun's `ws` shim silently ignores — i.e.
 *   the previous pin was a no-op that provided NO protection while looking
 *   like it did. A unit test can assert what the function returns; only an
 *   end-to-end dial can assert what the upstream actually RECEIVED.
 *
 * The fixture upstream records every upgrade's `Host` header, so a regression
 * that "simplified" the dial back to the bare IP is visible here as
 * `127.0.0.1:<port>` where `localhost:<port>` is expected. Nothing else
 * observable from outside distinguishes a pinned dial from an unpinned one,
 * which is precisely why the original hole survived review.
 *
 * The target is therefore registered by HOSTNAME on purpose: `pinnedWsDial`
 * returns a raw-IP URL unchanged, so pointing it at `127.0.0.1` would skip the
 * rewrite entirely and the headline assertion would pass vacuously.
 *
 * Everything else here pins the upgrade gate chain in `handleWsProxyUpgrade`,
 * which runs in a fixed order: unknown/disabled target -> auth -> key scope ->
 * origin -> global cap -> per-target cap -> breaker.
 *
 * TWO CONTRACTS THAT LOOK LIKE BUGS AND ARE NOT. Both were assumed wrong when
 * this spec was first written, and both are deliberate:
 *
 *  1. **A refused upgrade is not distinguishable by status.** `rejectUpgrade`
 *     does write a real `HTTP/1.1 <status>` response, but under Bun an
 *     http.Server "upgrade" socket never delivers bytes written to it — proven
 *     in src/__tests__/ws-proxy-mutation.test.ts with three independent raw
 *     clients (node:net, Bun.connect, and curl, which reports "Empty reply from
 *     server"). It is a Bun http-compat limitation, not a ws-proxy defect, and
 *     `socket.end()` does not help either. The client therefore observes a
 *     connection reset, so these tests assert THAT THE DIAL WAS REFUSED and
 *     isolate one gate at a time — asserting a 404 vs a 403 here is impossible,
 *     not merely awkward.
 *  2. **An upstream close reaches the client as 1006, not the upstream's code.**
 *     `backendWs.on("close")` routes through `safeClose`, which uses
 *     `terminate()` on purpose: `close()` would block for `ws`'s 30s
 *     closeTimeout waiting on an uncooperative peer, and `terminate()` cannot
 *     carry a code or reason. The contract is "the client side is torn down
 *     promptly", not "the close code survives the relay".
 */
import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import WebSocket from "ws";
import { APP_BASE_URL, FIXTURE_PORT, FIXTURE_WS_HOSTNAME, FIXTURE_WS_URL } from "./support/env";
import {
  type AdminAuth,
  adminAuthHeaders,
  deleteWsProxyTarget,
  fixtureState,
  login,
  mintMcpKey,
  patchWsProxyTarget,
  resetFixtureWsHandshakes,
  upsertWsProxyTarget,
} from "./support/admin";

const TARGET = "e2e-ws-target";
/** A second registered target, used only as the "not in this key's scope" subject. */
const OTHER_TARGET = "e2e-ws-other";

/** The bridge's WS endpoint for a target. */
const wsEndpoint = (name: string): string => `${APP_BASE_URL.replace("http://", "ws://")}/ws-proxy/${name}`;

interface DialResult {
  /** Set when the upgrade succeeded. Caller owns closing it. */
  socket?: WebSocket;
  /** True when the upgrade never completed — the gate chain refused it. */
  refused?: boolean;
  /** What the client actually observed, for diagnosing an unexpected mode. */
  detail?: string;
}

/**
 * Dial the bridge and resolve with either an open socket or a refusal.
 *
 * `unexpected-response` is still handled — it is what a runtime that DID
 * deliver the rejection bytes would emit, and handling it means this helper
 * keeps working (and starts reporting a status in `detail`) if the Bun
 * limitation described in the file header is ever lifted. Today the refusal
 * arrives as an `error` instead, so both paths fold into `refused: true`.
 */
async function dial(name: string, authHeader?: string, extraHeaders: Record<string, string> = {}): Promise<DialResult> {
  const headers: Record<string, string> = { ...extraHeaders };
  if (authHeader) headers.authorization = authHeader;

  return new Promise<DialResult>((resolve) => {
    const socket = new WebSocket(wsEndpoint(name), { headers });
    const settle = (result: DialResult): void => {
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      socket.terminate();
      settle({ refused: true, detail: "dial timed out" });
    }, 10_000);

    socket.on("open", () => settle({ socket }));
    socket.on("unexpected-response", (_req, res) => {
      socket.terminate();
      settle({ refused: true, detail: `http ${res.statusCode}` });
    });
    socket.on("error", (err: Error) => settle({ refused: true, detail: err.message }));
  });
}

/** Resolve with the next text frame the socket receives. */
async function nextMessage(socket: WebSocket, timeoutMs = 10_000): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out waiting for a message")), timeoutMs);
    socket.once("message", (data: Buffer | string) => {
      clearTimeout(timer);
      resolve(typeof data === "string" ? data : data.toString("utf-8"));
    });
  });
}

/** Resolve with the close code the socket reports. */
async function nextClose(socket: WebSocket, timeoutMs = 10_000): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out waiting for close")), timeoutMs);
    socket.once("close", (code: number) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

/** Open a connection, run `body`, and always close the socket. */
async function withSocket(name: string, authHeader: string, body: (socket: WebSocket) => Promise<void>): Promise<void> {
  const dialed = await dial(name, authHeader);
  expect(dialed.socket, `dial refused: ${dialed.detail}`).toBeDefined();
  const socket = dialed.socket as WebSocket;
  try {
    // The upstream greets every accepted connection, so consuming it here keeps
    // each test's own assertions about frames unambiguous.
    expect(await nextMessage(socket)).toBe("ready");
    await body(socket);
  } finally {
    socket.close();
  }
}

test.describe("WebSocket proxy — /ws-proxy/:name", () => {
  let page: Page;
  let request: APIRequestContext;
  let auth: AdminAuth;
  let authHeader: string;
  let scopedHeader: string;

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage();
    request = page.context().request;
    await login(page);
    auth = await adminAuthHeaders(page);

    // Registered by hostname — see the file header on why an IP would make the
    // pinning assertion vacuous.
    const created = await upsertWsProxyTarget(request, auth, TARGET, {
      backendWsUrl: FIXTURE_WS_URL,
      maxConnections: 2,
    });
    expect([200, 201], `ws-proxy target create failed: ${created.status} ${created.body}`).toContain(created.status);

    const other = await upsertWsProxyTarget(request, auth, OTHER_TARGET, { backendWsUrl: FIXTURE_WS_URL });
    expect([200, 201], `second target create failed: ${other.status} ${other.body}`).toContain(other.status);

    // The upgrade path runs the data plane's own `evaluateMcpAuth`, so it is
    // fail-closed by the time this spec runs (earlier specs have minted keys).
    authHeader = (await mintMcpKey(request, auth, "e2e-ws-proxy")).authHeader;
    // A key confined to the OTHER target, for the scope refusal below.
    scopedHeader = (await mintMcpKey(request, auth, "e2e-ws-proxy-scoped", { scopes: { clients: [OTHER_TARGET] } }))
      .authHeader;
  });

  test.afterAll(async () => {
    // Leave no target behind: a stale one would keep the revalidation loop
    // probing a fixture that is about to disappear.
    await deleteWsProxyTarget(request, auth, TARGET);
    await deleteWsProxyTarget(request, auth, OTHER_TARGET);
    await page.close();
  });

  test("a proxied connection relays frames in both directions", async () => {
    await withSocket(TARGET, authHeader, async (socket) => {
      socket.send("hello");
      expect(await nextMessage(socket)).toBe("echo:hello");
      // A second round trip on the SAME socket — proves the relay persists
      // rather than servicing one frame and detaching.
      socket.send("again");
      expect(await nextMessage(socket)).toBe("echo:again");
    });
  });

  test("the upstream receives the ORIGINAL hostname in Host, not the pinned IP", async () => {
    await resetFixtureWsHandshakes(request);
    await withSocket(TARGET, authHeader, async (socket) => {
      socket.send("ping");
      expect(await nextMessage(socket)).toBe("echo:ping");
    });

    const { wsHandshakes } = await fixtureState(request);
    expect(wsHandshakes.length, "the upstream recorded no upgrade").toBe(1);
    // THE regression guard. `pinnedWsDial` connects to the validated IP literal
    // but must present the hostname, so the upstream still sees (and a TLS peer
    // would still validate against) its own name. A dial that dropped the Host
    // override would report `127.0.0.1:<port>` here.
    expect(wsHandshakes[0].host).toBe(`${FIXTURE_WS_HOSTNAME}:${FIXTURE_PORT}`);
    expect(wsHandshakes[0].host).not.toContain("127.0.0.1");
  });

  test("the caller's Authorization is NOT forwarded to the upstream", async () => {
    await resetFixtureWsHandshakes(request);
    await withSocket(TARGET, authHeader, async (socket) => {
      socket.send("ping");
      expect(await nextMessage(socket)).toBe("echo:ping");
    });

    const { wsHandshakes } = await fixtureState(request);
    expect(wsHandshakes.length).toBe(1);
    // The gateway's managed key authenticates the CLIENT to the bridge; it is
    // not a credential the backend should ever see. Leaking it upstream would
    // hand a backend a working key for this gateway.
    expect(wsHandshakes[0].authorization).toBeNull();
  });

  test("an upstream-initiated close tears down the client side", async () => {
    const dialed = await dial(TARGET, authHeader);
    expect(dialed.socket, `dial refused: ${dialed.detail}`).toBeDefined();
    const socket = dialed.socket as WebSocket;
    try {
      expect(await nextMessage(socket)).toBe("ready");
      const closed = nextClose(socket);
      // The fixture closes its side on this. What matters is that the client
      // side goes away too — a relay that dropped only the backend leg would
      // strand this socket open forever. The CODE is deliberately not asserted:
      // safeClose uses terminate(), which cannot transmit one, so 1006 here is
      // the contract rather than a lost frame (see the file header).
      socket.send("__close__");
      await closed;
      expect(socket.readyState).toBe(WebSocket.CLOSED);
    } finally {
      socket.terminate();
    }
  });

  // ── The upgrade gate chain ─────────────────────────────────────────────────
  // Each test isolates ONE gate with every earlier gate satisfied, because the
  // refusal itself carries no distinguishing status under this runtime (file
  // header, point 1). Isolation is what makes "refused" attributable.

  test("an unknown target name is refused", async () => {
    const dialed = await dial("e2e-ws-does-not-exist", authHeader);
    expect(dialed.socket, "an unknown target must not upgrade").toBeUndefined();
    expect(dialed.refused).toBe(true);
  });

  test("a DISABLED target is refused — a registered name alone is not enough", async () => {
    // Positive control: the same name, same key, upgrades fine while enabled.
    // Without it, "refused" here would be indistinguishable from a broken dial.
    const before = await dial(TARGET, authHeader);
    expect(before.socket, `control dial refused while enabled: ${before.detail}`).toBeDefined();
    before.socket?.terminate();

    const patched = await patchWsProxyTarget(request, auth, TARGET, { enabled: false });
    expect(patched.status, `disable failed: ${patched.body}`).toBe(200);
    try {
      const dialed = await dial(TARGET, authHeader);
      expect(dialed.socket, "a disabled target must not upgrade").toBeUndefined();
      expect(dialed.refused).toBe(true);
    } finally {
      const restored = await patchWsProxyTarget(request, auth, TARGET, { enabled: true });
      expect(restored.status, `re-enable failed: ${restored.body}`).toBe(200);
    }
  });

  test("no Authorization is refused before the upgrade completes", async () => {
    const dialed = await dial(TARGET);
    expect(dialed.socket, "an unauthenticated dial must not upgrade").toBeUndefined();
    expect(dialed.refused).toBe(true);
  });

  test("a bogus Bearer is refused", async () => {
    const dialed = await dial(TARGET, "Bearer mcp_definitely-not-a-real-key");
    expect(dialed.socket, "a bogus key must not upgrade").toBeUndefined();
    expect(dialed.refused).toBe(true);
  });

  test("a key scoped to another target is refused on this one", async () => {
    // Positive control first: the same key DOES work on the target it is scoped
    // to, so the refusal below is the scope check and not a broken key.
    const allowed = await dial(OTHER_TARGET, scopedHeader);
    expect(allowed.socket, `scoped key rejected on its own target: ${allowed.detail}`).toBeDefined();
    allowed.socket?.terminate();

    const refused = await dial(TARGET, scopedHeader);
    expect(refused.socket, "an out-of-scope target must not upgrade").toBeUndefined();
    expect(refused.refused).toBe(true);
  });

  test("per-target maxConnections refuses the connection beyond the cap", async () => {
    // The target was registered with maxConnections: 2.
    const first = await dial(TARGET, authHeader);
    const second = await dial(TARGET, authHeader);
    try {
      expect(first.socket, `first dial refused: ${first.detail}`).toBeDefined();
      expect(second.socket, `second dial refused: ${second.detail}`).toBeDefined();

      const third = await dial(TARGET, authHeader);
      expect(third.socket, "the third dial must be refused at the cap").toBeUndefined();
      expect(third.refused).toBe(true);
    } finally {
      first.socket?.terminate();
      second.socket?.terminate();
    }
  });

  test("freeing a slot lets a new connection in again — the cap is live, not sticky", async () => {
    const first = await dial(TARGET, authHeader);
    const second = await dial(TARGET, authHeader);
    expect(first.socket).toBeDefined();
    expect(second.socket).toBeDefined();

    // Drop one and wait for the bridge to observe the close, then re-dial.
    second.socket?.close();
    await expect
      .poll(
        async () => {
          const retry = await dial(TARGET, authHeader);
          if (retry.socket) {
            retry.socket.terminate();
            return "accepted";
          }
          return `refused:${retry.detail}`;
        },
        { message: "a freed connection slot should be reusable", timeout: 10_000 },
      )
      .toBe("accepted");

    first.socket?.terminate();
  });

  // ── Registration validation ────────────────────────────────────────────────

  test("a target URL that is not ws:// or wss:// is refused at registration", async () => {
    const res = await upsertWsProxyTarget(request, auth, "e2e-ws-bad-scheme", {
      backendWsUrl: `http://${FIXTURE_WS_HOSTNAME}:${FIXTURE_PORT}/ws`,
    });
    expect(res.status, `expected a validation refusal, got: ${res.body}`).toBe(400);
    expect(res.body).toContain("INVALID_URL");
  });
});
