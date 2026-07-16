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
import { WebSocket as WsClient, type RawData } from "ws";
import { getDb } from "../db/connection.js";
import { config } from "../config.js";
import { validateBackendUrl, pinnedWsDial } from "../net/ip-validator.js";
import { toolExists, upsertConfig } from "../lib/tool-config.js";

// ── GraphQL ─────────────────────────────────────────────────────────────────

export interface GraphqlConfig {
  enabled: boolean;
  query: string;
}

export function getToolGraphql(clientName: string, toolName: string): GraphqlConfig | null {
  const row = getDb()
    .query(`SELECT query, enabled FROM tool_graphql WHERE client_name = ? AND tool_name = ?`)
    .get(clientName, toolName) as { query: string; enabled: number } | null;
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

export function setToolGraphql(
  clientName: string,
  toolName: string,
  input: { enabled: boolean; query: string } | null,
): boolean {
  if (!toolExists(clientName, toolName)) return false;
  if (input === null) {
    getDb().query(`DELETE FROM tool_graphql WHERE client_name = ? AND tool_name = ?`).run(clientName, toolName);
    return true;
  }
  upsertConfig(
    "tool_graphql",
    { client_name: clientName, tool_name: toolName },
    { query: input.query, enabled: input.enabled ? 1 : 0 },
    Date.now(),
  );
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
  const row = getDb()
    .query(`SELECT ws_url, resolved_ip, enabled, persistent FROM tool_ws WHERE client_name = ? AND tool_name = ?`)
    .get(clientName, toolName) as { ws_url: string; resolved_ip: string; enabled: number; persistent: number } | null;
  return row
    ? { enabled: row.enabled === 1, wsUrl: row.ws_url, resolvedIp: row.resolved_ip, persistent: row.persistent === 1 }
    : null;
}

/** WS config for every tool of a client, keyed by tool name (batched for detail views). */
export function getWsForClient(clientName: string): Record<string, WsConfig> {
  const rows = getDb()
    .query(`SELECT tool_name, ws_url, resolved_ip, enabled, persistent FROM tool_ws WHERE client_name = ?`)
    .all(clientName) as {
    tool_name: string;
    ws_url: string;
    resolved_ip: string;
    enabled: number;
    persistent: number;
  }[];
  const out: Record<string, WsConfig> = {};
  for (const r of rows)
    out[r.tool_name] = {
      enabled: r.enabled === 1,
      wsUrl: r.ws_url,
      resolvedIp: r.resolved_ip,
      persistent: r.persistent === 1,
    };
  return out;
}

export type WsError = "TOOL_NOT_FOUND" | "INVALID_URL";

export async function setToolWs(
  clientName: string,
  toolName: string,
  input: { enabled: boolean; wsUrl: string; persistent?: boolean } | null,
): Promise<{ ok: true } | { ok: false; error: WsError; reason?: string }> {
  if (!toolExists(clientName, toolName)) return { ok: false, error: "TOOL_NOT_FOUND" };
  if (input === null) {
    getDb().query(`DELETE FROM tool_ws WHERE client_name = ? AND tool_name = ?`).run(clientName, toolName);
    return { ok: true };
  }
  if (!/^wss?:\/\//.test(input.wsUrl)) return { ok: false, error: "INVALID_URL", reason: "must be ws:// or wss://" };
  // SSRF-validate the http-equivalent (validateBackendUrl speaks http/https).
  const httpEquivalent = input.wsUrl.replace(/^ws/, "http");
  const check = await validateBackendUrl(httpEquivalent, config.allowPrivateIps, config.allowedHosts);
  if (!check.valid) return { ok: false, error: "INVALID_URL", reason: check.reason };
  upsertConfig(
    "tool_ws",
    { client_name: clientName, tool_name: toolName },
    {
      ws_url: input.wsUrl,
      resolved_ip: check.resolvedIp,
      enabled: input.enabled ? 1 : 0,
      persistent: input.persistent ? 1 : 0,
    },
    Date.now(),
  );
  return { ok: true };
}

/**
 * Opens a `ws` WebSocket whose TCP connect target is pinned to the
 * SSRF-validated `resolvedIp` (see {@link pinnedWsDial}), while the original
 * hostname stays visible for the Host header / TLS SNI — the WS-dial equivalent
 * of the IP pinning proxy.ts applies to REST fetches. Without this, a bare
 * `new WebSocket(url)` re-resolves DNS on every call, reopening the
 * DNS-rebinding window that config-time validation (setToolWs) closes.
 *
 * `maxPayload` caps a single inbound frame at the protocol layer so `ws` rejects
 * an over-cap frame (close 1009) instead of buffering it fully in memory before
 * the application-level `maxBytes` check runs — without it `ws` falls back to its
 * 100 MiB default, a large gap versus the tool's real response ceiling.
 */
function openPinnedWs(url: string, resolvedIp: string, maxPayload: number): WsClient {
  const pin = pinnedWsDial(url, resolvedIp);
  return new WsClient(pin.url, { maxPayload, ...pin.options });
}

/**
 * Opens an ephemeral WebSocket, sends `payload`, and resolves with the first
 * message received (capped). Rejects on timeout, socket error, or a close
 * before any message. One message in → one message out per fresh connection, so
 * no correlation id is needed.
 */
export function wsRequest(
  url: string,
  resolvedIp: string,
  payload: string,
  timeoutMs: number,
  maxBytes: number,
): Promise<string> {
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
    const ws = openPinnedWs(url, resolvedIp, maxBytes);
    const timer = setTimeout(() => finish(() => reject(new Error("timeout"))), timeoutMs);

    ws.on("open", () => {
      try {
        ws.send(payload);
      } catch (e) {
        finish(() => reject(e instanceof Error ? e : new Error(String(e))));
      }
    });
    ws.on("message", (data: RawData, isBinary: boolean) => {
      if (isBinary) {
        finish(() => reject(new Error("WS tool backend sent a binary frame — only text/JSON responses are supported")));
        return;
      }
      const text = data.toString();
      if (text.length > maxBytes) {
        finish(() => reject(new Error("WS response exceeded MAX_RESPONSE_BYTES limit")));
        return;
      }
      finish(() => resolve(text));
    });
    ws.on("error", () => finish(() => reject(new Error("WebSocket error"))));
    ws.on("close", () => finish(() => reject(new Error("WebSocket closed before a response"))));
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
  resolvedIp: string,
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
    const ws = openPinnedWs(url, resolvedIp, maxBytes);
    const timer = setTimeout(
      () => finish(() => (lastData !== null ? resolve(lastData) : reject(new Error("timeout")))),
      timeoutMs,
    );

    ws.on("open", () => {
      try {
        ws.send(payload);
      } catch (e) {
        finish(() => reject(e instanceof Error ? e : new Error(String(e))));
      }
    });
    ws.on("message", (data: RawData, isBinary: boolean) => {
      if (isBinary) {
        finish(() => reject(new Error("WS tool backend sent a binary frame — only text/JSON responses are supported")));
        return;
      }
      const text = data.toString();
      if (text.length > maxBytes) {
        finish(() => reject(new Error("WS response exceeded MAX_RESPONSE_BYTES limit")));
        return;
      }
      lastData = text;
      onMessage?.(text);
      // Deliberately does not `finish()` here — stays open for further messages.
    });
    ws.on("error", () => finish(() => reject(new Error("WebSocket error"))));
    ws.on("close", () =>
      finish(() => (lastData !== null ? resolve(lastData) : reject(new Error("WebSocket closed before a response")))),
    );
  });
}
