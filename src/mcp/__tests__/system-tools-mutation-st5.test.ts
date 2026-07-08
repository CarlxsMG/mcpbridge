import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";

// Stryker mutation-testing backstop — cluster ST5 (src/mcp/system-tools.ts,
// the 2 ADMIN-TIER tools): `sys_mint_key` (L306-347) and `sys_revoke_key`
// (L348-369) — the most security-sensitive single operation in this file
// (minting a brand-new managed MCP API key) plus its revocation counterpart.
//
// Line numbers below were re-verified against the current source by direct
// read before writing any test (they matched the task brief's numbers
// exactly). Each test/comment cites the exact line(s) + mutator category it
// targets, per the house convention established across the P2/PX/registry-
// mutation-rc/registration-mutation-rg series (see stryker.config.mjs's SCOPE
// HISTORY) and this file's siblings (system-tools-mutation-st1/st4.test.ts).
// Exact mutant *columns* are not cited (no live Stryker dry-run was captured
// for this cluster) — only line ranges + the mutator kind, reasoned directly
// from source.
//
// Scope boundary: `runSystemTool`'s own gating (tier check, `envBearerOnly`,
// the `sensitive`/`__confirm` step-up gate) is ST1's territory, not ours.
// Every test here uses a credential that already clears ALL of those gates
// for both tools (role:"admin", elevated:true, isEnvBearer:true — the last
// one specifically because `sys_mint_key` is `envBearerOnly:true`) so every
// call lands directly inside the handler body. `createMcpKey`/`revokeMcpKey`/
// `getMcpKey` are real (backed by a fresh in-memory SQLite per test via
// `__resetDbForTesting`) — spied only where a test needs to observe the exact
// arguments a handler passes them, always with call-through (`spyOn` without
// `mockImplementation` still invokes the real implementation, per this
// codebase's established pattern — see registry-mutation-rc3.test.ts's
// `sanitizeToolDescription` spy).

