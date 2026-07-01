import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";

// ---------------------------------------------------------------------------
// Outbound MCP upstream connection pool + dispatcher.
//
// This is the MCP counterpart of proxy.ts's REST fetch path: it maintains one
// long-lived MCP Client per registered upstream (keyed by client name) and
// forwards tools/call to it. The result of Client.callTool() is already in the
// exact `{ content, isError }` shape proxyToolCall() returns, so dispatch is a
// near-passthrough.
//
// Deliberately parameterized (timeouts/caps/transport factory are injected)
// rather than reaching into config/registry, so it is unit-testable in
// isolation against an in-process server via InMemoryTransport.
// ---------------------------------------------------------------------------

export type McpTransportKind = "streamable-http" | "sse";

/** Everything the pool needs to open (and pin) a connection to one upstream. */
export interface McpConnParams {
  /** Registry client name — the pool cache key. */
  name: string;
  /** Upstream MCP endpoint URL. */
  url: string;
  transport: McpTransportKind;
  /** SSRF-validated IP to pin the connection to (anti DNS-rebinding). Omit in tests. */
  resolvedIp?: string;
  /** Outbound auth headers (bearer/basic/custom), already resolved+decrypted. */
  authHeaders?: Record<string, string>;
}

/** The shape proxyToolCall() returns — kept identical so the MCP branch is a drop-in. */
export interface ProxyToolResult {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}

const CLIENT_NAME = "mcp-rest-bridge";
const CLIENT_VERSION = "1.0.0";

