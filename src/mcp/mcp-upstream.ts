import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import type { ProgressCallback } from "@modelcontextprotocol/sdk/shared/protocol.js";
import { makePinnedFetch } from "../net/ip-validator.js";
import { toolResult, type ToolResult, type ToolResultContent } from "../lib/mcp-result.js";
import { outboundTraceHeaders } from "../observability/trace-context.js";
import { errorMessage } from "../lib/error-message.js";

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

/**
 * @deprecated The upstream call path now returns the shared {@link ToolResult}
 * envelope directly. Retained as an alias for any external importer.
 */
export type ProxyToolResult = ToolResult;

const CLIENT_NAME = "mcp-rest-bridge";
const CLIENT_VERSION = "1.0.0";

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
 * Bytes one content item contributes to the aggregate response cap: a text block
 * is billed by its `text` (matching the pre-passthrough accounting, so the
 * text-only cap is byte-for-byte unchanged); any other block is billed by its
 * serialized JSON, so an oversized image/audio `data` or embedded-resource
 * `blob`/`text` still trips the cap.
 */
function contentItemBytes(item: ToolResultContent): number {
  if (item.type === "text" && typeof item.text === "string") {
    return Buffer.byteLength(item.text, "utf8");
  }
  return Buffer.byteLength(JSON.stringify(item), "utf8");
}

/**
 * Maps a Client.callTool() result into the shared {@link ToolResult} envelope,
 * PRESERVING rich MCP 2025-06-18 content: non-text content items
 * (image/audio/embedded-resource/resource_link) are carried through as real
 * blocks rather than flattened into a JSON text blob, and `structuredContent` is
 * threaded through untouched.
 *
 * A MAX_RESPONSE_BYTES ceiling is enforced over the AGGREGATE serialized size
 * (every content item's bytes plus structuredContent's bytes), so an untrusted
 * upstream still can't smuggle an unbounded body through the wider surface — an
 * oversized data blob or structuredContent is rejected with an isError result
 * exactly like an oversized text part.
 *
 * The returned content and structuredContent are still UNSANITIZED here:
 * response redaction, the guardrail scan, and injected-credential stripping run
 * afterward in dispatch-mcp.ts, which now covers text parts, embedded-resource
 * text, AND every structuredContent string leaf. Nothing reaches the caller
 * unscanned.
 */
export function mcpResultToProxyResult(result: unknown, maxBytes: number): ToolResult {
  const r = result as { content?: unknown; isError?: boolean; structuredContent?: unknown };
  const items = Array.isArray(r.content) ? r.content : [];

  const content: ToolResultContent[] = [];
  let totalBytes = 0;
  const overCap = (): ToolResult =>
    toolResult("Upstream MCP response exceeded MAX_RESPONSE_BYTES limit", { isError: true });

  for (const raw of items) {
    // Preserve each content item as-is. A well-formed MCP content block is an
    // object (text OR non-text); a malformed non-object entry is wrapped as a
    // text part so it is neither silently dropped nor allowed to violate the
    // content type.
    const item: ToolResultContent =
      raw !== null && typeof raw === "object" && !Array.isArray(raw)
        ? (raw as ToolResultContent)
        : { type: "text", text: JSON.stringify(raw) };
    totalBytes += contentItemBytes(item);
    if (totalBytes > maxBytes) return overCap();
    content.push(item);
  }

  // structuredContent counts against the SAME aggregate cap — an oversized
  // structured payload must be rejected just like an oversized content blob.
  const structured =
    r.structuredContent !== null && typeof r.structuredContent === "object" && !Array.isArray(r.structuredContent)
      ? (r.structuredContent as Record<string, unknown>)
      : undefined;
  if (structured !== undefined) {
    totalBytes += Buffer.byteLength(JSON.stringify(structured), "utf8");
    if (totalBytes > maxBytes) return overCap();
  }

  const out: ToolResult = { content };
  if (structured !== undefined) out.structuredContent = structured;
  if (r.isError === true) out.isError = true;
  return out;
}