import { listSystemTools, runSystemTool } from "../system-tools.js";
import { __resetDbForTesting } from "../../db/connection.js";
import * as mcpKeyStoreMod from "../../security/mcp-key-store.js";
import * as auditMod from "../../admin/audit/audit.js";
import type { SystemAuthResult } from "../../security/system-role.js";
import type { McpKeyScopes } from "../../security/mcp-key-store.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Clears every one of runSystemTool's gates for BOTH admin-tier tools:
 * role:"admin" satisfies the tier check; elevated:true satisfies the
 * sensitive/__confirm step-up (for both tools); isEnvBearer:true satisfies
 * sys_mint_key's envBearerOnly restriction (sys_revoke_key doesn't check it,
 * so it's harmless there). actorFor(auth) for this credential resolves to
 * the literal "bearer:admin-api-key" (the isEnvBearer branch) — hardcoded in
 * the expectations below since actorFor() itself is private or intended to
 * remain untested here (ST1's territory).
 */
const ADMIN_AUTH: SystemAuthResult = { role: "admin", elevated: true, keyId: null, isEnvBearer: true };
const EXPECTED_ACTOR = "bearer:admin-api-key";

beforeEach(() => {
  __resetDbForTesting();
});

// ---------------------------------------------------------------------------
// Bulk schema toEqual — closes L306-321 (sys_mint_key: description
// StringLiterals, inputSchema ObjectLiteral/properties, `required`
// ArrayDeclaration, `additionalProperties` BooleanLiteral, the `adminRole`
// enum ArrayDeclaration) and L348-357 (sys_revoke_key: same cluster) in one
// shot — any mutation to either advertised schema/description changes this
// object, so toEqual against the exact verbatim transcription from source is
// a single dense assertion per tool.
// ---------------------------------------------------------------------------

describe("listSystemTools('admin') — sys_mint_key / sys_revoke_key exact schema (L306-321, L348-357)", () => {
  test("sys_mint_key — exact {name, description, inputSchema}", () => {
    const tools = listSystemTools("admin");
    const tool = tools.find((t) => t.name === "sys_mint_key");
    expect(tool).toEqual({
      name: "sys_mint_key",
      description:
        "Mint a new managed MCP API key. Requires the environment admin Bearer credential specifically — no managed key, " +
        'however privileged, may mint another (no self-escalation). Destructive/sensitive: pass {"__confirm": true}.',
      inputSchema: {
        type: "object",
        properties: {
          label: { type: "string" },
          scopes: { type: "object", description: "{clients?: string[], tools?: string[]} — omit for unrestricted." },
          expiresAt: { type: "number", description: "Epoch ms, or omit for no expiry." },
          elevated: { type: "boolean" },
          adminRole: { type: "string", enum: ["admin", "operator", "auditor", "viewer"] },
          __confirm: { type: "boolean" },
        },
        required: ["label"],
        additionalProperties: false,
      },
    });
  });

  test("sys_revoke_key — exact {name, description, inputSchema}", () => {
    const tools = listSystemTools("admin");
    const tool = tools.find((t) => t.name === "sys_revoke_key");
    expect(tool).toEqual({
      name: "sys_revoke_key",
      description:
        'Revoke a managed MCP API key by id. Destructive: pass {"__confirm": true} or use an elevated credential.',
      inputSchema: {
        type: "object",
        properties: { id: { type: "number" }, __confirm: { type: "boolean" } },
        required: ["id"],
        additionalProperties: false,
      },
    });
  });
});

// ---------------------------------------------------------------------------
// sys_mint_key handler — L326-347
// ---------------------------------------------------------------------------

// L328 — `if (!label) return toolResult("Missing required argument: label", {isError:true});`
describe("sys_mint_key — L328 missing/empty label", () => {
  test("label omitted entirely -> exact 'Missing required argument: label' error", async () => {
    const result = await runSystemTool("sys_mint_key", {}, ADMIN_AUTH);
    expect(result).toEqual({ isError: true, content: [{ type: "text", text: "Missing required argument: label" }] });
  });

  test("label as an empty string -> exact same error (str() found a string, but `!label` still rejects it)", async () => {
    const result = await runSystemTool("sys_mint_key", { label: "" }, ADMIN_AUTH);
    expect(result).toEqual({ isError: true, content: [{ type: "text", text: "Missing required argument: label" }] });
  });
});

// L330-331 — `const scopes: McpKeyScopes | null = scopesRaw && typeof scopesRaw
// === "object" && !Array.isArray(scopesRaw) ? (scopesRaw as McpKeyScopes) : null;`
// Four cases fully pin this triple-AND ConditionalExpression.
describe("sys_mint_key — L330-331 scopes triple-AND resolution", () => {
  let createSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    createSpy = spyOn(mcpKeyStoreMod, "createMcpKey");
  });

  afterEach(() => {
    createSpy.mockRestore();
  });

  test("scopes omitted entirely -> createMcpKey receives scopes=null", async () => {
    await runSystemTool("sys_mint_key", { label: "k-scopes-omitted" }, ADMIN_AUTH);
    expect(createSpy).toHaveBeenCalledWith("k-scopes-omitted", null, null, EXPECTED_ACTOR, null, false, null);
  });

  test("scopes as an array ([]) -> createMcpKey receives scopes=null (the !Array.isArray guard, not just typeof)", async () => {
    await runSystemTool("sys_mint_key", { label: "k-scopes-array", scopes: [] }, ADMIN_AUTH);
    expect(createSpy).toHaveBeenCalledWith("k-scopes-array", null, null, EXPECTED_ACTOR, null, false, null);
  });

  test("scopes as a non-object primitive (string) -> createMcpKey receives scopes=null", async () => {
    await runSystemTool("sys_mint_key", { label: "k-scopes-string", scopes: "not-an-object" }, ADMIN_AUTH);
    expect(createSpy).toHaveBeenCalledWith("k-scopes-string", null, null, EXPECTED_ACTOR, null, false, null);
  });

  test("scopes as a real object -> passed through as-is to createMcpKey", async () => {
    const scopes: McpKeyScopes = { clients: ["x"] };
    await runSystemTool("sys_mint_key", { label: "k-scopes-real", scopes }, ADMIN_AUTH);
    expect(createSpy).toHaveBeenCalledWith("k-scopes-real", scopes, null, EXPECTED_ACTOR, null, false, null);
  });
});

