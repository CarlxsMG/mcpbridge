import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";

// Stryker mutation-testing backstop — cluster ST3 (src/mcp/system-tools.ts):
// the four smaller operate-tier tools, self-verified against the live source
// (the assignment brief's line numbers drifted slightly — these are the
// corrected ones):
//   - sys_set_client_enabled  L163-185
//   - sys_set_tool_enabled    L186-212
//   - sys_reset_circuit_breaker L213-231
//   - sys_delete_client       L281-302
// (sys_register_client, L233-280, is ST4's — the densest single tool, owned
// separately. Module-level helpers/dispatch, L1-85 + L370-427, are ST1's.)
//
// CORRECTION vs. the assignment brief: the brief assumed all four handlers
// here are `sensitive:false`. Re-reading the source shows `sys_delete_client`
// (L293) is in fact `sensitive: true` — the other three have no `sensitive`
// flag at all (falsy). This matters because `runSystemTool`'s outer
// sensitive/__confirm step-up gate (ST1's scope) runs BEFORE
// sys_delete_client's own handler body ever executes: every
// sys_delete_client call below passes `{__confirm: true}` in args so the
// call actually reaches L294-301's logic instead of being short-circuited by
// the gate with a generic "is sensitive" message (that gate itself, and its
// exact wording, is already covered by ST1 + the sibling
// system-tools.test.ts's HTTP-transport suite — not re-tested here).
//
// Driven directly through listSystemTools()/runSystemTool() (no HTTP/MCP
// transport), per the house convention set by system-tools-mutation-st1/
// st4.test.ts. recordAudit is spied (see st4.test.ts) so every handler's
// "audit fires on success only, never on failure" contract is pinned
// precisely, including the exact action string and target.
//
// Each describe cites the exact line(s) + mutator + replacement it targets.

import { listSystemTools, runSystemTool } from "../system-tools.js";
import { registry } from "../registry.js";
import { __resetDbForTesting } from "../../db/connection.js";
import * as auditMod from "../../admin/audit/audit.js";
import type { SystemAuthResult } from "../../security/system-role.js";
import type { RestToolDefinition } from "../types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Operator, non-elevated, non-env-bearer, keyId:7 by default — meets every
 * ST3 tool's "operate" tier requirement without tripping any sensitive gate
 * (none of the four are sensitive except sys_delete_client, which gets
 * `__confirm: true` in its args instead — see file header). */
function auth(overrides: Partial<SystemAuthResult> = {}): SystemAuthResult {
  return { role: "operator", elevated: false, keyId: 7, isEnvBearer: false, ...overrides };
}

function makeTool(overrides: Partial<RestToolDefinition> = {}): RestToolDefinition {
  return {
    name: "get-thing",
    method: "GET",
    endpoint: "/thing",
    description: "probe tool",
    inputSchema: { type: "object", properties: {} },
    ...overrides,
  };
}

async function reg(name: string, tools: RestToolDefinition[] = [makeTool()]): Promise<void> {
  await registry.register(name, tools, "http://example.com/health", "1.2.3.4", "http://example.com", "1.2.3.4");
}

let auditSpy: ReturnType<typeof spyOn>;

beforeEach(async () => {
  for (const c of registry.listClients()) await registry.unregister(c.name);
  __resetDbForTesting();
  auditSpy = spyOn(auditMod, "recordAudit").mockImplementation(() => {});
});

afterEach(() => {
  auditSpy.mockRestore();
});

// ---------------------------------------------------------------------------
// Bulk schema toEqual — closes every StringLiteral/ObjectLiteral/
// ArrayDeclaration/BooleanLiteral mutant on each tool's advertised
// name/description/inputSchema in one shot per tool: L163-172
// (sys_set_client_enabled), L187-197 (sys_set_tool_enabled), L214-220
// (sys_reset_circuit_breaker), L282-290 (sys_delete_client).
// ---------------------------------------------------------------------------

