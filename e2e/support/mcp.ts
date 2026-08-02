/**
 * Raw MCP data-plane client used by the e2e specs.
 *
 * Deliberately hand-rolled `fetch` rather than the MCP SDK client: these specs
 * assert on the wire contract (status codes, the `mcp-session-id` header, SSE
 * framing), which an SDK client would abstract away.
 *
 * `parseSseJson` was byte-identical in two specs; the initialize handshake and
 * the tools/call round trip were near-identical in three, differing only in
 * what each returned and in the `clientInfo.name` they announce. That name is
 * observable server-side, so it stays a per-spec argument rather than being
 * flattened to one shared value.
 */
import { APP_BASE_URL } from "./env";

/** Result of a data-plane call that returned a JSON-RPC envelope. */
export interface McpCallResult {
  status: number;
  isError?: boolean;
  text?: string;
}

/** What `initMcpSession` learned from the initialize response. */
export interface McpInit {
  sessionId: string;
  serverInfo: { name?: string; version?: string };
}

/** Pull the JSON payload out of an SSE `data:` frame. */
export function parseSseJson(text: string): { result?: unknown; error?: unknown; id?: unknown } {
  const match = text.match(/data: (.+)/);
  if (!match) throw new Error(`Could not parse SSE body: ${text}`);
  return JSON.parse(match[1]);
}

function jsonHeaders(sessionId?: string, authHeader?: string): Record<string, string> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  };
  if (sessionId) headers["mcp-session-id"] = sessionId;
  if (authHeader) headers.authorization = authHeader;
  return headers;
}

/**
 * Perform the real initialize handshake against `path`, then send the
 * `notifications/initialized` follow-up the protocol requires.
 *
 * `authHeader` is optional so a spec can exercise the unauthenticated case;
 * `clientName` is what the bridge sees as the calling client's identity.
 */
export async function initMcpSession(
  path: string,
  { authHeader, clientName }: { authHeader?: string; clientName: string },
): Promise<McpInit> {
  const initRes = await fetch(`${APP_BASE_URL}${path}`, {
    method: "POST",
    headers: jsonHeaders(undefined, authHeader),
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "initialize",
      id: 1,
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: clientName, version: "1.0" },
      },
    }),
  });
  const sessionId = initRes.headers.get("mcp-session-id");
  if (initRes.status !== 200 || !sessionId) {
    throw new Error(`initialize failed: status=${initRes.status} body=${await initRes.text()}`);
  }
  const parsed = parseSseJson(await initRes.text());
  const result = parsed.result as { serverInfo?: { name?: string; version?: string } } | undefined;

  await fetch(`${APP_BASE_URL}${path}`, {
    method: "POST",
    headers: jsonHeaders(sessionId, authHeader),
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
  });

  // Register for teardown. Tracking here rather than at each call site is what
  // makes cleanup a single `afterAll` line per spec instead of an id threaded
  // through every helper — see closeTrackedMcpSessions.
  openSessions.push({ path, sessionId, authHeader });

  return { sessionId, serverInfo: result?.serverInfo ?? {} };
}

/**
 * Send an arbitrary JSON-RPC body on an established session. A non-200 comes
 * back as just the status — the caller is asserting on the transport, and
 * there is no JSON-RPC envelope to unwrap.
 */
export async function mcpCall(
  path: string,
  sessionId: string,
  body: Record<string, unknown>,
  authHeader: string,
): Promise<McpCallResult> {
  const res = await fetch(`${APP_BASE_URL}${path}`, {
    method: "POST",
    headers: jsonHeaders(sessionId, authHeader),
    body: JSON.stringify(body),
  });
  if (res.status !== 200) return { status: res.status };
  const parsed = parseSseJson(await res.text());
  const result = parsed.result as { isError?: boolean; content?: { type: string; text: string }[] } | undefined;
  return {
    status: res.status,
    isError: result?.isError,
    text: result?.content?.map((c) => c.text).join("\n"),
  };
}

/** `mcpCall` specialised to a tools/call request. */
export async function mcpToolsCall(
  path: string,
  sessionId: string,
  toolName: string,
  authHeader: string,
  args: Record<string, unknown> = {},
): Promise<McpCallResult> {
  return mcpCall(
    path,
    sessionId,
    { jsonrpc: "2.0", method: "tools/call", id: 2, params: { name: toolName, arguments: args } },
    authHeader,
  );
}

// ── Session cleanup ─────────────────────────────────────────────────────────

/**
 * Every session `initMcpSession` has opened and not yet released.
 *
 * Module scope, which with `workers: 1` means one registry shared by the whole
 * run — deliberately. Playwright executes spec FILES sequentially, so by the
 * time any file's `afterAll` runs, its own tests are done; anything still in
 * here belongs either to that file or to an earlier one that failed to clean
 * up, and both should be released. Closing is idempotent server-side
 * (`releaseSession`), so a double release cannot over-credit the counter.
 */
const openSessions: { path: string; sessionId: string; authHeader?: string }[] = [];

/**
 * Release one session. Best-effort by design: a spec may have already closed
 * it, the TTL sweep may have reaped it, or the client may have been deleted out
 * from under it — none of which is a test failure, and all of which answer 404.
 */
export async function closeMcpSession(path: string, sessionId: string, authHeader?: string): Promise<void> {
  const headers: Record<string, string> = { "mcp-session-id": sessionId };
  if (authHeader) headers.authorization = authHeader;
  try {
    await fetch(`${APP_BASE_URL}${path}`, { method: "DELETE", headers });
  } catch {
    // Network-level failure during teardown is not worth failing a suite over.
  }
}

/**
 * Release every session opened through `initMcpSession` so far.
 *
 * Call from a spec's `afterAll`. This matters more than it looks: the gateway
 * caps concurrent sessions at `config.maxSessions` (100) for the whole process,
 * and the suite shares ONE backend across every spec file. Sessions live for a
 * 30-minute TTL while the suite finishes in about a minute, so nothing expires
 * mid-run and a spec that leaks simply subtracts from every later spec's
 * headroom. Measured before this existed: the suite ended with 41 of the 100
 * slots still held, and a spec that exhausted the rest would have made every
 * subsequent `initialize` fail with a 503 that looked nothing like its cause.
 */
export async function closeTrackedMcpSessions(): Promise<void> {
  const pending = openSessions.splice(0, openSessions.length);
  await Promise.all(pending.map((s) => closeMcpSession(s.path, s.sessionId, s.authHeader)));
}