/**
 * Sums the UTF-8 byte length of `texts`, returning true as soon as the running
 * total exceeds `maxBytes`. Mirrors the aggregate-byte accounting
 * mcpResultToProxyResult applies to the tool-call path so the resource-read /
 * prompt-get relay paths enforce the same MAX_RESPONSE_BYTES ceiling.
 */
function textBytesExceed(texts: string[], maxBytes: number): boolean {
  let total = 0;
  for (const t of texts) {
    total += Buffer.byteLength(t, "utf8");
    if (total > maxBytes) return true;
  }
  return false;
}

export interface McpUpstreamPoolOptions {
  transportFactory?: (p: McpConnParams) => Transport;
  connectTimeoutMs?: number;
}

/**
 * Stable fingerprint of the connection-defining params. A pooled connection is
 * reused only while this is unchanged; a changed URL, pinned IP, transport, or
 * auth-header set forces a reconnect on the next use.
 */
function connFingerprint(p: McpConnParams): string {
  const auth = p.authHeaders
    ? Object.keys(p.authHeaders)
        .sort()
        .map((k) => [k, p.authHeaders![k]])
    : [];
  // JSON.stringify escapes the values, so no separator can collide.
  return JSON.stringify([p.url, p.transport, p.resolvedIp ?? "", auth]);
}

export class McpUpstreamPool {
  private conns = new Map<string, Client>();
  // In-flight connection attempts, keyed by client name. The fingerprint the
  // attempt is connecting WITH is tracked alongside the promise so a concurrent
  // getClient for a DIFFERENT fingerprint (rotated auth / re-registered URL/IP)
  // never rides an attempt opened against the old params — it would otherwise
  // reach the wrong backend/credentials during the initial connect window.
  private connecting = new Map<string, { fp: string; promise: Promise<Client> }>();
  // Fingerprint (url/transport/pinned-IP/auth) of the params each live
  // connection was built with, so getClient can drop a stale connection when a
  // client is re-registered or its upstream auth rotates — the pool is keyed by
  // name only, which would otherwise keep hitting the old backend/credentials.
  private connFingerprints = new Map<string, string>();
  private transportFactory: (p: McpConnParams) => Transport;
  private readonly connectTimeoutMs: number;

  constructor(opts: McpUpstreamPoolOptions = {}) {
    this.transportFactory = opts.transportFactory ?? buildTransport;
    this.connectTimeoutMs = opts.connectTimeoutMs ?? 10_000;
  }

