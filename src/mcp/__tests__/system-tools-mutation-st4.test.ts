import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";

// Stryker mutation backstop — ST4 (src/mcp/system-tools.ts lines 233-280): the
// `sys_register_client` tool definition + handler — the densest single tool
// in the file (tier:"operate", sensitive:true, dispatches to one of
// performRestRegistration/performMcpRegistration/performGraphqlRegistration
// based on args.kind / presence of mcp_url / graphql_url, with its own
// tools[]-count cap check for the MCP-server-facing path that is distinct
// from performRestRegistration's own internal cap on curl/postman branches).
//
// Scope boundary: performRestRegistration/performMcpRegistration/
// performGraphqlRegistration are mocked via spyOn — those functions' OWN
// internals are independently mutation-tested in
// registration-mutation-rg1..rg5b.test.ts. This file's job is ONLY
// sys_register_client's dispatch/glue logic: which of the three functions
// gets called for a given args shape, the tools[]-count cap short-circuit,
// and the success-path audit-log write.
//
// Driven directly through listSystemTools()/runSystemTool() (no HTTP/MCP
// transport — src/mcp/__tests__/system-tools.test.ts already covers the
// role-tier/sensitive-gate/envBearerOnly axes end-to-end over real
// transports; this file assumes that gate and always passes elevated:true
// to reach the handler body directly).
//
// Each test/comment cites the exact line + mutator + replacement it targets,
// per the house convention (see stryker.config.mjs SCOPE HISTORY and the
// sibling registration-mutation-rg*.test.ts / registry-mutation-rc*.test.ts
// files).

import { listSystemTools, runSystemTool } from "../system-tools.js";
import type { SystemAuthResult } from "../../security/system-role.js";
import { registry } from "../registry.js";
import { __resetDbForTesting } from "../../db/connection.js";
import { config } from "../../config.js";
import * as registrationMod from "../registration.js";
import * as auditMod from "../../admin/audit/audit.js";
import type { RegisterOutcome } from "../registration.js";

// ---------------------------------------------------------------------------
// Fixtures / helpers
// ---------------------------------------------------------------------------

/** Elevated admin credential — clears BOTH the tier check (operate) and the
 * sensitive/__confirm step-up gate (elevated:true) so every test reaches
 * sys_register_client's handler body directly, without re-testing
 * runSystemTool's own gates (already covered by system-tools.test.ts). */
function elevatedAuth(overrides: Partial<SystemAuthResult> = {}): SystemAuthResult {
  return { role: "admin", elevated: true, keyId: 7, isEnvBearer: false, ...overrides };
}

function successOutcome(
  source: "openapi" | "manual" | "mcp" | "graphql",
  overrides: Partial<{ status: string; name: string; tools_count: number }> = {},
): RegisterOutcome {
  return {
    ok: true,
    status: 200,
    body: {
      status: overrides.status ?? "registered",
      name: overrides.name ?? "reg-target",
      tools_count: overrides.tools_count ?? 1,
      source,
    },
  };
}

function failureOutcome(message = "boom"): RegisterOutcome {
  return { ok: false, status: 400, body: { error: { code: "VALIDATION_ERROR", message } } };
}

const ORIGINAL_MAX_TOOLS = config.maxToolsPerClient;

let restSpy: ReturnType<typeof spyOn>;
let mcpSpy: ReturnType<typeof spyOn>;
let graphqlSpy: ReturnType<typeof spyOn>;
let auditSpy: ReturnType<typeof spyOn>;

beforeEach(async () => {
  __resetDbForTesting();
  for (const c of registry.listClients()) await registry.unregister(c.name);
  (config as Record<string, unknown>).maxToolsPerClient = ORIGINAL_MAX_TOOLS;

  // Default: every registration function resolves a generic success unless a
  // test overrides it — keeps tests that only care about dispatch (not the
  // outcome body) from needing to specify one.
  restSpy = spyOn(registrationMod, "performRestRegistration").mockResolvedValue(successOutcome("manual"));
  mcpSpy = spyOn(registrationMod, "performMcpRegistration").mockResolvedValue(successOutcome("mcp"));
  graphqlSpy = spyOn(registrationMod, "performGraphqlRegistration").mockResolvedValue(successOutcome("graphql"));
  auditSpy = spyOn(auditMod, "recordAudit").mockImplementation(() => {});
});

