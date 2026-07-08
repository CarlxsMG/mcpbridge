/**
 * Stryker mutation-testing backstop for src/mcp/mcp-server.ts — CLUSTER S5
 * only: the resources/prompts passthrough handlers (ListResourcesRequestSchema
 * / ReadResourceRequestSchema / ListPromptsRequestSchema / GetPromptRequestSchema,
 * source lines ~224-245) and the exported `notifyToolsChanged()` (source lines
 * ~256-264). This is one file in a set of parallel per-cluster agents against
 * the same source file, so it deliberately touches nothing outside this range
 * (no tools/list, tools/call, or scopedToolList coverage here).
 *
 * mcp-server.ts itself is NOT modified — see the file header of any sibling
 * *-mutation-*.test.ts for the general house convention this follows (each
 * describe/test cites the exact line:column + mutator + replacement it
 * targets). All line numbers below were confirmed directly against the
 * current src/mcp/mcp-server.ts at the time of writing (no drift from the
 * task's line references); columns are carried over from the task's own
 * Stryker citations verbatim.
 *
 * Two harnesses, matching the task's split:
 *   - LIGHTWEIGHT (InMemoryTransport, Client<->Server, no HTTP) for
 *     everything here — none of S5's logic depends on a real caller
 *     Authorization/X-End-User-Id header reaching `extra.requestInfo`, which
 *     is the one thing InMemoryTransport can't carry (only `authInfo`, never
 *     `requestInfo` — see node_modules/@modelcontextprotocol/sdk's
 *     dist/esm/inMemory.js).
 *   - A DOUBLE-HOP InMemoryTransport technique (same idea as
 *     mcp-upstream-mutation.test.ts's makeFactory) for the "available"
 *     resources/prompts case: hop 1 is our test Client <-> the
 *     mcp-server.ts-created Server; hop 2 is the McpUpstreamPool singleton's
 *     own Client <-> a fake upstream Server, wired via
 *     mcpUpstream.__setTransportFactoryForTesting(...). This proves
 *     mcpParamsForScope's success path really reaches mcpUpstream, not just
 *     that it structurally returns non-null.
 *
 * A note on process-wide state: `activeServers` (mcp-server.ts's module-level
 * Set) and `mcpUpstream` (the process-wide McpUpstreamPool singleton) are
 * both shared across every test in this file and — if this file weren't run
 * standalone — every other file that imports mcp-server.ts/mcp-upstream.ts
 * too. Every test below closes the client(s) it opens (which synchronously
 * tears down the paired Server and fires its `onclose`, removing it from
 * `activeServers` — see inMemory.js's `close()`) and the "available" describe
 * restores the real `buildTransport` factory in `afterEach`, so no test
 * leaks state into the next.
 *
 * EQUIVALENT MUTANT (documented per task instructions rather than dropped):
 *   - The `catch {}` in notifyToolsChanged's `try { server.notification(...) }
 *     catch { ... }` (surrounding source line ~260) can never actually catch
 *     anything a real Server produces. `Server.notification()` (inherited
 *     from Protocol, see dist/esm/shared/protocol.js) is declared `async`;
 *     JavaScript converts ANY synchronous throw inside an async function
 *     body into a REJECTED PROMISE, never a synchronous throw back to the
 *     (non-awaiting) caller — and notifyToolsChanged() deliberately does not
 *     `await` the call ("don't await it here to avoid blocking" is the SDK's
 *     own reasoning for the analogous debounced path). So no input can ever
 *     make the `try` block throw synchronously; a `catch`-body-emptied
 *     mutant at that exact location (if Stryker reports one — it is not in
 *     this cluster's assigned mutant list, but is adjacent enough to justify
 *     recording the reasoning here) is unreachable through any real Server
 *     instance. The `try` BLOCK itself (not the catch) is still very much
 *     live and killed below: emptying it removes the `server.notification()`
 *     call entirely, which the "delivers the exact real notification"
 *     test below catches immediately (no notification would ever arrive).
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
  ToolListChangedNotificationSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { createMcpServer, notifyToolsChanged, type McpServerScope } from "../../mcp/mcp-server.js";
import { registry } from "../../mcp/registry.js";
import { mcpUpstream, buildTransport, type McpConnParams } from "../../mcp/mcp-upstream.js";
import { __resetDbForTesting } from "../../db/connection.js";
import type { DiscoveredMcpTool } from "../../mcp/mcp-discovery.js";

/** Same lightweight harness idiom the task describes: a real JSON-RPC round trip, no HTTP. */
async function connectClient(scope: McpServerScope): Promise<{ client: Client; server: Server }> {
  const server = createMcpServer(scope);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "s5-test-client", version: "1.0" }, { capabilities: {} });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return { client, server };
}

