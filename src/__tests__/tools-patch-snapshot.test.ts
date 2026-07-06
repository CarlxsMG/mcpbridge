/**
 * Behaviour-equivalence snapshot for PATCH /admin-api/clients/:name/tools/:tool.
 *
 * This single test captures the CURRENT response + audit-log shape for every
 * body field the endpoint accepts (and a handful of negative cases), so the
 * dispatcher in `src/admin/tool-policies/mutations/index.ts` (and any future
 * refactor that touches it) can be verified byte-equal against it.
 *
 * What the snapshot includes (and excludes) is deliberate:
 *   - status, response body, and stable audit-log fields (actor / action /
 *     target / detail) — these are the contract.
 *   - NOT id, createdAt, or hash-chain — these are per-run / per-chain noise that
 *     changes every time the test runs and has no bearing on behaviour.
 *
 * First run writes the snapshot; subsequent runs compare. Run with:
 *   bun test src/__tests__/tools-patch-snapshot.test.ts
 * To update the snapshot after an intentional contract change:
 *   bun test --update-snapshots src/__tests__/tools-patch-snapshot.test.ts
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import express from "express";
import type { AddressInfo } from "net";
import type { Server } from "http";
import { config } from "../config.js";
import { __resetDbForTesting } from "../db/connection.js";
import { registry } from "../mcp/registry.js";
import { listAuditLog } from "../admin/audit/audit.js";
import { requestIdMiddleware } from "../middleware/request-id.js";
import type { RestToolDefinition } from "../mcp/types.js";

let baseUrl = "";
let activeServer: Server | null = null;
const ADMIN_KEY = "test-admin-key";

async function startApp(): Promise<void> {
  __resetDbForTesting();
  (config as Record<string, unknown>).adminApiKeys = [ADMIN_KEY];
  (config as Record<string, unknown>).authDisabled = false;

  const { adminRoutes } = await import("../routes/admin.js");
  const app = express();
  app.use(express.json({ limit: "64kb", strict: true }));
  app.use(requestIdMiddleware);
  adminRoutes(app);

  return new Promise((resolve, reject) => {
    const srv = app.listen(0, "127.0.0.1", () => {
      const addr = srv.address() as AddressInfo;
      baseUrl = `http://127.0.0.1:${addr.port}`;
      activeServer = srv;
      resolve();
    });
    srv.on("error", reject);
  });
}

function stopServer(): Promise<void> {
  return new Promise((resolve) => {
    if (activeServer) {
      activeServer.close(() => {
        activeServer = null;
        resolve();
      });
    } else {
      resolve();
    }
  });
}

function bearer(): Record<string, string> {
  // Pin the request id so error-response snapshots are byte-stable across runs
  // (the request_id middleware honours X-Request-ID when present, otherwise it
  // generates a fresh UUID per request).
  return {
    Authorization: `Bearer ${ADMIN_KEY}`,
    "Content-Type": "application/json",
    "X-Request-ID": "snapshot-req",
  };
}

function makeTool(overrides: Partial<RestToolDefinition> = {}): RestToolDefinition {
  return {
    name: "get-users",
    method: "GET",
    endpoint: "/users",
    description: "Returns a list of users",
    inputSchema: { type: "object", properties: {} },
    ...overrides,
  };
}

async function reg(name: string, tools: RestToolDefinition[] = [makeTool()]) {
  await registry.register(
    name,
    tools,
    "http://example.com/health",
    "1.2.3.4",
    "http://example.com",
    "1.2.3.4",
  );
}

beforeEach(async () => {
  for (const c of registry.listClients()) {
    await registry.unregister(c.name);
  }
});

afterEach(async () => {
  for (const c of registry.listClients()) {
    await registry.unregister(c.name);
  }
  await stopServer();
});

interface CaseCaptured {
  status: number;
  body: unknown;
  audit: Array<{ actor: string; action: string; target: string; detail: unknown }>;
}

interface CaseSpec {
  name: string;
  body: Record<string, unknown>;
}

/**
 * The matrix of body keys the PATCH endpoint accepts. Order in this array
 * matters: it matches the order in which `legacyMount.ts` processes them, so
 * multi-key cases produce audit events in the same order they would in
 * production.
 */