describe("ST3 tools — advertised schema (verbatim toEqual per tool)", () => {
  const tools = listSystemTools("admin");

  test("sys_set_client_enabled — exact name/description/inputSchema (L163-172)", () => {
    const tool = tools.find((t) => t.name === "sys_set_client_enabled");
    expect(tool).toEqual({
      name: "sys_set_client_enabled",
      description: "Enable or disable a registered client (all its tools become unreachable while disabled).",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string" },
          enabled: { type: "boolean" },
        },
        required: ["name", "enabled"],
        additionalProperties: false,
      },
    });
  });

  test("sys_set_tool_enabled — exact name/description/inputSchema (L187-197)", () => {
    const tool = tools.find((t) => t.name === "sys_set_tool_enabled");
    expect(tool).toEqual({
      name: "sys_set_tool_enabled",
      description: "Enable or disable a single tool on a registered client.",
      inputSchema: {
        type: "object",
        properties: {
          client: { type: "string" },
          tool: { type: "string" },
          enabled: { type: "boolean" },
        },
        required: ["client", "tool", "enabled"],
        additionalProperties: false,
      },
    });
  });

  test("sys_reset_circuit_breaker — exact name/description/inputSchema (L214-220)", () => {
    const tool = tools.find((t) => t.name === "sys_reset_circuit_breaker");
    expect(tool).toEqual({
      name: "sys_reset_circuit_breaker",
      description: "Force a live client's circuit breaker back to closed.",
      inputSchema: {
        type: "object",
        properties: { name: { type: "string" } },
        required: ["name"],
        additionalProperties: false,
      },
    });
  });

  test("sys_delete_client — exact name/description/inputSchema (L282-290)", () => {
    const tool = tools.find((t) => t.name === "sys_delete_client");
    expect(tool).toEqual({
      name: "sys_delete_client",
      description:
        "Permanently forget a registered client: tears down its live state and purges its SQLite config (tools, guards). " +
        'Destructive — pass {"__confirm": true} or use an elevated credential.',
      inputSchema: {
        type: "object",
        properties: { name: { type: "string" }, __confirm: { type: "boolean" } },
        required: ["name"],
        additionalProperties: false,
      },
    });
  });
});

// ---------------------------------------------------------------------------
// sys_set_client_enabled handler — L175-184
//   L178:11 LogicalOperator (`||` -> `&&`) on `!name || enabled === undefined`
//   L179    StringLiteral — the combined "Missing required argument: name,
//           enabled" message (fixed regardless of WHICH operand was missing)
//   L181    StringLiteral — "Client not found: ${name}"
//   L182    ConditionalExpression/StringLiteral — the ternary picking
//           "client.enable"/"client.disable" for recordAudit's action arg
//   L183    ConditionalExpression/StringLiteral — the ternary picking
//           "enabled"/"disabled" in the returned message
// ---------------------------------------------------------------------------

describe("sys_set_client_enabled — required-argument guard (L178/L179)", () => {
  test("name missing (enabled present) still yields the combined message and records no audit", async () => {
    const result = await runSystemTool("sys_set_client_enabled", { enabled: true }, auth());
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toBe("Missing required argument: name, enabled");
    expect(auditSpy).not.toHaveBeenCalled();
  });

  test("enabled missing (name present) still yields the combined message and records no audit — kills the `||`->`&&` mutant", async () => {
    // If L178's `||` were mutated to `&&`, this case (`!name` false, `enabled
    // === undefined` true) would evaluate to false and fall through to
    // registry.setClientEnabled("some-name", undefined as unknown as
    // boolean), producing a DIFFERENT message ("Client not found: ...")
    // instead of the missing-argument one.
    const result = await runSystemTool("sys_set_client_enabled", { name: "some-name" }, auth());
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toBe("Missing required argument: name, enabled");
    expect(auditSpy).not.toHaveBeenCalled();
  });

  test("both missing yields the same exact message and records no audit", async () => {
    const result = await runSystemTool("sys_set_client_enabled", {}, auth());
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toBe("Missing required argument: name, enabled");
    expect(auditSpy).not.toHaveBeenCalled();
  });
});

