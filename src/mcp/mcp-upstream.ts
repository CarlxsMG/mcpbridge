import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import type { ProgressCallback } from "@modelcontextprotocol/sdk/shared/protocol.js";
import { makePinnedFetch } from "../net/ip-validator.js";
import { toolResult } from "../lib/mcp-result.js";
import { outboundTraceHeaders } from "../observability/trace-context.js";

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
  /** True when this result came from a caller-initiated cancellation, not an upstream failure — the caller must not penalize the circuit breaker for it. */
  cancelled?: boolean;
}

const CLIENT_NAME = "mcp-rest-bridge";
const CLIENT_VERSION = "1.0.0";

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Default transport factory — real network transports. Overridable for tests. */
export function buildTransport(p: McpConnParams): Transport {
  const url = new URL(p.url);
  const requestInit: RequestInit | undefined = p.authHeaders ? { headers: p.authHeaders } : undefined;
  const pinnedFetch = p.resolvedIp && p.resolvedIp.length > 0 ? makePinnedFetch(url.hostname, p.resolvedIp) : undefined;
  // W3C trace propagation: every JSON-RPC call the SDK makes through this
  // transport goes through `tracingFetch`, which adds traceparent/tracestate
  // derived from the current request's trace context. Each call gets a
  // fresh spanId so individual upstream spans are distinguishable, but the
  // traceId (and thus the trace tree) stays stitched to the caller's.
  const tracingFetch: typeof fetch | undefined = (() => {
    if (!pinnedFetch) return undefined;
    // The MCP SDK types `opts.fetch` as `typeof fetch`, but makePinnedFetch
    // narrows `input` to `string | URL` (no Request). The cast at the
    // boundary matches the pattern the rest of the file already uses for
    // `pinnedFetch` itself; runtime behavior is identical.
    type PinnedFetchFn = (input: string | URL, init: RequestInit) => Promise<Response>;
    const inner = pinnedFetch as unknown as PinnedFetchFn;
    return ((input, init) => {
      const url = typeof input === "string" || input instanceof URL ? input : String(input);
      return inner(url, { ...(init ?? {}), headers: outboundTraceHeaders(undefined, init?.headers) });
    }) as typeof fetch;
  })();

  if (p.transport === "sse") {
    const opts: NonNullable<ConstructorParameters<typeof SSEClientTransport>[1]> = {};
    if (requestInit) opts.requestInit = requestInit;
    if (tracingFetch) opts.fetch = tracingFetch;
    return new SSEClientTransport(url, opts);
  }

  const opts: NonNullable<ConstructorParameters<typeof StreamableHTTPClientTransport>[1]> = {};
  if (requestInit) opts.requestInit = requestInit;
  if (tracingFetch) opts.fetch = tracingFetch;
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
    const text = item.type === "text" && typeof item.text === "string" ? item.text : JSON.stringify(raw);
    totalBytes += Buffer.byteLength(text, "utf8");
    if (totalBytes > maxBytes) {
      return toolResult("Upstream MCP response exceeded MAX_RESPONSE_BYTES limit", { isError: true });
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
   *
   * `signal`/`onprogress` bridge the downstream MCP caller's own cancellation
   * and progress-request straight through to this SDK Client call — opt-in on
   * both legs (see proxy.ts/mcp-server.ts): `onprogress` is only ever set when
   * the bridge itself has a downstream sink to forward to, which is exactly
   * how the SDK decides whether to ask the upstream for progress at all.
   */
  async call(
    p: McpConnParams,
    upstreamToolName: string,
    args: Record<string, unknown>,
    opts: { timeoutMs: number; maxBytes: number; signal?: AbortSignal; onprogress?: ProgressCallback },
  ): Promise<ProxyToolResult> {
    let client: Client;
    try {
      client = await this.getClient(p);
    } catch (err) {
      return toolResult(`Failed to connect to MCP upstream '${p.name}': ${messageOf(err)}`, { isError: true });
    }

    try {
      const result = await client.callTool({ name: upstreamToolName, arguments: args }, undefined, {
        timeout: opts.timeoutMs,
        signal: opts.signal,
        onprogress: opts.onprogress,
      });
      return mcpResultToProxyResult(result, opts.maxBytes);
    } catch (err) {
      if (opts.signal?.aborted) {
        // Caller-initiated cancellation — the SDK already forwarded
        // notifications/cancelled to the upstream on our behalf. Not a
        // connection failure, so the pooled connection is left live.
        return { isError: true, cancelled: true, content: [{ type: "text", text: "Tool call cancelled by caller" }] };
      }
      await this.disconnect(p.name);
      return toolResult(`MCP tool call failed for '${p.name}': ${messageOf(err)}`, { isError: true });
    }
  }

  /** Lists the upstream's resources. Returns [] on error or when unsupported. */
  async listResources(p: McpConnParams, timeoutMs: number): Promise<unknown[]> {
    try {
      const client = await this.getClient(p);
      const r = (await client.listResources(undefined, { timeout: timeoutMs })) as { resources?: unknown[] };
      return r.resources ?? [];
    } catch {
      return [];
    }
  }

  /** Reads one upstream resource by URI. Throws + drops the connection on error. */
  async readResource(p: McpConnParams, uri: string, timeoutMs: number): Promise<unknown> {
    const client = await this.getClient(p);
    try {
      return await client.readResource({ uri }, { timeout: timeoutMs });
    } catch (err) {
      await this.disconnect(p.name);
      throw err;
    }
  }

  /** Lists the upstream's prompts. Returns [] on error or when unsupported. */
  async listPrompts(p: McpConnParams, timeoutMs: number): Promise<unknown[]> {
    try {
      const client = await this.getClient(p);
      const r = (await client.listPrompts(undefined, { timeout: timeoutMs })) as { prompts?: unknown[] };
      return r.prompts ?? [];
    } catch {
      return [];
    }
  }

  /** Gets one upstream prompt by name. Throws + drops the connection on error. */
  async getPrompt(p: McpConnParams, name: string, args: Record<string, string>, timeoutMs: number): Promise<unknown> {
    const client = await this.getClient(p);
    try {
      return await client.getPrompt({ name, arguments: args }, { timeout: timeoutMs });
    } catch (err) {
      await this.disconnect(p.name);
      throw err;
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