afterEach(() => {
  restSpy.mockRestore();
  mcpSpy.mockRestore();
  graphqlSpy.mockRestore();
  auditSpy.mockRestore();
  (config as Record<string, unknown>).maxToolsPerClient = ORIGINAL_MAX_TOOLS;
});

// ---------------------------------------------------------------------------
// Bulk schema toEqual — closes L236 (description StringLiteral), L238-249
// (inputSchema ObjectLiteral/ArrayDeclaration on properties/enum), L251
// (ArrayDeclaration on `required: ["name"]`), L252 (BooleanLiteral on
// `additionalProperties: true`) in one shot — any mutation to the advertised
// schema/description changes this object, so toEqual against the exact
// verbatim transcription from source is a single dense assertion.
// ---------------------------------------------------------------------------

describe("sys_register_client — advertised schema (L234-252)", () => {
  test("listSystemTools('operator') advertises the exact name/description/inputSchema", () => {
    const tools = listSystemTools("operator");
    const tool = tools.find((t) => t.name === "sys_register_client");
    expect(tool).toEqual({
      name: "sys_register_client",
      description:
        "Register a new backend client — REST/OpenAPI (name + tools[] or openapi_url), an MCP upstream (kind:'mcp', mcp_url), " +
        "or GraphQL (kind:'graphql', graphql_url). Mirrors POST /register's body shape exactly. Touches the network (SSRF-validated) " +
        'and adds a new call target, so this is sensitive: pass {"__confirm": true} or use an elevated credential.',
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string" },
          kind: { type: "string", enum: ["rest", "mcp", "graphql"] },
          tools: { type: "array", description: "REST manual tool list." },
          openapi_url: { type: "string" },
          health_url: { type: "string" },
          mcp_url: { type: "string" },
          mcp_transport: { type: "string" },
          graphql_url: { type: "string" },
          __confirm: { type: "boolean" },
        },
        required: ["name"],
        additionalProperties: true,
      },
    });
  });
});

// ---------------------------------------------------------------------------
// L263 — the MCP-facing tools[]-count cap: `if (Array.isArray(args.tools) &&
// args.tools.length > config.maxToolsPerClient) return toolResult(...,
// {isError:true})`. Distinct from performRestRegistration's own internal cap
// (which only covers curl/postman branches) — this check runs BEFORE any
// registration function is even called, for a hand-written tools[] array.
// ---------------------------------------------------------------------------

