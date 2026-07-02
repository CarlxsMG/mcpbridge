/**
 * Live, bidirectional WebSocket proxy for arbitrary backend WS services —
 * genuinely distinct from the existing per-tool `tool_ws` feature (backends.ts),
 * which is a one-shot request/response squeezed into MCP's tools/call model.
 * A ws-proxy target has no tools and isn't a health-checked "server" the way
 * `clients` are, so it gets its own table + in-memory registry rather than
 * extending the client abstraction.
 *
 * Not exposed as an MCP tool — MCP's tools/call is request/response, which
 * can't express a live socket. Instead this is a plain Express-adjacent
 * upgrade route (`/ws-proxy/:name`), wired via `server.on("upgrade")` in
 * index.ts, gated by the same credential material as `/mcp*`.
 */
import { WebSocketServer, WebSocket as WsClient, type RawData } from "ws";
import type { IncomingMessage } from "http";
import type { Duplex } from "stream";
import { getDb } from "./db/connection.js";
import { config } from "./config.js";
import { validateBackendUrl } from "./security/ip-validator.js";
import { evaluateMcpAuth } from "./middleware/auth.js";
import { isClientInKeyScope } from "./security/mcp-key-store.js";
import { isOriginAllowed } from "./middleware/origin-validator.js";
import { getCircuitBreaker } from "./circuit-breaker.js";
import { registry } from "./registry.js";
import { log } from "./logger.js";
import { wsProxyActiveConnections, wsProxyBytesTotal } from "./observability/metrics.js";

const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,62}$/;

