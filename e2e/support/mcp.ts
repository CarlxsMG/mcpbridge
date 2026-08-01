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