describe("sys_set_client_enabled — unknown client (L180/L181)", () => {
  test("a name with no registered client returns the exact not-found message and records no audit", async () => {
    const result = await runSystemTool("sys_set_client_enabled", { name: "st3-sce-ghost", enabled: false }, auth());
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toBe("Client not found: st3-sce-ghost");
    expect(auditSpy).not.toHaveBeenCalled();
  });
});

describe("sys_set_client_enabled — real toggle (L182/L183 ternaries, both directions)", () => {
  test("disabling a registered client persists enabled:false, audits 'client.disable', and returns the exact 'disabled' message", async () => {
    await reg("st3-sce-1");
    const result = await runSystemTool(
      "sys_set_client_enabled",
      { name: "st3-sce-1", enabled: false },
      auth({ keyId: 7 }),
    );
    expect(result.isError).toBeUndefined();
    expect(result.content[0]?.text).toBe("Client 'st3-sce-1' disabled");
    expect(registry.getClient("st3-sce-1")?.enabled).toBe(false);
    expect(auditSpy).toHaveBeenCalledTimes(1);
    expect(auditSpy.mock.calls[0]).toEqual(["mcp-key:7", "client.disable", "st3-sce-1"]);
  });

  test("re-enabling the same client persists enabled:true, audits 'client.enable' (not swapped), and returns the exact 'enabled' message", async () => {
    await reg("st3-sce-2");
    await runSystemTool("sys_set_client_enabled", { name: "st3-sce-2", enabled: false }, auth());
    auditSpy.mockClear();

    const result = await runSystemTool(
      "sys_set_client_enabled",
      { name: "st3-sce-2", enabled: true },
      auth({ keyId: 7 }),
    );
    expect(result.isError).toBeUndefined();
    expect(result.content[0]?.text).toBe("Client 'st3-sce-2' enabled");
    expect(registry.getClient("st3-sce-2")?.enabled).toBe(true);
    expect(auditSpy).toHaveBeenCalledTimes(1);
    expect(auditSpy.mock.calls[0]).toEqual(["mcp-key:7", "client.enable", "st3-sce-2"]);
  });
});

// ---------------------------------------------------------------------------
// sys_set_tool_enabled handler — L200-211
//   L204    LogicalOperator chain `!client || !tool || enabled === undefined`
//           — one isolated-true-operand test per operand, per the brief
//   L205    StringLiteral — the combined "Missing required argument: client,
//           tool, enabled" message
//   L208    StringLiteral — "Tool not found: ${client}__${tool}"
//   L209    ConditionalExpression/StringLiteral — "tool.enable"/"tool.disable"
//   L210    ConditionalExpression/StringLiteral — "enabled"/"disabled"
// ---------------------------------------------------------------------------

describe("sys_set_tool_enabled — required-argument guard, one operand isolated at a time (L204/L205)", () => {
  test("client missing (tool + enabled present) yields the combined message, records no audit", async () => {
    const result = await runSystemTool("sys_set_tool_enabled", { tool: "get-thing", enabled: true }, auth());
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toBe("Missing required argument: client, tool, enabled");
    expect(auditSpy).not.toHaveBeenCalled();
  });

  test("tool missing (client + enabled present) yields the combined message, records no audit", async () => {
    const result = await runSystemTool("sys_set_tool_enabled", { client: "st3-ste-x", enabled: true }, auth());
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toBe("Missing required argument: client, tool, enabled");
    expect(auditSpy).not.toHaveBeenCalled();
  });

  test("enabled missing (client + tool present) yields the combined message, records no audit", async () => {
    const result = await runSystemTool("sys_set_tool_enabled", { client: "st3-ste-x", tool: "get-thing" }, auth());
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toBe("Missing required argument: client, tool, enabled");
    expect(auditSpy).not.toHaveBeenCalled();
  });

  test("all three missing yields the same exact message, records no audit", async () => {
    const result = await runSystemTool("sys_set_tool_enabled", {}, auth());
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toBe("Missing required argument: client, tool, enabled");
    expect(auditSpy).not.toHaveBeenCalled();
  });
});

