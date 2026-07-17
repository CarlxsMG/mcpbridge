/**
 * Tool-annotation derivation (#16) and MCP-upstream annotation/outputSchema/title
 * passthrough (#15), verified through the registry's advertise path
 * (getMcpToolsForClient -> effectiveAdvertised -> deriveAnnotations).
 *
 * Annotations are advisory hints only — they COMPLEMENT proxyToolCall's
 * call-time enforcement, never replace it — so these tests assert only what is
 * ADVERTISED, not any change in what the gateway allows.
 */
import { describe, test, expect, beforeEach } from "bun:test";
import { registry } from "../../mcp/registry.js";
import { __resetDbForTesting } from "../../db/connection.js";
import { setToolSensitive } from "../../tool-meta/tool-sensitivity.js";
import { setApprovalRequired } from "../../admin/entities/approvals.js";
import type { RestToolDefinition, ToolAnnotations } from "../../mcp/types.js";
import type { DiscoveredMcpTool } from "../../mcp/mcp-discovery.js";

const HEALTH = "http://example.com/health";
const BASE = "http://example.com";
const IP = "1.2.3.4";

function restTool(overrides: Partial<RestToolDefinition> = {}): RestToolDefinition {
  return {
    name: "get-thing",
    method: "GET",
    endpoint: "/thing",
    description: "Reads a thing",
    inputSchema: { type: "object", properties: {} },
    ...overrides,
  };
}

/** Advertised annotations for one tool of one client (by unprefixed tool name). */
function annotationsFor(clientName: string, toolName: string): ToolAnnotations | undefined {
  const advertised = registry.getMcpToolsForClient(clientName).find((t) => t.name === `${clientName}__${toolName}`);
  return advertised?.annotations;
}

beforeEach(async () => {
  for (const client of registry.listClients()) await registry.unregister(client.name);
  __resetDbForTesting();
});

// ===========================================================================
// #16 — governance-derived annotations for REST tools
// ===========================================================================

describe("#16 REST method-derived annotations", () => {
  beforeEach(async () => {
    await registry.register(
      "svc",
      [
        restTool({ name: "read", method: "GET", endpoint: "/read" }),
        restTool({ name: "create", method: "POST", endpoint: "/create" }),
        restTool({ name: "replace", method: "PUT", endpoint: "/replace" }),
        restTool({ name: "remove", method: "DELETE", endpoint: "/remove" }),
      ],
      HEALTH,
      IP,
      BASE,
      IP,
    );
  });

  test("a GET-derived tool is readOnly + idempotent + openWorld", () => {
    expect(annotationsFor("svc", "read")).toEqual({
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: true,
    });
  });

  test("a POST tool is only openWorld (not read-only, not idempotent, not destructive)", () => {
    expect(annotationsFor("svc", "create")).toEqual({ openWorldHint: true });
  });

  test("PUT and DELETE are idempotent + openWorld (auto-gate off by default -> not destructive)", () => {
    expect(annotationsFor("svc", "replace")).toEqual({ idempotentHint: true, openWorldHint: true });
    expect(annotationsFor("svc", "remove")).toEqual({ idempotentHint: true, openWorldHint: true });
  });

  test("every advertised tool carries openWorldHint:true", () => {
    for (const t of registry.getMcpToolsForClient("svc")) {
      expect(t.annotations?.openWorldHint).toBe(true);
    }
  });
});

describe("#16 governance-derived destructive hint", () => {
  beforeEach(async () => {
    await registry.register(
      "svc",
      [
        restTool({ name: "read", method: "GET", endpoint: "/read" }),
        restTool({ name: "act", method: "POST", endpoint: "/act" }),
      ],
      HEALTH,
      IP,
      BASE,
      IP,
    );
  });

  test("an admin-flagged sensitive GET becomes destructive and NOT read-only", () => {
    expect(setToolSensitive("svc", "read", true)).toBe(true);
    expect(annotationsFor("svc", "read")).toEqual({
      readOnlyHint: false,
      idempotentHint: true,
      destructiveHint: true,
      openWorldHint: true,
    });
  });

  test("explicitly marking a tool non-sensitive leaves it non-destructive", () => {
    expect(setToolSensitive("svc", "act", false)).toBe(true);
    expect(annotationsFor("svc", "act")).toEqual({ openWorldHint: true });
  });

  test("an approval-required tool is marked destructive", () => {
    expect(setApprovalRequired("svc", "act", true)).toBe(true);
    const ann = annotationsFor("svc", "act");
    expect(ann?.destructiveHint).toBe(true);
    expect(ann?.readOnlyHint).toBe(false);
    expect(ann?.openWorldHint).toBe(true);
  });
});

// ===========================================================================
// #15 — MCP-upstream annotation / outputSchema / title passthrough
// ===========================================================================

describe("#15 MCP-upstream passthrough of annotations/outputSchema/title", () => {
  const mcpTool = (overrides: Partial<DiscoveredMcpTool> = {}): DiscoveredMcpTool => ({
    name: "fetch",
    upstreamName: "fetch",
    description: "Fetches data",
    inputSchema: { type: "object", properties: {} },
    ...overrides,
  });

  async function regMcp(tools: DiscoveredMcpTool[]): Promise<void> {
    await registry.registerMcp("up", tools, "http://mcp.test/mcp", "streamable-http", "127.0.0.1", "127.0.0.1");
  }

  test("upstream annotations are advertised (with openWorldHint filled in)", async () => {
    await regMcp([mcpTool({ annotations: { readOnlyHint: true, idempotentHint: true } })]);
    expect(annotationsFor("up", "fetch")).toEqual({
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: true,
    });
  });

  test("upstream outputSchema and title are advertised when present", async () => {
    const outputSchema = { type: "object", properties: { ok: { type: "boolean" } } };
    await regMcp([mcpTool({ outputSchema, title: "Fetch Data" })]);
    const advertised = registry.getMcpToolsForClient("up").find((t) => t.name === "up__fetch");
    expect(advertised?.outputSchema).toEqual(outputSchema);
    expect(advertised?.title).toBe("Fetch Data");
  });

  test("an MCP-upstream tool with no extras still gets governance annotations (openWorld only)", async () => {
    await regMcp([mcpTool()]);
    const advertised = registry.getMcpToolsForClient("up").find((t) => t.name === "up__fetch");
    expect(advertised?.annotations).toEqual({ openWorldHint: true });
    expect(advertised?.outputSchema).toBeUndefined();
    expect(advertised?.title).toBeUndefined();
  });

  test("governance sensitivity OVERRIDES an upstream read-only claim", async () => {
    await regMcp([mcpTool({ annotations: { readOnlyHint: true } })]);
    expect(setToolSensitive("up", "fetch", true)).toBe(true);
    // The upstream said read-only, but the admin flagged it sensitive — the
    // call-time-enforced property wins in the advertised hints.
    expect(annotationsFor("up", "fetch")).toEqual({
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: true,
    });
  });
});