const CASES: CaseSpec[] = [
  // ── single keys: set + clear where applicable ────────────────────────────
  { name: "enabled:false", body: { enabled: false } },
  { name: "enabled:true", body: { enabled: true } },

  { name: "guards:rateLimit", body: { guards: { rateLimitPerMin: 60 } } },
  { name: "guards:clear", body: { guards: null } },

  { name: "overrides:description", body: { overrides: { description: "A new description" } } },
  { name: "overrides:clear", body: { overrides: null } },

  { name: "sensitive:true", body: { sensitive: true } },
  { name: "sensitive:null", body: { sensitive: null } },

  { name: "redactPaths:2", body: { redactPaths: ["a.b", "c.d"] } },

  {
    name: "guardrails:set",
    body: { guardrails: { denyPatterns: ["foo", "bar"], blockSecrets: true, scanResponses: true } },
  },
  { name: "guardrails:clear", body: { guardrails: null } },

  { name: "cache:set", body: { cache: { ttlSeconds: 60 } } },
  { name: "cache:clear", body: { cache: null } },

  { name: "coalesce:set", body: { coalesce: { enabled: true } } },
  { name: "coalesce:clear", body: { coalesce: null } },

  {
    name: "quarantinePolicy:set",
    body: { quarantinePolicy: { consecutiveThreshold: 5, action: "block", recoveryMode: "auto" } },
  },
  { name: "quarantinePolicy:clear", body: { quarantinePolicy: null } },

  {
    name: "pagination:cursor",
    body: {
      pagination: { strategy: "cursor", itemsPath: "data", cursorResponsePath: "next", cursorParam: "cursor", maxPages: 5 },
    },
  },
  { name: "pagination:clear", body: { pagination: null } },

  { name: "streaming:ndjson", body: { streaming: { format: "ndjson", maxEvents: 100 } } },
  { name: "streaming:clear", body: { streaming: null } },

  {
    name: "transform:set",
    body: { transform: { request: [{ op: "set", path: "x", value: 1 }], response: [] } },
  },
  { name: "transform:clear", body: { transform: null } },

  { name: "mock:always", body: { mock: { mode: "always", response: "{}" } } },
  { name: "mock:clear", body: { mock: null } },

  { name: "requiresApproval:true", body: { requiresApproval: true } },
  { name: "requiresApproval:false", body: { requiresApproval: false } },
  { name: "requiresApproval:true+levels:2", body: { requiresApproval: true, approvalLevels: 2 } },

  { name: "monitor:object", body: { monitor: { exampleId: 1 } } },
  { name: "monitor:clear", body: { monitor: null } },

  { name: "graphql:set", body: { graphql: { query: "query { x }" } } },
  { name: "graphql:clear", body: { graphql: null } },

  { name: "ws:clear", body: { ws: null } },

  { name: "contextBudget:truncate", body: { contextBudget: { mode: "truncate", maxResponseBytes: 10000 } } },
  { name: "contextBudget:clear", body: { contextBudget: null } },

  // ── combinations (multi-key per PATCH) ───────────────────────────────────
  { name: "combo:enabled+guards", body: { enabled: false, guards: { rateLimitPerMin: 5 } } },
  { name: "combo:cache+coalesce", body: { cache: { ttlSeconds: 60 }, coalesce: { enabled: true } } },
  {
    name: "combo:pagination+streaming+transform+mock",
    body: {
      pagination: { strategy: "link", itemsPath: "data", maxPages: 3 },
      streaming: { format: "sse", maxEvents: 50 },
      transform: { request: [], response: [] },
      mock: { mode: "fallback", response: "ok" },
    },
  },

  // ── negative cases ──────────────────────────────────────────────────────
  { name: "400:guards:invalid", body: { guards: { rateLimitPerMin: -5 } } },
  { name: "400:enabled:not-bool", body: { enabled: "yes" } },
  { name: "400:sensitive:not-bool-not-null", body: { sensitive: "maybe" } },
  { name: "400:redactPaths:not-array", body: { redactPaths: "oops" } },
  { name: "400:cache:bad-ttl", body: { cache: { ttlSeconds: 0 } } },
  { name: "400:graphql:missing-query", body: { graphql: { enabled: true } } },
  { name: "400:ws:missing-url", body: { ws: { enabled: true } } },
  { name: "400:monitor:missing-exampleId", body: { monitor: { intervalMinutes: 10 } } },
  { name: "400:requiresApproval:not-bool", body: { requiresApproval: "yes" } },
  { name: "400:approvalLevels:out-of-range", body: { requiresApproval: true, approvalLevels: 99 } },
  {
    name: "400:overrides:bad-displayName",
    body: { overrides: { displayName: "Has Spaces And Caps" } },
  },
];

describe("PATCH /clients/:name/tools/:tool — behaviour snapshot", () => {
  test("response + audit-log for every body key and combination", async () => {
    await startApp();
    await reg("svc", [makeTool({ name: "get-users" })]);

    let lastSeen = 0;

    for (const c of CASES) {
      const res = await fetch(`${baseUrl}/admin-api/clients/svc/tools/get-users`, {
        method: "PATCH",
        headers: bearer(),
        body: JSON.stringify(c.body),
      });
      const body: unknown = await res.json();

      // listAuditLog returns items newest-first. Slice off the entries that
      // weren't there before this PATCH, then reverse so multi-key PATCHes
      // appear in body-iteration order (matches the legacy handler's audit
      // emission order).
      const all = listAuditLog({}).items;
      const delta = all
        .slice(0, all.length - lastSeen)
        .map(({ actor, action, target, detail }) => ({ actor, action, target, detail }))
        .reverse();
      lastSeen = all.length;

      const captured: CaseCaptured = { status: res.status, body, audit: delta };
      expect(captured).toMatchSnapshot(c.name);
    }
  });

  test("404 for unknown tool", async () => {
    await startApp();
    await reg("svc", [makeTool({ name: "get-users" })]);

    const res = await fetch(`${baseUrl}/admin-api/clients/svc/tools/nonexistent`, {
      method: "PATCH",
      headers: bearer(),
      body: JSON.stringify({ enabled: false }),
    });
    const body: unknown = await res.json();

    expect({ status: res.status, body }).toMatchSnapshot("404:unknown-tool");
  });
});