  /** Returns a live Client for the upstream, connecting (once) on first use. */
  private async getClient(p: McpConnParams): Promise<Client> {
    const fp = connFingerprint(p);
    const live = this.conns.get(p.name);
    if (live) {
      // Reuse only while the connection params are unchanged. A re-registered
      // URL/pinned-IP or rotated upstream auth changes the fingerprint — drop
      // the stale connection and reconnect, so the next call reaches the new
      // backend/credentials instead of the old ones.
      if (this.connFingerprints.get(p.name) === fp) return live;
      await this.disconnect(p.name);
    }

    const inflight = this.connecting.get(p.name);
    // Reuse an in-flight attempt ONLY when it targets the same fingerprint. A
    // concurrent call whose fingerprint differs (rotated auth / re-registered
    // URL/IP) must open its own connection rather than inherit the pending one —
    // this keeps each call's credential correct (call isolation).
    //
    // Known minor trade-off (rare): if two different-fingerprint calls race, both
    // connect and the second's conns[p.name] overwrites the first's, orphaning the
    // first Client (an open socket that isn't .close()'d). We accept this over
    // serializing — serializing would let the second call disconnect the first's
    // client mid tools/call. The orphaned socket is reclaimed by the upstream's
    // idle timeout / process restart; the leak is bounded to concurrent auth
    // rotations, and no call ever uses the wrong credential.
    if (inflight && inflight.fp === fp) return inflight.promise;

    const promise = (async () => {
      const client = new Client({ name: CLIENT_NAME, version: CLIENT_VERSION }, { capabilities: {} });
      await client.connect(this.transportFactory(p), { timeout: this.connectTimeoutMs });
      this.conns.set(p.name, client);
      this.connFingerprints.set(p.name, fp);
      return client;
    })();

    const entry = { fp, promise };
    this.connecting.set(p.name, entry);
    // Clear the attempt when it settles, but ONLY if it is still the current
    // entry for this name — a later attempt for a different fingerprint may have
    // replaced it, and an unconditional delete-by-name would orphan that newer
    // attempt (leaving a live connect the pool no longer tracks). Runs on both
    // success and failure so a failed connect doesn't wedge the name.
    void promise
      .catch(() => undefined)
      .finally(() => {
        if (this.connecting.get(p.name) === entry) this.connecting.delete(p.name);
      });
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
      return toolResult(`Failed to connect to MCP upstream '${p.name}': ${errorMessage(err)}`, { isError: true });
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
      return toolResult(`MCP tool call failed for '${p.name}': ${errorMessage(err)}`, { isError: true });
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

  /**
   * Reads one upstream resource by URI. Throws + drops the connection on error.
   *
   * When `maxBytes` is provided, the aggregate UTF-8 length of the returned
   * text contents is enforced against it BEFORE the content is relayed (or
   * scanned by the server handler) — an isError result is returned instead of
   * the oversized body, mirroring mcpResultToProxyResult's cap on the tool-call
   * path so an untrusted upstream can't smuggle an unbounded body through the
   * resource-read route.
   */
  async readResource(p: McpConnParams, uri: string, timeoutMs: number, maxBytes?: number): Promise<unknown> {
    const client = await this.getClient(p);
    let result: unknown;
    try {
      result = await client.readResource({ uri }, { timeout: timeoutMs });
    } catch (err) {
      await this.disconnect(p.name);
      throw err;
    }
    if (maxBytes !== undefined) {
      const contents = (result as { contents?: unknown }).contents;
      const texts = Array.isArray(contents)
        ? contents.flatMap((c) => {
            const t = (c as { text?: unknown }).text;
            return typeof t === "string" ? [t] : [];
          })
        : [];
      if (textBytesExceed(texts, maxBytes)) {
        return {
          contents: [{ uri, mimeType: "text/plain", text: "Upstream MCP resource exceeded MAX_RESPONSE_BYTES limit" }],
          isError: true,
        };
      }
    }
    return result;
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

  /**
   * Gets one upstream prompt by name. Throws + drops the connection on error.
   *
   * `maxBytes` enforces the same aggregate MAX_RESPONSE_BYTES ceiling the
   * tool-call and resource-read paths apply, over the prompt messages' text
   * content, before it is relayed/scanned.
   */
  async getPrompt(
    p: McpConnParams,
    name: string,
    args: Record<string, string>,
    timeoutMs: number,
    maxBytes?: number,
  ): Promise<unknown> {
    const client = await this.getClient(p);
    let result: unknown;
    try {
      result = await client.getPrompt({ name, arguments: args }, { timeout: timeoutMs });
    } catch (err) {
      await this.disconnect(p.name);
      throw err;
    }
    if (maxBytes !== undefined) {
      const messages = (result as { messages?: unknown }).messages;
      const texts = Array.isArray(messages)
        ? messages.flatMap((m) => {
            const content = (m as { content?: { type?: unknown; text?: unknown } }).content;
            return content && content.type === "text" && typeof content.text === "string" ? [content.text] : [];
          })
        : [];
      if (textBytesExceed(texts, maxBytes)) {
        return {
          messages: [
            { role: "user", content: { type: "text", text: "Upstream MCP prompt exceeded MAX_RESPONSE_BYTES limit" } },
          ],
          isError: true,
        };
      }
    }
    return result;
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
    this.connFingerprints.delete(name);
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
    this.connFingerprints.clear();
  }
}

/** Process-wide pool used by the proxy/health paths. */
export const mcpUpstream = new McpUpstreamPool();