// L337 — `num(args,"expiresAt") ?? null`
describe("sys_mint_key — L337 expiresAt ?? null", () => {
  let createSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    createSpy = spyOn(mcpKeyStoreMod, "createMcpKey");
  });

  afterEach(() => {
    createSpy.mockRestore();
  });

  test("a numeric expiresAt is passed through unchanged", async () => {
    await runSystemTool("sys_mint_key", { label: "k-exp-set", expiresAt: 1750000000000 }, ADMIN_AUTH);
    expect(createSpy).toHaveBeenCalledWith("k-exp-set", null, 1750000000000, EXPECTED_ACTOR, null, false, null);
  });

  test("expiresAt omitted -> createMcpKey receives exactly null, not undefined", async () => {
    await runSystemTool("sys_mint_key", { label: "k-exp-omitted" }, ADMIN_AUTH);
    expect(createSpy).toHaveBeenCalledWith("k-exp-omitted", null, null, EXPECTED_ACTOR, null, false, null);
    // Belt-and-braces: toHaveBeenCalledWith's equality treats a missing arg
    // and an explicit `undefined` arg as equivalent, so pin the raw value too.
    const call = createSpy.mock.calls[0] as unknown[];
    expect(call[2]).toBeNull();
    expect(call[2]).not.toBeUndefined();
  });
});

// L340 — `bool(args,"elevated") ?? false`. Three cases pin the StringLiteral
// arg-name ("elevated") and the BooleanLiteral default (false).
//
// NOTE on a suspected-equivalent LogicalOperator mutant (`??` -> `||`) at
// this exact spot: empirically verified equivalent via a standalone
// simulation (`bool()` can only ever return true/false/undefined, and the
// fallback literal is `false` — the one case where `??` and `||` diverge in
// general, a defined *falsy* left value, is `false` here, and `false ?? false
// === false || false === false`). No input can distinguish `?? false` from
// `|| false` for this declaration; the 3 cases below still kill the
// StringLiteral and BooleanLiteral mutants at the same node.
describe("sys_mint_key — L340 elevated ?? false default", () => {
  let createSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    createSpy = spyOn(mcpKeyStoreMod, "createMcpKey");
  });

  afterEach(() => {
    createSpy.mockRestore();
  });

  test("elevated:true is passed through as true", async () => {
    await runSystemTool("sys_mint_key", { label: "k-elevated-true", elevated: true }, ADMIN_AUTH);
    expect(createSpy).toHaveBeenCalledWith("k-elevated-true", null, null, EXPECTED_ACTOR, null, true, null);
  });

  test("elevated:false is passed through as false", async () => {
    await runSystemTool("sys_mint_key", { label: "k-elevated-false", elevated: false }, ADMIN_AUTH);
    expect(createSpy).toHaveBeenCalledWith("k-elevated-false", null, null, EXPECTED_ACTOR, null, false, null);
  });

  test("elevated omitted -> defaults to exactly false, not true", async () => {
    await runSystemTool("sys_mint_key", { label: "k-elevated-omitted" }, ADMIN_AUTH);
    expect(createSpy).toHaveBeenCalledWith("k-elevated-omitted", null, null, EXPECTED_ACTOR, null, false, null);
  });
});

// L332-333 + L343 — `const adminRoleRaw = args.adminRole; const adminRole =
// isAdminRole(adminRoleRaw) ? adminRoleRaw : null;` then `recordAudit(...,
// {label, adminRole: adminRole ?? undefined})`. Pins both createMcpKey's
// 7th positional arg AND the audit meta's exact `undefined`-vs-`null`
// distinction.
describe("sys_mint_key — L332-333/343 adminRole resolution + audit meta ?? undefined", () => {
  let createSpy: ReturnType<typeof spyOn>;
  let auditSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    createSpy = spyOn(mcpKeyStoreMod, "createMcpKey");
    auditSpy = spyOn(auditMod, "recordAudit");
  });

  afterEach(() => {
    createSpy.mockRestore();
    auditSpy.mockRestore();
  });

  test("a valid adminRole string ('operator') is passed through to createMcpKey AND appears verbatim in the audit meta", async () => {
    const record = await runSystemTool("sys_mint_key", { label: "k-role-valid", adminRole: "operator" }, ADMIN_AUTH);
    expect(record.isError).toBeUndefined();
    expect(createSpy).toHaveBeenCalledWith("k-role-valid", null, null, EXPECTED_ACTOR, null, false, "operator");
    expect(auditSpy).toHaveBeenCalledWith(EXPECTED_ACTOR, "mcp_key.create", expect.any(String), {
      label: "k-role-valid",
      adminRole: "operator",
    });
  });

  test("an invalid/garbage adminRole string ('superuser') resolves to null for createMcpKey but undefined (not null) in the audit meta", async () => {
    const result = await runSystemTool("sys_mint_key", { label: "k-role-invalid", adminRole: "superuser" }, ADMIN_AUTH);
    expect(result.isError).toBeUndefined();
    expect(createSpy).toHaveBeenCalledWith("k-role-invalid", null, null, EXPECTED_ACTOR, null, false, null);
    const call = auditSpy.mock.calls[0] as unknown[];
    expect(call[1]).toBe("mcp_key.create");
    const meta = call[3] as Record<string, unknown>;
    expect(meta).toEqual({ label: "k-role-invalid", adminRole: undefined });
    expect(meta.adminRole).toBeUndefined();
    expect("adminRole" in meta).toBe(true);
  });

  test("no adminRole at all -> same as invalid: null to createMcpKey, undefined in audit meta", async () => {
    const result = await runSystemTool("sys_mint_key", { label: "k-role-absent" }, ADMIN_AUTH);
    expect(result.isError).toBeUndefined();
    expect(createSpy).toHaveBeenCalledWith("k-role-absent", null, null, EXPECTED_ACTOR, null, false, null);
    const call = auditSpy.mock.calls[0] as unknown[];
    const meta = call[3] as Record<string, unknown>;
    expect(meta.adminRole).toBeUndefined();
  });
});

