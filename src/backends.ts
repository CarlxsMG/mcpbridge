/**
 * Extra backend protocols exposed as per-tool config on an existing REST client
 * (no new registry `kind` needed):
 *   - GraphQL: a tool wraps its args as `{ query, variables }` and POSTs them to
 *     the client's base URL (handled inline in proxy.ts's REST body building).
 *   - WebSocket: a tool opens an ephemeral WS per call, sends its args as JSON,
 *     and returns the first message (request/response over WS).
 *
 * Both reuse the same guard/breaker/usage stack as REST — only the wire format
 * differs. The WS URL is SSRF-validated at config time (via its http-equivalent).
 */
import { getDb } from "./db/connection.js";
import { config } from "./config.js";
import { validateBackendUrl } from "./security/ip-validator.js";

// ── GraphQL ─────────────────────────────────────────────────────────────────

export interface GraphqlConfig {
  enabled: boolean;
  query: string;
}

export function getToolGraphql(clientName: string, toolName: string): GraphqlConfig | null {
  const row = getDb().query(`SELECT query, enabled FROM tool_graphql WHERE client_name = ? AND tool_name = ?`).get(clientName, toolName) as { query: string; enabled: number } | null;
  return row ? { enabled: row.enabled === 1, query: row.query } : null;
}

/** GraphQL config for every tool of a client, keyed by tool name (batched for detail views, mirrors getWsForClient). */
export function getGraphqlForClient(clientName: string): Record<string, GraphqlConfig> {
  const rows = getDb()
    .query(`SELECT tool_name, query, enabled FROM tool_graphql WHERE client_name = ?`)
    .all(clientName) as { tool_name: string; query: string; enabled: number }[];
  const out: Record<string, GraphqlConfig> = {};
  for (const r of rows) out[r.tool_name] = { enabled: r.enabled === 1, query: r.query };
  return out;
}

export function setToolGraphql(clientName: string, toolName: string, input: { enabled: boolean; query: string } | null): boolean {
  const db = getDb();
  if (!db.query(`SELECT 1 FROM tools WHERE client_name = ? AND name = ?`).get(clientName, toolName)) return false;
  if (input === null) {
    db.query(`DELETE FROM tool_graphql WHERE client_name = ? AND tool_name = ?`).run(clientName, toolName);
    return true;
  }
  db.query(
    `INSERT INTO tool_graphql (client_name, tool_name, query, enabled, updated_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(client_name, tool_name) DO UPDATE SET query = excluded.query, enabled = excluded.enabled, updated_at = excluded.updated_at`,
  ).run(clientName, toolName, input.query, input.enabled ? 1 : 0, Date.now());
  return true;
}

// ── WebSocket ───────────────────────────────────────────────────────────────

export interface WsConfig {
  enabled: boolean;
  wsUrl: string;
  resolvedIp: string;
  /** When true, the connection stays open across multiple messages instead of closing after the first (see wsRequestPersistent). */
  persistent: boolean;
}

export function getToolWs(clientName: string, toolName: string): WsConfig | null {
  const row = getDb().query(`SELECT ws_url, resolved_ip, enabled, persistent FROM tool_ws WHERE client_name = ? AND tool_name = ?`).get(clientName, toolName) as { ws_url: string; resolved_ip: string; enabled: number; persistent: number } | null;
  return row ? { enabled: row.enabled === 1, wsUrl: row.ws_url, resolvedIp: row.resolved_ip, persistent: row.persistent === 1 } : null;
}

/** WS config for every tool of a client, keyed by tool name (batched for detail views). */
export function getWsForClient(clientName: string): Record<string, WsConfig> {
  const rows = getDb()
    .query(`SELECT tool_name, ws_url, resolved_ip, enabled, persistent FROM tool_ws WHERE client_name = ?`)
    .all(clientName) as { tool_name: string; ws_url: string; resolved_ip: string; enabled: number; persistent: number }[];
  const out: Record<string, WsConfig> = {};
  for (const r of rows) out[r.tool_name] = { enabled: r.enabled === 1, wsUrl: r.ws_url, resolvedIp: r.resolved_ip, persistent: r.persistent === 1 };
  return out;
}

export type WsError = "TOOL_NOT_FOUND" | "INVALID_URL";