describe("sys_set_tool_enabled — unknown client/tool pair (L207/L208)", () => {
  test("an unregistered client yields the exact 'Tool not found: client__tool' message", async () => {
    const result = await runSystemTool(
      "sys_set_tool_enabled",
      { client: "st3-ste-ghost", tool: "get-thing", enabled: true },
      auth(),
    );
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toBe("Tool not found: st3-ste-ghost__get-thing");
    expect(auditSpy).not.toHaveBeenCalled();
  });

  test("a registered client with a nonexistent tool name yields the same exact message shape", async () => {
    await reg("st3-ste-1");
    const result = await runSystemTool(
      "sys_set_tool_enabled",
      { client: "st3-ste-1", tool: "no-such-tool", enabled: true },
      auth(),
    );
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toBe("Tool not found: st3-ste-1__no-such-tool");
    expect(auditSpy).not.toHaveBeenCalled();
  });
});

describe("sys_set_tool_enabled — real toggle, both directions (L209/L210 ternaries) + fully-valid call proceeds past L204", () => {
  test("disabling a registered tool persists enabled:false, audits 'tool.disable', and returns the exact 'disabled' message", async () => {
    await reg("st3-ste-2", [makeTool({ name: "get-thing" })]);
    const result = await runSystemTool(
      "sys_set_tool_enabled",
      { client: "st3-ste-2", tool: "get-thing", enabled: false },
      auth({ keyId: 7 }),
    );
    expect(result.isError).toBeUndefined();
    expect(result.content[0]?.text).toBe("Tool 'st3-ste-2__get-thing' disabled");
    expect(registry.getClient("st3-ste-2")?.tools.find((t) => t.name === "get-thing")?.enabled).toBe(false);
    expect(auditSpy).toHaveBeenCalledTimes(1);
    expect(auditSpy.mock.calls[0]).toEqual(["mcp-key:7", "tool.disable", "st3-ste-2__get-thing"]);
  });

  test("re-enabling the same tool persists enabled:true, audits 'tool.enable' (not swapped), and returns the exact 'enabled' message", async () => {
    await reg("st3-ste-3", [makeTool({ name: "get-thing" })]);
    await runSystemTool("sys_set_tool_enabled", { client: "st3-ste-3", tool: "get-thing", enabled: false }, auth());
    auditSpy.mockClear();

    const result = await runSystemTool(
      "sys_set_tool_enabled",
      { client: "st3-ste-3", tool: "get-thing", enabled: true },
      auth({ keyId: 7 }),
    );
    expect(result.isError).toBeUndefined();
    expect(result.content[0]?.text).toBe("Tool 'st3-ste-3__get-thing' enabled");
    expect(registry.getClient("st3-ste-3")?.tools.find((t) => t.name === "get-thing")?.enabled).toBe(true);
    expect(auditSpy).toHaveBeenCalledTimes(1);
    expect(auditSpy.mock.calls[0]).toEqual(["mcp-key:7", "tool.enable", "st3-ste-3__get-thing"]);
  });
});

// ---------------------------------------------------------------------------
// sys_reset_circuit_breaker handler — L223-230
//   L225 StringLiteral — "Missing required argument: name"
//   L226 ConditionalExpression on `!ok` (registry.resetCircuitBreaker's
//        boolean result) + L227 StringLiteral — "Client is not currently
//        live: ${name}"
//   L228 StringLiteral — the "client.circuit_breaker.reset" audit action
//   L229 StringLiteral — "Circuit breaker reset for '${name}'"
// ---------------------------------------------------------------------------

describe("sys_reset_circuit_breaker — required-argument guard (L225)", () => {
  test("missing name returns the exact message and records no audit", async () => {
    const result = await runSystemTool("sys_reset_circuit_breaker", {}, auth());
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toBe("Missing required argument: name");
    expect(auditSpy).not.toHaveBeenCalled();
  });
});

