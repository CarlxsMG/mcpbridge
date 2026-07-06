/**
 * Guard policy templates: CRUD + bulk application to tools / bundles.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { __resetDbForTesting } from "../../../db/connection.js";
import { registry } from "../../../mcp/registry.js";
import { createBundle } from "../../../admin/tool-composition/bundles.js";
import {
  createGuardPolicy,
  listGuardPolicies,
  updateGuardPolicy,
  deleteGuardPolicy,
  applyPolicyToTools,
  applyPolicyToBundle,
} from "../../../admin/entities/policies.js";
import { hashApiKey } from "../../../security/key-hash.js";
import type { RestToolDefinition } from "../../../mcp/types.js";

function makeTool(name: string): RestToolDefinition {
  return {
    name,
    method: "GET",
    endpoint: `/${name}`,
    description: "d",
    inputSchema: { type: "object", properties: {} },
  };
}
async function reg(name: string, tools: RestToolDefinition[]): Promise<void> {
  await registry.register(name, tools, "http://example.com/health", "1.2.3.4", "http://example.com", "1.2.3.4");
}

beforeEach(async () => {
  __resetDbForTesting();
  for (const c of registry.listClients()) await registry.unregister(c.name);
});
afterEach(async () => {
  for (const c of registry.listClients()) await registry.unregister(c.name);
});

describe("guard policies", () => {
  test("CRUD", () => {
    const p = createGuardPolicy({ name: "strict", rateLimitPerMin: 10, timeoutMs: 2000, actor: "t" });
    expect(listGuardPolicies()).toHaveLength(1);
    expect(updateGuardPolicy(p.id, { rateLimitPerMin: 20 })?.rateLimitPerMin).toBe(20);
    expect(deleteGuardPolicy(p.id)).toBe(true);
    expect(listGuardPolicies()).toHaveLength(0);
  });

  test("apply preserves the key allow-list while setting rate/timeout", async () => {
    await reg("svc", [makeTool("t")]);
    await registry.setToolGuards("svc", "t", { allowedKeyHashes: [hashApiKey("secret")] });
    const p = createGuardPolicy({ name: "strict", rateLimitPerMin: 10, timeoutMs: 2000, actor: null });

    const res = await applyPolicyToTools(p, [{ client: "svc", tool: "t" }]);
    expect(res.applied).toBe(1);

    const g = registry.resolveTool("svc__t")?.tool.guards;
    expect(g?.rateLimitPerMin).toBe(10);
    expect(g?.timeoutMs).toBe(2000);
    expect(g?.allowedKeyHashes).toEqual([hashApiKey("secret")]);
  });

  test("apply to a bundle covers all its tools", async () => {
    await reg("svc", [makeTool("a"), makeTool("b")]);
    await createBundle(
      "bnd",
      undefined,
      [
        { client: "svc", tool: "a" },
        { client: "svc", tool: "b" },
      ],
      "t",
    );
    const p = createGuardPolicy({ name: "p", rateLimitPerMin: 3, timeoutMs: null, actor: null });

    const res = await applyPolicyToBundle(p, "bnd");
    expect(res?.applied).toBe(2);
    expect(registry.resolveTool("svc__a")?.tool.guards?.rateLimitPerMin).toBe(3);
    expect(registry.resolveTool("svc__b")?.tool.guards?.rateLimitPerMin).toBe(3);
  });

  test("apply skips unknown tools", async () => {
    await reg("svc", [makeTool("t")]);
    const p = createGuardPolicy({ name: "p", rateLimitPerMin: 3, timeoutMs: null, actor: null });
    const res = await applyPolicyToTools(p, [{ client: "svc", tool: "nope" }]);
    expect(res.applied).toBe(0);
    expect(res.skipped).toHaveLength(1);
  });

  test("apply to an unknown bundle returns null", async () => {
    const p = createGuardPolicy({ name: "p", rateLimitPerMin: 3, timeoutMs: null, actor: null });
    expect(await applyPolicyToBundle(p, "ghost")).toBeNull();
  });
});