function errorResult(text: string): ProxyToolResult {
  return { isError: true, content: [{ type: "text", text }] };
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

/**
 * Builds a fetch that pins the upstream hostname to a validated IP while
 * preserving the original Host header — the same DNS-rebinding mitigation
 * proxy.ts applies per REST call, adapted for the transport's own fetch.
 */
function makePinnedFetch(originalHostname: string, ip: string): FetchLike {
  return async (input, init) => {
    const u = new URL(typeof input === "string" ? input : input.toString());
    const host = u.host; // host:port, preserved as the Host header
    if (u.hostname === originalHostname) {
      u.hostname = ip;
    }
    const headers = new Headers(init?.headers);
    headers.set("Host", host);
    return fetch(u, { ...init, headers, redirect: "error" });
  };
}

/** Default transport factory — real network transports. Overridable for tests. */
export function buildTransport(p: McpConnParams): Transport {
  const url = new URL(p.url);
  const requestInit: RequestInit | undefined = p.authHeaders ? { headers: p.authHeaders } : undefined;
  const pinnedFetch =
    p.resolvedIp && p.resolvedIp.length > 0 ? makePinnedFetch(url.hostname, p.resolvedIp) : undefined;

  if (p.transport === "sse") {
    const opts: NonNullable<ConstructorParameters<typeof SSEClientTransport>[1]> = {};
    if (requestInit) opts.requestInit = requestInit;
    if (pinnedFetch) opts.fetch = pinnedFetch as typeof opts.fetch;
    return new SSEClientTransport(url, opts);
  }

  const opts: NonNullable<ConstructorParameters<typeof StreamableHTTPClientTransport>[1]> = {};
  if (requestInit) opts.requestInit = requestInit;
  if (pinnedFetch) opts.fetch = pinnedFetch as typeof opts.fetch;
  return new StreamableHTTPClientTransport(url, opts);
}

/**
 * Maps a Client.callTool() result into proxyToolCall()'s return shape,
 * enforcing a byte cap on the aggregate text content (mirrors proxy.ts's
 * MAX_RESPONSE_BYTES streaming cap intent). Non-text content items are
 * preserved by JSON-encoding them into a text part so nothing is silently
 * dropped when re-served over MCP.
 */
export function mcpResultToProxyResult(result: unknown, maxBytes: number): ProxyToolResult {
  const r = result as { content?: unknown; isError?: boolean };
  const items = Array.isArray(r.content) ? r.content : [];

  const content: Array<{ type: string; text: string }> = [];
  let totalBytes = 0;

  for (const raw of items) {
    const item = raw as { type?: unknown; text?: unknown };
    const text =
      item.type === "text" && typeof item.text === "string" ? item.text : JSON.stringify(raw);
    totalBytes += Buffer.byteLength(text, "utf8");
    if (totalBytes > maxBytes) {
      return errorResult("Upstream MCP response exceeded MAX_RESPONSE_BYTES limit");
    }
    // Everything is normalized to a text part so the result stays assignable to
    // proxyToolCall()'s return type; non-text items were JSON-encoded above.
    content.push({ type: "text", text });
  }

  return { content, isError: r.isError === true ? true : undefined };
}

export interface McpUpstreamPoolOptions {
  transportFactory?: (p: McpConnParams) => Transport;
  connectTimeoutMs?: number;
}

export class McpUpstreamPool {
  private conns = new Map<string, Client>();
  private connecting = new Map<string, Promise<Client>>();
  private transportFactory: (p: McpConnParams) => Transport;
  private readonly connectTimeoutMs: number;

  constructor(opts: McpUpstreamPoolOptions = {}) {
    this.transportFactory = opts.transportFactory ?? buildTransport;
    this.connectTimeoutMs = opts.connectTimeoutMs ?? 10_000;
  }

  /** Returns a live Client for the upstream, connecting (once) on first use. */
  private async getClient(p: McpConnParams): Promise<Client> {
    const live = this.conns.get(p.name);
    if (live) return live;

    const inflight = this.connecting.get(p.name);
    if (inflight) return inflight;

    const promise = (async () => {
      const client = new Client({ name: CLIENT_NAME, version: CLIENT_VERSION }, { capabilities: {} });
      await client.connect(this.transportFactory(p), { timeout: this.connectTimeoutMs });
      this.conns.set(p.name, client);
      this.connecting.delete(p.name);
      return client;
    })().catch((err) => {
      this.connecting.delete(p.name);
      throw err;
    });

    this.connecting.set(p.name, promise);
    return promise;
  }

  /**
   * Forwards a tools/call to the upstream. Does NOT retry the call on failure:
   * MCP tools carry no idempotency guarantee (unlike REST's method-based retry),
   * so a retry could double-execute. A failed call drops the (possibly dead)
   * connection so the NEXT call reconnects.
   */
  async call(
    p: McpConnParams,
    upstreamToolName: string,
    args: Record<string, unknown>,
    opts: { timeoutMs: number; maxBytes: number }
  ): Promise<ProxyToolResult> {
    let client: Client;
    try {
      client = await this.getClient(p);
    } catch (err) {
      return errorResult(`Failed to connect to MCP upstream '${p.name}': ${messageOf(err)}`);
    }

    try {
      const result = await client.callTool(
        { name: upstreamToolName, arguments: args },
        undefined,
        { timeout: opts.timeoutMs }
      );
      return mcpResultToProxyResult(result, opts.maxBytes);
    } catch (err) {
      await this.disconnect(p.name);
      return errorResult(`MCP tool call failed for '${p.name}': ${messageOf(err)}`);
    }
  }

  /** Liveness probe used by the health loop for MCP upstreams. */
  async ping(p: McpConnParams, timeoutMs: number): Promise<boolean> {
    try {
      const client = await this.getClient(p);
      await client.ping({ timeout: timeoutMs });
      return true;
    } catch {
      await this.disconnect(p.name);
      return false;
    }
  }

  /** Closes and forgets the connection for a client (called on unregister/teardown). */
  async disconnect(name: string): Promise<void> {
    const client = this.conns.get(name);
    this.conns.delete(name);
    if (client) {
      try {
        await client.close();
      } catch {
        // best-effort — the socket may already be gone
      }
    }
  }

  /** True when a live connection is currently cached (for diagnostics/tests). */
  isConnected(name: string): boolean {
    return this.conns.has(name);
  }

  /** Test-only: swap the transport factory and drop any pooled connections. */
  __setTransportFactoryForTesting(factory: (p: McpConnParams) => Transport): void {
    this.transportFactory = factory;
    this.conns.clear();
    this.connecting.clear();
  }
}

/** Process-wide pool used by the proxy/health paths. */
export const mcpUpstream = new McpUpstreamPool();