export async function setToolWs(
  clientName: string,
  toolName: string,
  input: { enabled: boolean; wsUrl: string; persistent?: boolean } | null,
): Promise<{ ok: true } | { ok: false; error: WsError; reason?: string }> {
  const db = getDb();
  if (!db.query(`SELECT 1 FROM tools WHERE client_name = ? AND name = ?`).get(clientName, toolName)) return { ok: false, error: "TOOL_NOT_FOUND" };
  if (input === null) {
    db.query(`DELETE FROM tool_ws WHERE client_name = ? AND tool_name = ?`).run(clientName, toolName);
    return { ok: true };
  }
  if (!/^wss?:\/\//.test(input.wsUrl)) return { ok: false, error: "INVALID_URL", reason: "must be ws:// or wss://" };
  // SSRF-validate the http-equivalent (validateBackendUrl speaks http/https).
  const httpEquivalent = input.wsUrl.replace(/^ws/, "http");
  const check = await validateBackendUrl(httpEquivalent, config.allowPrivateIps, config.allowedHosts);
  if (!check.valid || !check.resolvedIp) return { ok: false, error: "INVALID_URL", reason: check.reason };
  db.query(
    `INSERT INTO tool_ws (client_name, tool_name, ws_url, resolved_ip, enabled, persistent, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(client_name, tool_name) DO UPDATE SET ws_url = excluded.ws_url, resolved_ip = excluded.resolved_ip, enabled = excluded.enabled, persistent = excluded.persistent, updated_at = excluded.updated_at`,
  ).run(clientName, toolName, input.wsUrl, check.resolvedIp, input.enabled ? 1 : 0, input.persistent ? 1 : 0, Date.now());
  return { ok: true };
}

/**
 * Opens an ephemeral WebSocket, sends `payload`, and resolves with the first
 * message received (capped). Rejects on timeout, socket error, or a close
 * before any message. One message in → one message out per fresh connection, so
 * no correlation id is needed.
 */
export function wsRequest(url: string, payload: string, timeoutMs: number, maxBytes: number): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws.close();
      } catch {
        /* already closing */
      }
      fn();
    };
    const ws = new WebSocket(url);
    const timer = setTimeout(() => finish(() => reject(new Error("timeout"))), timeoutMs);

    ws.addEventListener("open", () => {
      try {
        ws.send(payload);
      } catch (e) {
        finish(() => reject(e instanceof Error ? e : new Error(String(e))));
      }
    });
    ws.addEventListener("message", (ev: MessageEvent) => {
      const data = typeof ev.data === "string" ? ev.data : "";
      if (data.length > maxBytes) {
        finish(() => reject(new Error("WS response exceeded MAX_RESPONSE_BYTES limit")));
        return;
      }
      finish(() => resolve(data));
    });
    ws.addEventListener("error", () => finish(() => reject(new Error("WebSocket error"))));
    ws.addEventListener("close", () => finish(() => reject(new Error("WebSocket closed before a response"))));
  });
}

/**
 * Persistent variant of wsRequest: the connection stays open across multiple
 * messages instead of closing after the first. Every message invokes
 * `onMessage` (forwarded as MCP progress by the caller) and becomes the new
 * candidate result; the call finally resolves with the LAST message received,
 * on close or once `timeoutMs` elapses — still a single hard deadline, never
 * an unbounded connection. `wsRequest` itself is untouched; `dispatchWsToolCall`
 * picks between the two based on the tool's `persistent` config.
 */
export function wsRequestPersistent(
  url: string,
  payload: string,
  timeoutMs: number,
  maxBytes: number,
  onMessage?: (data: string) => void,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let settled = false;
    let lastData: string | null = null;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws.close();
      } catch {
        /* already closing */
      }
      fn();
    };
    const ws = new WebSocket(url);
    const timer = setTimeout(
      () => finish(() => (lastData !== null ? resolve(lastData) : reject(new Error("timeout")))),
      timeoutMs,
    );

    ws.addEventListener("open", () => {
      try {
        ws.send(payload);
      } catch (e) {
        finish(() => reject(e instanceof Error ? e : new Error(String(e))));
      }
    });
    ws.addEventListener("message", (ev: MessageEvent) => {
      const data = typeof ev.data === "string" ? ev.data : "";
      if (data.length > maxBytes) {
        finish(() => reject(new Error("WS response exceeded MAX_RESPONSE_BYTES limit")));
        return;
      }
      lastData = data;
      onMessage?.(data);
      // Deliberately does not `finish()` here — stays open for further messages.
    });
    ws.addEventListener("error", () => finish(() => reject(new Error("WebSocket error"))));
    ws.addEventListener("close", () => finish(() => (lastData !== null ? resolve(lastData) : reject(new Error("WebSocket closed before a response")))));
  });
}