describe("sys_reset_circuit_breaker — not-live client (L226/L227)", () => {
  test("a name that was never registered returns the exact not-live message, records no audit", async () => {
    const result = await runSystemTool("sys_reset_circuit_breaker", { name: "st3-rcb-ghost" }, auth());
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toBe("Client is not currently live: st3-rcb-ghost");
    expect(auditSpy).not.toHaveBeenCalled();
  });

  test("a client that WAS registered but was then unregistered also returns the exact not-live message (proves the check is live-state, not DB-existence)", async () => {
    await reg("st3-rcb-2");
    await registry.unregister("st3-rcb-2");
    const result = await runSystemTool("sys_reset_circuit_breaker", { name: "st3-rcb-2" }, auth());
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toBe("Client is not currently live: st3-rcb-2");
    expect(auditSpy).not.toHaveBeenCalled();
  });
});

describe("sys_reset_circuit_breaker — live client success path (L228/L229)", () => {
  test("a live client resets successfully, audits 'client.circuit_breaker.reset', and returns the exact message", async () => {
    await reg("st3-rcb-3");
    const result = await runSystemTool("sys_reset_circuit_breaker", { name: "st3-rcb-3" }, auth({ keyId: 7 }));
    expect(result.isError).toBeUndefined();
    expect(result.content[0]?.text).toBe("Circuit breaker reset for 'st3-rcb-3'");
    expect(auditSpy).toHaveBeenCalledTimes(1);
    expect(auditSpy.mock.calls[0]).toEqual(["mcp-key:7", "client.circuit_breaker.reset", "st3-rcb-3"]);
  });
});

// ---------------------------------------------------------------------------
// sys_delete_client handler — L294-301 (tool is `sensitive: true` at L293 —
// see file-header CORRECTION note; every call below passes {__confirm: true}
// to reach this logic at all).
//   L296 StringLiteral — "Missing required argument: name"
//   L297 registry.forgetClient(name) call + L298 StringLiteral — "Client not
//        found: ${name}"
//   L299 StringLiteral — the "client.delete" audit action
//   L300 StringLiteral — "Client '${name}' deleted"
// ---------------------------------------------------------------------------

describe("sys_delete_client — required-argument guard (L296)", () => {
  test("missing name (with __confirm to clear the sensitive gate) returns the exact message, records no audit", async () => {
    const result = await runSystemTool("sys_delete_client", { __confirm: true }, auth());
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toBe("Missing required argument: name");
    expect(auditSpy).not.toHaveBeenCalled();
  });
});

describe("sys_delete_client — unknown client (L297/L298)", () => {
  test("a name with no registered client returns the exact not-found message, records no audit", async () => {
    const result = await runSystemTool("sys_delete_client", { name: "st3-del-ghost", __confirm: true }, auth());
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toBe("Client not found: st3-del-ghost");
    expect(auditSpy).not.toHaveBeenCalled();
  });
});

describe("sys_delete_client — real client is actually purged, live AND persisted (L299/L300)", () => {
  test("deleting a registered client removes it from the live registry and from SQLite, audits 'client.delete', and returns the exact message", async () => {
    await reg("st3-del-1");
    // Sanity: both read models see it before deletion.
    expect(registry.getClient("st3-del-1")).toBeDefined();
    expect(registry.getClientDetail("st3-del-1")).toBeDefined();

    const result = await runSystemTool("sys_delete_client", { name: "st3-del-1", __confirm: true }, auth({ keyId: 7 }));
    expect(result.isError).toBeUndefined();
    expect(result.content[0]?.text).toBe("Client 'st3-del-1' deleted");

    // Gone from the in-memory live registry...
    expect(registry.getClient("st3-del-1")).toBeUndefined();
    // ...AND its SQLite row is purged (getClientDetail reads straight from
    // SQL — per forgetClient's contract of destroying durable config, unlike
    // unregister()'s live-only teardown).
    expect(registry.getClientDetail("st3-del-1")).toBeUndefined();

    expect(auditSpy).toHaveBeenCalledTimes(1);
    expect(auditSpy.mock.calls[0]).toEqual(["mcp-key:7", "client.delete", "st3-del-1"]);
  });
});