export interface WsProxyTarget {
  name: string;
  backendWsUrl: string;
  resolvedIp: string;
  maxConnections: number;
  maxMessageBytes: number;
  idleTimeoutMs: number;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

interface WsProxyTargetRow {
  name: string;
  backend_ws_url: string;
  resolved_ip: string;
  max_connections: number;
  max_message_bytes: number;
  idle_timeout_ms: number;
  enabled: number;
  created_at: number;
  updated_at: number;
}

function rowToTarget(row: WsProxyTargetRow): WsProxyTarget {
  return {
    name: row.name,
    backendWsUrl: row.backend_ws_url,
    resolvedIp: row.resolved_ip,
    maxConnections: row.max_connections,
    maxMessageBytes: row.max_message_bytes,
    idleTimeoutMs: row.idle_timeout_ms,
    enabled: row.enabled === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const COLS = "name, backend_ws_url, resolved_ip, max_connections, max_message_bytes, idle_timeout_ms, enabled, created_at, updated_at";

// In-memory target map, hydrated at boot and kept in sync on every admin
// mutation — mirrors bundles.ts's liveBundles pattern.
const targets = new Map<string, WsProxyTarget>();

interface ProxiedConn {
  clientWs: WsClient;
  backendWs: WsClient;
  lastActivity: number;
  targetName: string;
  hostname: string;
}

const connsByTarget = new Map<string, Set<ProxiedConn>>();
let globalActive = 0;

/** Loads every ws-proxy target from SQLite into the hot-path map. Call once at boot, after migrations have run. */
export function loadWsProxyTargets(): void {
  const rows = getDb().query(`SELECT ${COLS} FROM ws_proxy_targets`).all() as WsProxyTargetRow[];
  targets.clear();
  for (const row of rows) targets.set(row.name, rowToTarget(row));
  log("info", "Loaded WS proxy targets", { count: targets.size });
}

export function listWsProxyTargets(): (WsProxyTarget & { activeConnections: number })[] {
  return [...targets.values()]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((t) => ({ ...t, activeConnections: connsByTarget.get(t.name)?.size ?? 0 }));
}

export function getWsProxyTargetDetail(name: string): (WsProxyTarget & { activeConnections: number }) | undefined {
  const t = targets.get(name);
  return t ? { ...t, activeConnections: connsByTarget.get(t.name)?.size ?? 0 } : undefined;
}

export type WsProxyTargetError =
  | { code: "INVALID_NAME"; message: string }
  | { code: "NAME_COLLISION"; message: string }
  | { code: "INVALID_URL"; message: string };

export interface WsProxyTargetInput {
  backendWsUrl: string;
  maxConnections?: number;
  maxMessageBytes?: number;
  idleTimeoutMs?: number;
  enabled?: boolean;
}

/**
 * Creates or updates a ws-proxy target. Re-validates the backend URL (SSRF +
 * IP pin, same posture as setToolWs) every time, including on update, since
 * the URL may have changed. Name uniqueness is enforced across `clients` and
 * `ws_proxy_targets` at this layer — SQLite can't express a cross-table
 * UNIQUE constraint directly.
 */
export async function upsertWsProxyTarget(
  name: string,
  input: WsProxyTargetInput
): Promise<{ ok: true; target: WsProxyTarget } | { ok: false; error: WsProxyTargetError }> {
  if (!NAME_RE.test(name)) {
    return { ok: false, error: { code: "INVALID_NAME", message: "Name must match /^[a-z0-9][a-z0-9_-]{0,62}$/" } };
  }
  if (!targets.has(name) && registry.getClient(name)) {
    return { ok: false, error: { code: "NAME_COLLISION", message: `"${name}" is already registered as an MCP/REST client` } };
  }
  if (!/^wss?:\/\//.test(input.backendWsUrl)) {
    return { ok: false, error: { code: "INVALID_URL", message: "backendWsUrl must start with ws:// or wss://" } };
  }
  const httpEquivalent = input.backendWsUrl.replace(/^ws/, "http");
  const check = await validateBackendUrl(httpEquivalent, config.allowPrivateIps, config.allowedHosts);
  if (!check.valid || !check.resolvedIp) {
    return { ok: false, error: { code: "INVALID_URL", message: check.reason ?? "invalid backendWsUrl" } };
  }

  const now = Date.now();
  const maxConnections = input.maxConnections ?? config.wsProxyDefaultMaxConnectionsPerTarget;
  const maxMessageBytes = input.maxMessageBytes ?? config.wsProxyDefaultMaxMessageBytes;
  const idleTimeoutMs = input.idleTimeoutMs ?? config.wsProxyDefaultIdleTimeoutMs;
  const enabled = input.enabled ?? true;

  const row = getDb()
    .query(
      `INSERT INTO ws_proxy_targets (name, backend_ws_url, resolved_ip, max_connections, max_message_bytes, idle_timeout_ms, enabled, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(name) DO UPDATE SET
         backend_ws_url = excluded.backend_ws_url,
         resolved_ip = excluded.resolved_ip,
         max_connections = excluded.max_connections,
         max_message_bytes = excluded.max_message_bytes,
         idle_timeout_ms = excluded.idle_timeout_ms,
         enabled = excluded.enabled,
         updated_at = excluded.updated_at
       RETURNING ${COLS}`
    )
    .get(name, input.backendWsUrl, check.resolvedIp, maxConnections, maxMessageBytes, idleTimeoutMs, enabled ? 1 : 0, now, now) as WsProxyTargetRow;

  const target = rowToTarget(row);
  targets.set(name, target);
  return { ok: true, target };
}

/** Deletes a target and force-closes any live connections against it — deletion is a deliberate, immediate cutover, not a wait-for-the-next-sweep policy. */
export function deleteWsProxyTarget(name: string): boolean {
  const result = getDb().query(`DELETE FROM ws_proxy_targets WHERE name = ?`).run(name);
  if (result.changes === 0) return false;
  targets.delete(name);
  closeAllConnectionsForTarget(name, 1012, "target removed");
  return true;
}

/** Force-closes every live connection for a target — the admin "disconnect all" escape hatch, and used internally on delete/disable. */
export function disconnectAllForTarget(name: string): number {
  return closeAllConnectionsForTarget(name, 1012, "disconnected by admin");
}

function closeAllConnectionsForTarget(name: string, code: number, reason: string): number {
  const set = connsByTarget.get(name);
  if (!set) return 0;
  const count = set.size;
  for (const conn of [...set]) {
    safeClose(conn.clientWs, code, reason);
    safeClose(conn.backendWs, code, reason);
    removeConn(conn);
  }
  return count;
}

function addConn(conn: ProxiedConn): void {
  let set = connsByTarget.get(conn.targetName);
  if (!set) {
    set = new Set();
    connsByTarget.set(conn.targetName, set);
  }
  set.add(conn);
  globalActive++;
  wsProxyActiveConnections.set({ target: conn.targetName }, set.size);
}

function removeConn(conn: ProxiedConn): void {
  const set = connsByTarget.get(conn.targetName);
  if (set?.delete(conn)) {
    globalActive--;
    wsProxyActiveConnections.set({ target: conn.targetName }, set.size);
  }
}

function rawDataByteLength(data: RawData): number {
  if (Array.isArray(data)) return data.reduce((n, b) => n + b.length, 0);
  if (Buffer.isBuffer(data)) return data.length;
  return data.byteLength;
}

/**
 * Force-closes a proxied socket. Uses terminate() rather than the polite
 * close(code, reason) handshake deliberately: close() waits (up to `ws`'s
 * internal closeTimeout, 30s by default) for the peer to send its own close
 * frame back before the underlying TCP socket actually releases, which is
 * the wrong trade-off here — every caller of this (admin disconnect, idle
 * sweep, revalidation, error paths) wants resources freed immediately, not a
 * best-effort RFC 6455 handshake with an uncooperative or slow peer.
 */
function safeClose(ws: WsClient, _code: number, _reason: string): void {
  try {
    if (ws.readyState === WsClient.OPEN || ws.readyState === WsClient.CONNECTING) {
      ws.terminate();
    }
  } catch {
    /* already closing */
  }
}

let sharedWss: WebSocketServer | null = null;
function getSharedWss(): WebSocketServer {
  if (!sharedWss) sharedWss = new WebSocketServer({ noServer: true });
  return sharedWss;
}

function rejectUpgrade(socket: Duplex, status: number, message: string): void {
  try {
    const body = message;
    socket.write(
      `HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`
    );
  } catch {
    /* socket may already be gone */
  }
  socket.destroy();
}

/**
 * Handles a raw HTTP Upgrade request for `/ws-proxy/:name`, wired from
 * `server.on("upgrade")` in index.ts. Auth/origin/capacity/breaker gates all
 * run BEFORE accepting the caller's handshake, so a rejected request never
 * costs a backend dial.
 */
export async function handleWsProxyUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
  const url = req.url ?? "";
  const match = /^\/ws-proxy\/([^/?]+)/.exec(url);
  if (!match) {
    rejectUpgrade(socket, 404, "Not found");
    return;
  }
  const name = decodeURIComponent(match[1]);
  const target = targets.get(name);
  if (!target || !target.enabled) {
    rejectUpgrade(socket, 404, "Not found");
    return;
  }

  const verdict = await evaluateMcpAuth(req.headers);
  if (!verdict.ok) {
    rejectUpgrade(socket, verdict.status ?? 401, verdict.message ?? "Unauthorized");
    return;
  }
  if (verdict.scopes !== undefined && !isClientInKeyScope(verdict.scopes, name)) {
    rejectUpgrade(socket, 403, "Key not scoped to this target");
    return;
  }

  const origin = req.headers.origin;
  const secFetchSite = req.headers["sec-fetch-site"];
  if (!isOriginAllowed(origin, Array.isArray(secFetchSite) ? secFetchSite[0] : secFetchSite)) {
    rejectUpgrade(socket, 403, "Origin not allowed");
    return;
  }

  if (globalActive >= config.wsProxyMaxGlobalConnections) {
    rejectUpgrade(socket, 503, "At capacity");
    return;
  }
  const perTarget = connsByTarget.get(name)?.size ?? 0;
  if (perTarget >= target.maxConnections) {
    rejectUpgrade(socket, 503, "Target at capacity");
    return;
  }

  const breaker = getCircuitBreaker(name);
  const breakerVerdict = breaker.canRequest();
  if (!breakerVerdict.allowed) {
    rejectUpgrade(socket, 503, "Backend quarantined");
    return;
  }

  const wss = getSharedWss();
  wss.handleUpgrade(req, socket, head, (clientWs) => {
    void dialBackendAndPipe(clientWs, target, breaker);
  });
}

/** Caps how many caller messages can queue up while the backend dial is still in flight (a chatty caller during a slow/stalled dial shouldn't grow unbounded). */
const MAX_PENDING_MESSAGES = 256;

function dialBackendAndPipe(clientWs: WsClient, target: WsProxyTarget, breaker: ReturnType<typeof getCircuitBreaker>): void {
  const hostname = new URL(target.backendWsUrl.replace(/^ws/, "http")).hostname;
  const isRawIp = /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname) || hostname.startsWith("[") || hostname.includes(":");

  const backendWs = new WsClient(target.backendWsUrl, {
    maxPayload: target.maxMessageBytes,
    handshakeTimeout: config.wsProxyDialTimeoutMs,
    // Pin the TCP connection to the SSRF-validated IP while preserving the
    // original hostname for the Host header / TLS SNI — same intent as the
    // fetch-side pinning proxy.ts does for REST, achieved differently since a
    // WS upgrade handshake can't rewrite the URL host the way fetch does.
    ...(isRawIp ? {} : { lookup: (_h: string, _o: unknown, cb: (err: Error | null, address: string, family: number) => void) => cb(null, target.resolvedIp, 4) }),
  });

  const conn: ProxiedConn = { clientWs, backendWs, lastActivity: Date.now(), targetName: target.name, hostname };

  // Counted from the moment the caller's socket is accepted, not once the
  // backend dial completes — capacity is a property of "how many callers are
  // occupying this target right now," and the backend handshake is
  // asynchronous, so counting late would let a burst of near-simultaneous
  // callers all sneak in above maxConnections before any of their backend
  // dials finish.
  addConn(conn);

  // The caller's upgrade is accepted (and can start sending messages)
  // immediately, but the backend dial is asynchronous — a message arriving
  // before backendWs reaches OPEN would otherwise be silently dropped
  // (ws.send() on a CONNECTING socket throws, and that throw is swallowed
  // below). Queue it and flush once the backend actually opens.
  const pendingFromClient: { data: RawData; isBinary: boolean }[] = [];

  backendWs.on("open", () => {
    breaker.recordSuccess();
    for (const { data, isBinary } of pendingFromClient) {
      try {
        backendWs.send(data, { binary: isBinary });
      } catch {
        /* backend closed again immediately after opening */
      }
    }
    pendingFromClient.length = 0;
  });

  backendWs.on("error", (err) => {
    breaker.recordFailure();
    log("warn", "WS proxy backend error", { target: target.name, error: err.message });
    safeClose(clientWs, 1011, "backend error");
    removeConn(conn);
  });

  backendWs.on("close", (code, reasonBuf) => {
    safeClose(clientWs, code || 1000, reasonBuf.toString());
    removeConn(conn);
  });

  backendWs.on("message", (data: RawData, isBinary: boolean) => {
    conn.lastActivity = Date.now();
    const bytes = rawDataByteLength(data);
    wsProxyBytesTotal.inc({ target: target.name, direction: "down" }, bytes);
    try {
      clientWs.send(data, { binary: isBinary });
    } catch {
      /* client already closing */
    }
  });

  clientWs.on("message", (data: RawData, isBinary: boolean) => {
    conn.lastActivity = Date.now();
    const bytes = rawDataByteLength(data);
    if (bytes > target.maxMessageBytes) {
      safeClose(clientWs, 1009, "message too large");
      return;
    }
    wsProxyBytesTotal.inc({ target: target.name, direction: "up" }, bytes);
    if (backendWs.readyState === WsClient.CONNECTING) {
      if (pendingFromClient.length >= MAX_PENDING_MESSAGES) {
        safeClose(clientWs, 1013, "backend dial not keeping up");
        return;
      }
      pendingFromClient.push({ data, isBinary });
      return;
    }
    try {
      backendWs.send(data, { binary: isBinary });
    } catch {
      /* backend already closing */
    }
  });

  clientWs.on("close", () => {
    safeClose(backendWs, 1000, "caller closed");
    removeConn(conn);
  });
  clientWs.on("error", () => {
    safeClose(backendWs, 1011, "caller error");
    removeConn(conn);
  });
}

/**
 * Periodic sweep: drops connections idle past their target's idle_timeout_ms,
 * or whose target was since deleted/disabled. For hostnames (not raw IP
 * literals), best-effort re-validates via validateBackendUrl and proactively
 * distrusts (closes) a connection whose backend host now resolves exclusively
 * to a blocked range — a live TCP socket can't be re-pinned mid-flight, so
 * this only protects future traffic, not the packets already in flight.
 */
export function startWsProxyRevalidationLoop(): () => void {
  const handle = setInterval(() => {
    const now = Date.now();
    for (const [targetName, set] of connsByTarget) {
      const target = targets.get(targetName);
      for (const conn of [...set]) {
        if (!target || !target.enabled) {
          safeClose(conn.clientWs, 1012, "target removed");
          safeClose(conn.backendWs, 1012, "target removed");
          removeConn(conn);
          continue;
        }
        if (now - conn.lastActivity > target.idleTimeoutMs) {
          safeClose(conn.clientWs, 1000, "idle timeout");
          safeClose(conn.backendWs, 1000, "idle timeout");
          removeConn(conn);
          continue;
        }
        const isRawIp = /^\d{1,3}(\.\d{1,3}){3}$/.test(conn.hostname) || conn.hostname.startsWith("[") || conn.hostname.includes(":");
        if (isRawIp) continue;
        void validateBackendUrl(`http://${conn.hostname}`, config.allowPrivateIps, config.allowedHosts).then((check) => {
          if (!check.valid) {
            log("warn", "WS proxy connection distrusted after revalidation", { target: targetName, hostname: conn.hostname, reason: check.reason });
            safeClose(conn.clientWs, 1012, "backend host no longer trusted");
            safeClose(conn.backendWs, 1012, "backend host no longer trusted");
            removeConn(conn);
          }
        });
      }
    }
  }, config.wsProxyRevalidateIntervalMs);
  return () => clearInterval(handle);
}

/** Closes every live proxy connection on both legs — called from gracefulShutdown. */
export function closeAllWsProxyConnections(): void {
  for (const name of connsByTarget.keys()) closeAllConnectionsForTarget(name, 1001, "server shutting down");
}

export function wsProxyActiveConnectionCount(): number {
  return globalActive;
}

export function __resetWsProxyForTesting(): void {
  targets.clear();
  connsByTarget.clear();
  globalActive = 0;
}