// L343 target id + L344-345 — the audit target is `String(record.id)` (a
// real, freshly-minted key's numeric id turned into a string), and the
// response is `json({...record, key: rawKey})` — the ONE place the raw key
// is ever exposed.
describe("sys_mint_key — L343 audit target is String(record.id); L344-345 raw key exposure", () => {
  test("the response JSON contains both the real record's own fields AND a `key` field with the raw key, and the audit target is the record id as a string", async () => {
    const auditSpy = spyOn(auditMod, "recordAudit");
    try {
      const result = await runSystemTool("sys_mint_key", { label: "k-full-response" }, ADMIN_AUTH);
      expect(result.isError).toBeUndefined();
      const body = JSON.parse(result.content[0]!.text) as Record<string, unknown>;

      expect(body.label).toBe("k-full-response");
      expect(typeof body.id).toBe("number");
      expect(typeof body.key).toBe("string");
      expect((body.key as string).startsWith("mcp_")).toBe(true);

      // Cross-check against the real stored record: the raw key is NEVER
      // persisted, but its prefix is — confirms `record` really is the DB
      // row (not some stand-in) and `key` really is the one-time raw secret.
      const stored = mcpKeyStoreMod.getMcpKey(body.id as number);
      expect(stored).not.toBeNull();
      expect(stored?.label).toBe("k-full-response");
      expect(stored?.keyPrefix).toBe((body.key as string).slice(0, 12));

      expect(auditSpy).toHaveBeenCalledWith(EXPECTED_ACTOR, "mcp_key.create", String(body.id), {
        label: "k-full-response",
        adminRole: undefined,
      });
    } finally {
      auditSpy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// sys_revoke_key handler — L360-368
// ---------------------------------------------------------------------------

// L361 — `if (id === undefined) return toolResult("Missing required argument: id", {isError:true});`
// The check is `=== undefined`, not a truthiness check — `id:0` must NOT be
// treated as missing.
describe("sys_revoke_key — L361 missing id (=== undefined, not a truthiness check)", () => {
  test("id omitted entirely -> exact 'Missing required argument: id' error", async () => {
    const result = await runSystemTool("sys_revoke_key", {}, ADMIN_AUTH);
    expect(result).toEqual({ isError: true, content: [{ type: "text", text: "Missing required argument: id" }] });
  });

  test("id:0 (falsy but not undefined) is NOT treated as missing — proceeds to the not-found check instead", async () => {
    const result = await runSystemTool("sys_revoke_key", { id: 0 }, ADMIN_AUTH);
    expect(result).toEqual({ isError: true, content: [{ type: "text", text: "API key not found: 0" }] });
  });
});

// L362 — `if (!getMcpKey(id)) return toolResult(\`API key not found: ${id}\`, {isError:true});`
describe("sys_revoke_key — L362 API key not found", () => {
  test("an id for a key that doesn't exist -> exact 'API key not found: <id>' error with the id interpolated", async () => {
    const result = await runSystemTool("sys_revoke_key", { id: 424242 }, ADMIN_AUTH);
    expect(result).toEqual({ isError: true, content: [{ type: "text", text: "API key not found: 424242" }] });
  });
});

// L363 — `const ok = revokeMcpKey(id); if (!ok) return toolResult(\`API key
// ${id} is already revoked\`, {isError:true});` — genuinely end-to-end via
// the real createMcpKey/revokeMcpKey (cheap in-memory DB ops): mint, revoke
// once (succeeds), revoke again (must hit this exact path).
describe("sys_revoke_key — L363 already-revoked path (real mint + double revoke)", () => {
  test("revoking an already-revoked key a second time -> exact 'API key <id> is already revoked' error", async () => {
    const { record } = mcpKeyStoreMod.createMcpKey("to-revoke-twice", null, null, "test-fixture-actor");

    const first = await runSystemTool("sys_revoke_key", { id: record.id }, ADMIN_AUTH);
    expect(first).toEqual({ content: [{ type: "text", text: `API key ${record.id} revoked` }] });

    const second = await runSystemTool("sys_revoke_key", { id: record.id }, ADMIN_AUTH);
    expect(second).toEqual({
      isError: true,
      content: [{ type: "text", text: `API key ${record.id} is already revoked` }],
    });
  });
});

// L365-367 — success path: `recordAudit(actorFor(auth), "mcp_key.revoke",
// String(id)); return toolResult(\`API key ${id} revoked\`);`
describe("sys_revoke_key — L365-367 success path + audit", () => {
  let auditSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    auditSpy = spyOn(auditMod, "recordAudit");
  });

  afterEach(() => {
    auditSpy.mockRestore();
  });

  test("first revoke of a real key -> exact success message, and recordAudit is called with the exact action string and the id as a STRING", async () => {
    const { record } = mcpKeyStoreMod.createMcpKey("audit-revoke", null, null, "test-fixture-actor");

    const result = await runSystemTool("sys_revoke_key", { id: record.id }, ADMIN_AUTH);
    expect(result).toEqual({ content: [{ type: "text", text: `API key ${record.id} revoked` }] });

    expect(auditSpy).toHaveBeenCalledWith(EXPECTED_ACTOR, "mcp_key.revoke", String(record.id));
    const call = auditSpy.mock.calls[0] as unknown[];
    expect(typeof call[2]).toBe("string");
    expect(call[2]).toBe(String(record.id));
    // Confirms it really is revoked (not just an audit-only no-op) — the key
    // no longer resolves as usable.
    expect(mcpKeyStoreMod.getMcpKey(record.id)?.revokedAt).not.toBeNull();
  });
});

// L324:16 / L359:16 BooleanLiteral->'false' — each tool's OWN `sensitive:
// true` flag (two independent object-literal AST nodes, one per tool
// definition). The sibling ST1 file generically tests runSystemTool's
// sensitive/__confirm step-up gate using sys_delete_client as its example,
// but that doesn't observe whether THESE two tools' own `sensitive` fields
// are actually still `true` — each is a separate literal Stryker mutates
// independently. Verified here directly: a non-elevated, non-confirmed
// admin-tier call to each tool must still be rejected by the step-up gate
// (if `sensitive` were forced to `false`, runSystemTool would skip the
// gate entirely and let the call straight through to the handler).
describe("sys_mint_key / sys_revoke_key — each tool's own sensitive:true flag (L324/L359)", () => {
  test("sys_mint_key: admin tier alone (non-elevated, no __confirm) is NOT enough — the sensitive gate still fires", async () => {
    const result = await runSystemTool(
      "sys_mint_key",
      { label: "should-not-mint" },
      { role: "admin", elevated: false, keyId: 1, isEnvBearer: true },
    );
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("is sensitive");
  });

  test("sys_revoke_key: admin tier alone (non-elevated, no __confirm) is NOT enough — the sensitive gate still fires", async () => {
    const { record } = mcpKeyStoreMod.createMcpKey("should-not-revoke", null, null, "test-fixture-actor");
    const result = await runSystemTool(
      "sys_revoke_key",
      { id: record.id },
      { role: "admin", elevated: false, keyId: 1, isEnvBearer: false },
    );
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("is sensitive");
    // Confirms the gate genuinely blocked the operation, not just the message text.
    expect(mcpKeyStoreMod.getMcpKey(record.id)?.revokedAt).toBeNull();
  });
});
