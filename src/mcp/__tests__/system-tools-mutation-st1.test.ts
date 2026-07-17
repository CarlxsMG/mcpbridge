import { describe, test, expect, beforeEach, spyOn } from "bun:test";

// Stryker mutation-testing backstop — cluster ST1 (src/mcp/system-tools.ts):
//   (a) module-level helpers, L1-85: ROLE_RANK/TIER_RANK, roleMeetsTier,
//       actorFor, and the str/num/bool/json arg-coercion helpers (shared by
//       every other system-tools cluster's tool handlers — killed here once).
//   (b) the security-critical dispatch/auth path, L370-427: listSystemTools'
//       tier filter and runSystemTool's tier gate, sensitive/__confirm
//       step-up gate, envBearerOnly restriction, and catch-all error handler.
//
// Unlike the sibling system-tools.test.ts (real MCP JSON-RPC handshake over
// HTTP), everything here calls listSystemTools/runSystemTool directly with a
// hand-built SystemAuthResult — no transport, no session.
//
// House convention (see src/mcp/__tests__/registry-mutation-rc9.test.ts):
// fresh in-memory SQLite + a fully drained live registry before every test.

import { listSystemTools, runSystemTool } from "../system-tools.js";
import { registry } from "../registry.js";
import { __resetDbForTesting } from "../../db/connection.js";
import { listAuditLog } from "../../admin/audit/audit.js";
import * as loggerMod from "../../logger.js";
import type { SystemAuthResult } from "../../security/system-role.js";
import type { RestToolDefinition } from "../types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Admin/elevated/env-bearer by default — override per test to exercise a specific gate. */
function auth(overrides: Partial<SystemAuthResult> = {}): SystemAuthResult {
  return { role: "admin", elevated: true, keyId: 1, isEnvBearer: false, ...overrides };
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

beforeEach(async () => {
  for (const c of registry.listClients()) await registry.unregister(c.name);
  __resetDbForTesting();
});

// ---------------------------------------------------------------------------
// (a) Module-level helpers — L1-85
// ---------------------------------------------------------------------------

describe("actorFor (L52:54 StringLiteral->'``')", () => {
  test("non-env-bearer branch renders the audit actor as exactly 'mcp-key:<id>'", async () => {
    await reg("svc-actor");
    const result = await runSystemTool(
      "sys_set_client_enabled",
      { name: "svc-actor", enabled: false },
      auth({ isEnvBearer: false, keyId: 42, elevated: false, role: "operator" }),
    );
    expect(result.isError).toBeUndefined();

    const log = listAuditLog({ limit: 1 });
    // If the template literal is gutted to '``', the actor collapses to "" —
    // this pins it to the exact non-empty "mcp-key:42" string.
    expect(log.items[0]?.actor).toBe("mcp-key:42");
  });

  test("env-bearer branch is unaffected (guards against the fix reading as equivalent)", async () => {
    await reg("svc-actor-2");
    const result = await runSystemTool(
      "sys_set_client_enabled",
      { name: "svc-actor-2", enabled: false },
      auth({ isEnvBearer: true, keyId: null, elevated: true, role: "admin" }),
    );
    expect(result.isError).toBeUndefined();

    const log = listAuditLog({ limit: 1 });
    expect(log.items[0]?.actor).toBe("bearer:admin-api-key");
  });
});

describe("bool() (L74:10 ConditionalExpression->false)", () => {
  test("a string 'true' is NOT coerced to a boolean — the handler must treat 'enabled' as missing", async () => {
    await reg("svc-bool");
    // If `bool()` were mutated to `return false;` unconditionally, `enabled`
    // would resolve to `false` (a real boolean, not `undefined`), the
    // `enabled === undefined` missing-argument check would NOT fire, and the
    // client would be silently disabled instead of the call being rejected.
    const result = await runSystemTool(
      "sys_set_client_enabled",
      { name: "svc-bool", enabled: "true" },
      auth({ role: "operator", elevated: false, isEnvBearer: false }),
    );
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe("Missing required argument: name, enabled");

    // And prove the client was untouched (mutant would have disabled it).
    const detail = registry.getClientDetail("svc-bool");
    expect(detail?.enabled).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// (b) Dispatch/auth — L370-427
// ---------------------------------------------------------------------------

describe("listSystemTools tier filter (L384:53 BlockStatement->'{}')", () => {
  test("viewer sees only read-tier tools; admin sees every tier", () => {
    const viewerNames = listSystemTools("viewer").map((t) => t.name);
    expect(viewerNames).toContain("sys_list_clients"); // read tier
    expect(viewerNames).not.toContain("sys_register_client"); // operate tier
    expect(viewerNames).not.toContain("sys_mint_key"); // admin tier

    const adminNames = listSystemTools("admin").map((t) => t.name);
    expect(adminNames).toContain("sys_list_clients");
    expect(adminNames).toContain("sys_register_client");
    expect(adminNames).toContain("sys_mint_key");

    // If the filter's body were emptied (`.filter((t) => {})` -> always
    // falsy-ish/undefined -> Array.prototype.filter treats a function that
    // never returns a truthy value as "keep nothing"), viewer AND admin would
    // both collapse to an empty (or identically-sized) list; asserting the
    // counts actually differ closes that gap.
    expect(adminNames.length).toBeGreaterThan(viewerNames.length);
  });
});

describe("runSystemTool — unknown tool name", () => {
  test("returns 'Unknown tool: <name>' with isError:true", async () => {
    const result = await runSystemTool("nonexistent_tool", {}, auth());
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe("Unknown tool: nonexistent_tool");
  });
});

describe("runSystemTool — tier gate (L395:7/32/57/68)", () => {
  test("a role below the tool's tier gets the exact 'requires the <tier> tier or higher' message", async () => {
    const result = await runSystemTool(
      "sys_mint_key",
      { label: "x" },
      auth({ role: "viewer", elevated: false, isEnvBearer: false }),
    );
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe("Tool 'sys_mint_key' requires the 'admin' tier or higher");
  });

  test("a role that meets the tier proceeds past this guard (reaches the next gate, not the tier error)", async () => {
    // "operator" meets sys_delete_client's "operate" tier requirement; the
    // call must NOT be rejected with a tier message — it should instead hit
    // the sensitive/__confirm gate next (proven by a distinct message).
    const result = await runSystemTool(
      "sys_delete_client",
      { name: "does-not-exist" },
      auth({ role: "operator", elevated: false, isEnvBearer: false }),
    );
    expect(result.content[0].text).not.toContain("requires the");
    expect(result.content[0].text).toContain("is sensitive");
  });
});

describe("runSystemTool — sensitive/__confirm step-up outer guard (L415:17)", () => {
  test("guard fires: non-elevated, non-confirmed call to a sensitive tool is rejected", async () => {
    const result = await runSystemTool(
      "sys_delete_client",
      { name: "nobody" },
      auth({ role: "operator", elevated: false, isEnvBearer: false }),
    );
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("is sensitive");
  });

  test("guard is skipped for an elevated caller (no __confirm needed) — proceeds to the real handler", async () => {
    const result = await runSystemTool(
      "sys_delete_client",
      { name: "nobody" },
      auth({ role: "operator", elevated: true, isEnvBearer: false }),
    );
    expect(result.content[0].text).not.toContain("is sensitive");
    // Proceeds all the way to the handler, which fails for an unrelated
    // (client-not-found) reason — proving it cleared THIS guard specifically.
    expect(result.content[0].text).toBe("Client not found: nobody");
  });

  test("guard is skipped when __confirm:true is passed explicitly — proceeds to the real handler", async () => {
    const result = await runSystemTool(
      "sys_delete_client",
      { name: "nobody", __confirm: true },
      auth({ role: "operator", elevated: false, isEnvBearer: false }),
    );
    expect(result.content[0].text).not.toContain("is sensitive");
    expect(result.content[0].text).toBe("Client not found: nobody");
  });
});

describe("runSystemTool — sensitive-gate exact message/shape (L421:9/18/63)", () => {
  test("rejection carries the exact wording and isError:true", async () => {
    const result = await runSystemTool(
      "sys_delete_client",
      { name: "nobody" },
      auth({ role: "operator", elevated: false, isEnvBearer: false }),
    );
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe(
      `Tool 'sys_delete_client' is sensitive — pass {"__confirm": true} in arguments or call with an elevated key.`,
    );
  });
});

describe("runSystemTool — envBearerOnly gate (L423:35, L425:23/72)", () => {
  test("a non-env-bearer admin key is rejected with isError:true and the exact message", async () => {
    const result = await runSystemTool(
      "sys_mint_key",
      { label: "escalate", __confirm: true },
      auth({ role: "admin", elevated: true, isEnvBearer: false }),
    );
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe("Tool 'sys_mint_key' requires the environment admin Bearer credential");
  });

  test("the env Bearer proceeds past this guard and the call succeeds", async () => {
    const result = await runSystemTool(
      "sys_mint_key",
      { label: "ok", __confirm: true },
      auth({ role: "admin", elevated: true, isEnvBearer: true, keyId: null }),
    );
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).not.toContain("requires the environment admin Bearer credential");
    expect(JSON.parse(result.content[0].text ?? "")).toMatchObject({ label: "ok" });
  });
});

describe("runSystemTool — catch-all error handler (L413-426)", () => {
  test("a thrown handler error is logged and never echoed verbatim to the caller", async () => {
    const err = new Error("boom-from-db");
    const summarySpy = spyOn(registry, "listClientsSummary").mockImplementation(() => {
      throw err;
    });
    const logSpy = spyOn(loggerMod, "log").mockImplementation(() => {});
    try {
      const result = await runSystemTool("sys_list_clients", {}, auth());

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toBe("Tool 'sys_list_clients' failed unexpectedly");
      expect(result.content[0].text).not.toContain("boom-from-db");

      expect(logSpy).toHaveBeenCalledTimes(1);
      const [level, message, meta] = logSpy.mock.calls[0] as [string, string, Record<string, unknown>];
      expect(level).toBe("error");
      expect(message).toBe("System tool 'sys_list_clients' failed unexpectedly");
      expect(meta).toMatchObject({ tool: "sys_list_clients" });
      expect(meta.err).toMatchObject({ message: "boom-from-db", name: "Error" });
      expect((meta.err as { stack?: string }).stack).toEqual(expect.any(String));
    } finally {
      summarySpy.mockRestore();
      logSpy.mockRestore();
    }
  });
});