describe("sys_register_client — L263 tools[]-count cap (own check, before dispatch)", () => {
  test("a plain tools[] array over the cap is rejected with the exact message, before performRestRegistration is ever called", async () => {
    (config as Record<string, unknown>).maxToolsPerClient = 3;
    const args = { name: "over-cap", tools: [{}, {}, {}, {}], health_url: "http://x" };
    const result = await runSystemTool("sys_register_client", args, elevatedAuth());
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toBe("tools[] exceeds maximum of 3");
    expect(restSpy).not.toHaveBeenCalled();
    expect(mcpSpy).not.toHaveBeenCalled();
    expect(graphqlSpy).not.toHaveBeenCalled();
  });

  test("a plain tools[] array exactly at the cap proceeds to performRestRegistration — boundary is > not >=", async () => {
    (config as Record<string, unknown>).maxToolsPerClient = 3;
    const args = { name: "at-cap", tools: [{}, {}, {}], health_url: "http://x" };
    const result = await runSystemTool("sys_register_client", args, elevatedAuth());
    expect(result.content[0]?.text).not.toContain("tools[] exceeds maximum");
    expect(restSpy).toHaveBeenCalledTimes(1);
  });

  test("args.tools omitted entirely skips the check (Array.isArray guards it) and still dispatches to REST", async () => {
    (config as Record<string, unknown>).maxToolsPerClient = 1;
    const args = { name: "no-tools-field", health_url: "http://x" };
    const result = await runSystemTool("sys_register_client", args, elevatedAuth());
    expect(result.content[0]?.text).not.toContain("tools[] exceeds maximum");
    expect(restSpy).toHaveBeenCalledTimes(1);
  });

  test("a non-array tools value (a long string) does NOT trigger the cap error — proves the `&&` wasn't weakened to `||`", async () => {
    (config as Record<string, unknown>).maxToolsPerClient = 1;
    // Length 20 > cap of 1, but it's a string, not an array — a mutated `||`
    // would incorrectly short-circuit true on the length comparison alone
    // (strings support .length) and reject; the real `&&` requires
    // Array.isArray first and so must NOT reject here.
    const args = { name: "tools-is-a-string", tools: "x".repeat(20), health_url: "http://x" };
    const result = await runSystemTool("sys_register_client", args, elevatedAuth());
    expect(result.content[0]?.text).not.toContain("tools[] exceeds maximum");
    expect(restSpy).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// L269 — `if (args.kind === "mcp" || typeof args.mcp_url === "string")`
// dispatches to performMcpRegistration. Three cases prove the `||` (not
// `&&`) and the exact condition on each side.
// ---------------------------------------------------------------------------

describe("sys_register_client — L269 MCP dispatch condition", () => {
  test("kind:'mcp' with NO mcp_url still dispatches to performMcpRegistration", async () => {
    const args = { name: "mcp-by-kind", kind: "mcp" };
    await runSystemTool("sys_register_client", args, elevatedAuth());
    expect(mcpSpy).toHaveBeenCalledTimes(1);
    expect(restSpy).not.toHaveBeenCalled();
    expect(graphqlSpy).not.toHaveBeenCalled();
  });

  test("NO kind but a string mcp_url ALSO dispatches to performMcpRegistration — proves `||`, not `&&`", async () => {
    const args = { name: "mcp-by-url", mcp_url: "http://upstream.example/mcp" };
    await runSystemTool("sys_register_client", args, elevatedAuth());
    expect(mcpSpy).toHaveBeenCalledTimes(1);
    expect(restSpy).not.toHaveBeenCalled();
    expect(graphqlSpy).not.toHaveBeenCalled();
  });

  test("neither kind:'mcp' nor a string mcp_url does NOT dispatch to performMcpRegistration", async () => {
    const args = { name: "not-mcp" };
    await runSystemTool("sys_register_client", args, elevatedAuth());
    expect(mcpSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// L271 — `else if (args.kind === "graphql" || typeof args.graphql_url ===
// "string")` dispatches to performGraphqlRegistration. Same three-case
// pattern, PLUS priority: the MCP branch above must win even when a
// graphql-shaped indicator is also present.
// ---------------------------------------------------------------------------

describe("sys_register_client — L271 GraphQL dispatch condition + priority vs. L269", () => {
  test("kind:'graphql' with NO graphql_url dispatches to performGraphqlRegistration", async () => {
    const args = { name: "gql-by-kind", kind: "graphql" };
    await runSystemTool("sys_register_client", args, elevatedAuth());
    expect(graphqlSpy).toHaveBeenCalledTimes(1);
    expect(mcpSpy).not.toHaveBeenCalled();
    expect(restSpy).not.toHaveBeenCalled();
  });

  test("NO kind but a string graphql_url ALSO dispatches to performGraphqlRegistration — proves `||`, not `&&`", async () => {
    const args = { name: "gql-by-url", graphql_url: "http://upstream.example/graphql" };
    await runSystemTool("sys_register_client", args, elevatedAuth());
    expect(graphqlSpy).toHaveBeenCalledTimes(1);
    expect(mcpSpy).not.toHaveBeenCalled();
    expect(restSpy).not.toHaveBeenCalled();
  });

  test("neither kind:'graphql' nor a string graphql_url does NOT dispatch to performGraphqlRegistration (falls through to REST)", async () => {
    const args = { name: "not-gql" };
    await runSystemTool("sys_register_client", args, elevatedAuth());
    expect(graphqlSpy).not.toHaveBeenCalled();
    expect(restSpy).toHaveBeenCalledTimes(1);
  });

  test("kind:'mcp' takes priority over an ALSO-present graphql_url — the `else if` never even evaluates", async () => {
    const args = { name: "mcp-wins", kind: "mcp", graphql_url: "http://upstream.example/graphql" };
    await runSystemTool("sys_register_client", args, elevatedAuth());
    expect(mcpSpy).toHaveBeenCalledTimes(1);
    expect(graphqlSpy).not.toHaveBeenCalled();
    expect(restSpy).not.toHaveBeenCalled();
  });

  test("a string mcp_url takes priority over kind:'graphql' — L269's `||` fires on mcp_url alone, pre-empting L271 entirely", async () => {
    const args = { name: "mcp-url-wins", kind: "graphql", mcp_url: "http://upstream.example/mcp" };
    await runSystemTool("sys_register_client", args, elevatedAuth());
    expect(mcpSpy).toHaveBeenCalledTimes(1);
    expect(graphqlSpy).not.toHaveBeenCalled();
    expect(restSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// L273/L276/L277 — the final `else` (REST) branch, and the success-path
// audit write: `if (outcome.ok) recordAudit(actorFor(auth), "client.register",
// str(args,"name") ?? "", {source: outcome.body.source});`. Plus L278's
// unconditional `return json(outcome.body)` — same for both ok:true and
// ok:false outcomes.
// ---------------------------------------------------------------------------

describe("sys_register_client — L273 REST fallback dispatch", () => {
  test("neither mcp nor graphql indicators present dispatches to performRestRegistration with the raw args object", async () => {
    const args = { name: "rest-fallback", health_url: "http://x", tools: [{}] };
    await runSystemTool("sys_register_client", args, elevatedAuth());
    expect(restSpy).toHaveBeenCalledTimes(1);
    expect(restSpy).toHaveBeenCalledWith(args, undefined, null);
    expect(mcpSpy).not.toHaveBeenCalled();
    expect(graphqlSpy).not.toHaveBeenCalled();
  });
});

describe("sys_register_client — L276/L277 success-path audit write (fires only on outcome.ok)", () => {
  test("a successful outcome records audit with the exact action, name, and {source} meta — not the whole body", async () => {
    const auth = elevatedAuth({ keyId: 42 });
    restSpy.mockResolvedValue(successOutcome("manual", { name: "audited-client", tools_count: 5 }));
    const args = { name: "audited-client", health_url: "http://x", tools: [{}] };

    const result = await runSystemTool("sys_register_client", args, auth);

    expect(auditSpy).toHaveBeenCalledTimes(1);
    expect(auditSpy).toHaveBeenCalledWith("mcp-key:42", "client.register", "audited-client", { source: "manual" });
    // Return value is the raw outcome body, verbatim, regardless of ok/not-ok.
    expect(result.content[0]?.text).toBe(
      JSON.stringify({ status: "registered", name: "audited-client", tools_count: 5, source: "manual" }, null, 2),
    );
    expect(result.isError).toBeUndefined();
  });

  test("a failure outcome does NOT record audit at all", async () => {
    restSpy.mockResolvedValue(failureOutcome("name already taken"));
    const args = { name: "will-fail", health_url: "http://x", tools: [{}] };

    const result = await runSystemTool("sys_register_client", args, elevatedAuth());

    expect(auditSpy).not.toHaveBeenCalled();
    // Still returns the raw outcome body verbatim (json(outcome.body) is
    // unconditional — no isError is synthesized by this handler itself for
    // a registration-function failure, distinct from this tool's OWN
    // toolResult(..., {isError:true}) return at the L263 cap check above).
    expect(result.content[0]?.text).toBe(
      JSON.stringify({ error: { code: "VALIDATION_ERROR", message: "name already taken" } }, null, 2),
    );
    expect(result.isError).toBeUndefined();
  });

  test("the env-bearer actor label is used for recordAudit's actor arg when auth.isEnvBearer is true", async () => {
    const auth = elevatedAuth({ isEnvBearer: true, keyId: null });
    restSpy.mockResolvedValue(successOutcome("manual", { name: "env-bearer-registered" }));
    const args = { name: "env-bearer-registered", health_url: "http://x", tools: [{}] };

    await runSystemTool("sys_register_client", args, auth);

    expect(auditSpy).toHaveBeenCalledWith("bearer:admin-api-key", "client.register", "env-bearer-registered", {
      source: "manual",
    });
  });

  test("audit target falls back to '' when args.name is missing — proves the `?? \"\"` fallback, not just str(args,'name')", async () => {
    restSpy.mockResolvedValue(successOutcome("manual", { name: "unnamed" }));
    // No `name` field at all — the handler itself never validates args.name
    // (that's performRestRegistration's job, which is mocked here), so this
    // reaches the audit call with str(args, "name") === undefined.
    const args = { health_url: "http://x", tools: [{}] };

    await runSystemTool("sys_register_client", args, elevatedAuth());

    expect(auditSpy).toHaveBeenCalledWith("mcp-key:7", "client.register", "", { source: "manual" });
  });
});