// ===========================================================================
// Resources/prompts passthrough — UNAVAILABLE scope. Any non-"client" scope
// (here: "system") makes mcpParamsForScope() return null unconditionally, with
// no registry/bundle setup required — the simplest of the task's three
// suggested "unavailable" shapes.
// ===========================================================================

describe("resources/prompts passthrough — unavailable scope (mcpParamsForScope returns null)", () => {
  // 224:68-227:4 BlockStatement [Survived] (ListResourcesRequestSchema handler
  // body emptied). Killed here: an emptied handler body returns `undefined`,
  // which fails ListResourcesResultSchema's required `resources: z.ZodArray`
  // field, so the client call throws/rejects instead of resolving to `[]`.
  test("listResources resolves to a genuinely empty array, not throwing", async () => {
    const { client } = await connectClient({ kind: "system" });
    try {
      const result = await client.listResources();
      expect(result.resources).toEqual([]);
    } finally {
      await client.close();
    }
  });

  // 229:74-233:4 BlockStatement [Survived] (ReadResourceRequestSchema handler
  // body emptied), 231:9-231:11 BooleanLiteral/ConditionalExpression
  // ("false" direction — "true" direction is killed by the AVAILABLE describe
  // below, where forcing the throw even when p is non-null would wrongly
  // reject a call that must succeed), 231:29-231:76 StringLiteral (the
  // "Resource not available: " message text — the real source interpolates
  // request.params.uri into it via a template literal).
  test("readResource rejects with the real, URI-interpolated 'Resource not available' message", async () => {
    const { client } = await connectClient({ kind: "system" });
    try {
      let caught: unknown;
      try {
        await client.readResource({ uri: "test://my-thing" });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(Error);
      // The SDK's McpError wraps the raw application message as
      // `MCP error <code>: <message>` (see types.js's McpError constructor) —
      // asserting containment (not equality) still pins down the exact
      // application-level text and confirms the real URI was interpolated,
      // not emptied or replaced by a generic message.
      expect((caught as Error).message).toContain("Resource not available: test://my-thing");
    } finally {
      await client.close();
    }
  });

  // 235:66-238:4 BlockStatement [Survived] (ListPromptsRequestSchema handler
  // body emptied) — same failure mode as listResources above: an emptied
  // body fails ListPromptsResultSchema's required `prompts` field instead of
  // resolving to `[]`.
  test("listPrompts resolves to a genuinely empty array, not throwing", async () => {
    const { client } = await connectClient({ kind: "system" });
    try {
      const result = await client.listPrompts();
      expect(result.prompts).toEqual([]);
    } finally {
      await client.close();
    }
  });

  // 240:71-245:4 BlockStatement [Survived] (GetPromptRequestSchema handler
  // body emptied), 242:9-242:11 BooleanLiteral/ConditionalExpression ("false"
  // direction — "true" direction killed by the AVAILABLE describe below,
  // same pairing as readResource's).
  test("getPrompt rejects with the real, name-interpolated 'Prompt not available' message", async () => {
    const { client } = await connectClient({ kind: "system" });
    try {
      let caught: unknown;
      try {
        await client.getPrompt({ name: "my-prompt", arguments: {} });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(Error);
      expect((caught as Error).message).toContain("Prompt not available: my-prompt");
    } finally {
      await client.close();
    }
  });
});

// ===========================================================================
// Resources/prompts passthrough — AVAILABLE scope: a real, enabled, MCP-kind
// client. Proves mcpParamsForScope's success path really wires through to
// mcpUpstream (not just "returns a non-null object") by making the fake
// upstream's OWN distinctive data come back through the full two-hop chain,
// and separately kills the "true" ConditionalExpression direction on both
// `if (!p) throw ...` guards (231, 242): under that mutant these calls would
// wrongly throw even though a live upstream is available.
// ===========================================================================

describe("resources/prompts passthrough — available scope (real client-scoped MCP upstream)", () => {
  const CLIENT = "mcp-server-s5-upstream";
  const TOOLS: DiscoveredMcpTool[] = [
    { name: "noop", upstreamName: "noop", description: "unused by this describe", inputSchema: { type: "object" } },
  ];

  /** Hop 2: a fake upstream Server with distinctive resources/prompts data, reachable only through mcpUpstream's pooled Client. */
  function fakeUpstreamFactory(): (p: McpConnParams) => Transport {
    return (_p: McpConnParams): Transport => {
      const [clientT, serverT] = InMemoryTransport.createLinkedPair();
      const server = new Server(
        { name: "s5-fake-upstream", version: "1.0.0" },
        { capabilities: { resources: {}, prompts: {} } },
      );
      server.setRequestHandler(ListResourcesRequestSchema, async () => ({
        resources: [{ uri: "real://from-upstream", name: "Real Resource" }],
      }));
      server.setRequestHandler(ReadResourceRequestSchema, async (req) => ({
        contents: [{ uri: req.params.uri, text: `real-content:${req.params.uri}` }],
      }));
      server.setRequestHandler(ListPromptsRequestSchema, async () => ({
        prompts: [{ name: "real-prompt", description: "a real prompt from the fake upstream" }],
      }));
      server.setRequestHandler(GetPromptRequestSchema, async (req) => ({
        messages: [{ role: "user", content: { type: "text", text: `real-reply-to:${req.params.name}` } }],
      }));
      void server.connect(serverT);
      return clientT;
    };
  }

  beforeEach(async () => {
    __resetDbForTesting();
    mcpUpstream.__setTransportFactoryForTesting(fakeUpstreamFactory());
    await registry.registerMcp(
      CLIENT,
      TOOLS,
      "http://mcp-server-s5.test/mcp",
      "streamable-http",
      "127.0.0.1",
      "127.0.0.1",
    );
  });

  afterEach(async () => {
    await registry.unregister(CLIENT);
    await mcpUpstream.disconnect(CLIENT);
    mcpUpstream.__setTransportFactoryForTesting(buildTransport);
  });

  test("listResources/readResource/listPrompts/getPrompt all return the real upstream's data, not the null/empty 'unavailable' shapes", async () => {
    const { client } = await connectClient({ kind: "client", name: CLIENT });
    try {
      const resources = await client.listResources();
      expect(resources.resources).toEqual([{ uri: "real://from-upstream", name: "Real Resource" }]);

      const read = (await client.readResource({ uri: "real://from-upstream" })) as {
        contents: Array<{ uri: string; text: string }>;
      };
      expect(read.contents[0]!.text).toBe("real-content:real://from-upstream");

      const prompts = await client.listPrompts();
      expect(prompts.prompts).toEqual([{ name: "real-prompt", description: "a real prompt from the fake upstream" }]);

      const prompt = (await client.getPrompt({ name: "real-prompt", arguments: {} })) as {
        messages: Array<{ content: { text: string } }>;
      };
      expect(prompt.messages[0]!.content.text).toBe("real-reply-to:real-prompt");
    } finally {
      await client.close();
    }
  });
});

// ===========================================================================
// notifyToolsChanged() — 256:44-264:2 / 257:39-263:4 / 258:9-260:6
// BlockStatement (whole function / for-loop body / try block emptied),
// 259:27-259:73 ObjectLiteral (the notification argument emptied to `{}`),
// 259:37-259:71 StringLiteral ("notifications/tools/list_changed" -> "").
// ===========================================================================

describe("notifyToolsChanged", () => {
  test("delivers the exact real notification method to a connected client", async () => {
    const { client } = await connectClient({ kind: "system" });
    try {
      const received: unknown[] = [];
      client.setNotificationHandler(ToolListChangedNotificationSchema, (n) => {
        received.push(n);
      });

      notifyToolsChanged();
      // InMemoryTransport delivery is effectively same-tick (send() calls the
      // peer's onmessage synchronously); a short real wait is generous
      // headroom without depending on exact microtask timing.
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(received).toHaveLength(1);
      expect((received[0] as { method: string }).method).toBe("notifications/tools/list_changed");
    } finally {
      await client.close();
    }
  });

  // Exercises the for-loop's resilience to one already-gone entry: by the
  // time notifyToolsChanged() runs below, server A has ALREADY been removed
  // from the module-level `activeServers` Set by its own `onclose` (fired
  // synchronously within the `await clientA.close()` chain — see
  // inMemory.js's close() awaiting the peer's close() before returning, and
  // mcp-server.ts's `server.onclose = () => activeServers.delete(server)`).
  // So this specifically proves: closed servers don't linger in the
  // iteration target, the loop doesn't stop/throw partway through, and the
  // still-open peer is unaffected by an unrelated server's teardown.
  test("a server closed before the call is cleanly absent from the notified set; the surviving client still gets exactly one notification and nothing throws", async () => {
    const { client: clientA } = await connectClient({ kind: "system" });
    const { client: clientB } = await connectClient({ kind: "system" });

    await clientA.close();

    let countB = 0;
    clientB.setNotificationHandler(ToolListChangedNotificationSchema, () => {
      countB++;
    });

    expect(() => notifyToolsChanged()).not.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(countB).toBe(1);

    await clientB.close();
  });
});
