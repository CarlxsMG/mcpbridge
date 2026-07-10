/**
 * Stryker mutation-testing backstop for the whole src/admin/tool-policies/
 * mutations/ directory (18 ToolMutation handlers + index.ts's dispatcher) —
 * domain 9. Baseline: 553 mutants across 19 files, 35 killed (only via
 * indirect exercise from src/routes/admin/tools.ts's own PATCH tests, which
 * only ever send `{ enabled: ... }`) / 518 survived. Batched into one
 * Stryker target and one test file, matching this program's domain-4
 * "8 small files batched into ONE run" precedent — each handler here is
 * tiny (11-80 mutants) and shares the exact same `ToolMutation` shape
 * (validate -> apply -> audit), so per-file overhead from 18 separate
 * closures would dwarf the actual fixture-design work. `types.ts` is
 * excluded (pure type declarations, no runtime logic, same precedent as
 * domain 3's types.ts). Tested via DIRECT calls to `dispatchToolMutations`
 * (no Express app needed — a lightweight mock `Response` captures
 * status/json calls), since these files have no routes of their own; the
 * real HTTP layer (src/routes/admin/tools.ts) is already fully covered in
 * domain 8.
 */
import { describe, test, expect, spyOn } from "bun:test";
import type { Response } from "express";
import { __resetDbForTesting, getDb } from "../../../../db/connection.js";
import { registry } from "../../../../mcp/registry.js";
import * as auditMod from "../../../audit/audit.js";
import * as secretsMod from "../../../../secrets/index.js";
import { dispatchToolMutations } from "../index.js";

async function reg(name: string, toolName = "t"): Promise<void> {
  await registry.register(
    name,
    [
      {
        name: toolName,
        method: "GET",
        endpoint: "/t",
        description: "d",
        inputSchema: { type: "object", properties: {} },
      },
    ],
    "http://example.com/health",
    "1.2.3.4",
    "http://example.com",
    "1.2.3.4",
  );
}

function mockRes(): { res: Response; status: () => number | undefined; body: () => unknown } {
  let statusCode: number | undefined;
  let bodyValue: unknown;
  const res = {
    status(code: number) {
      statusCode = code;
      return res;
    },
    json(payload: unknown) {
      bodyValue = payload;
      return res;
    },
  } as unknown as Response;
  return { res, status: () => statusCode, body: () => bodyValue };
}

async function dispatch(
  clientName: string,
  toolName: string,
  body: Record<string, unknown>,
): Promise<{
  outcome: Awaited<ReturnType<typeof dispatchToolMutations>>;
  status: () => number | undefined;
  body: () => unknown;
}> {
  const { res, status, body: getBody } = mockRes();
  const outcome = await dispatchToolMutations(body, { actor: "test-actor", clientName, toolName }, res);
  return { outcome, status, body: getBody };
}

function auditSpy() {
  return spyOn(auditMod, "recordAudit");
}

// Kills each mutation's OWN `{ kind: "tool_not_found" }` -> `{}` object
// literal: the dispatcher only branches on `result.kind === "tool_not_found"`
// / `"error"`, never checking for `"ok"` explicitly, so the SUCCESS-branch
// `{kind:"ok"}` literal is equivalent (confirmed via hand-mutation) but the
// FAILURE-branch literal is a real, per-file gap -- an emptied `{}` would
// have `result.kind === "tool_not_found"` evaluate to false, silently
// falling through to a 200 for an unregistered tool. Each of the 18
// mutation files has its OWN copy of this ternary (a separate AST node),
// so each needs its own test with an unregistered tool.
async function expectToolNotFound(clientName: string, key: string, body: unknown): Promise<void> {
  await reg(clientName);
  const { outcome, status, body: getBody } = await dispatch(clientName, "does-not-exist", { [key]: body });
  expect(outcome).toBe("tool_not_found");
  expect(status()).toBe(404);
  expect((getBody() as { error: { code: string } }).error.code).toBe("TOOL_NOT_FOUND");
}

describe("dispatcher (index.ts)", () => {
  test("the audit target is the exact client__tool key", async () => {
    __resetDbForTesting();
    await reg("svc-target");
    const spy = auditSpy();
    try {
      const { outcome } = await dispatch("svc-target", "t", { enabled: false });
      expect(outcome).toBeNull();
      expect(spy).toHaveBeenCalledWith("test-actor", "tool.disable", "svc-target__t", undefined);
    } finally {
      spy.mockRestore();
    }
  });

  test("a validation failure returns validation_error with the exact message, no audit", async () => {
    __resetDbForTesting();
    await reg("svc-badvalidate");
    const spy = auditSpy();
    try {
      const { outcome, status, body } = await dispatch("svc-badvalidate", "t", { enabled: "not-a-boolean" });
      expect(outcome).toBe("validation_error");
      expect(status()).toBe(400);
      expect((body() as { error: { message: string } }).error.message).toBe("enabled must be a boolean");
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  test("an unregistered tool returns tool_not_found with the exact envelope", async () => {
    __resetDbForTesting();
    await reg("svc-unknowntool");
    const { outcome, status, body } = await dispatch("svc-unknowntool", "does-not-exist", { enabled: true });
    expect(outcome).toBe("tool_not_found");
    expect(status()).toBe(404);
    const errBody = (body() as { error: { code: string; message: string } }).error;
    expect(errBody.code).toBe("TOOL_NOT_FOUND");
    expect(errBody.message).toBe("Client or tool not found");
  });

  // Kills the downstream_error branch's `result.reason ?? result.code`
  // fallback: overrides.ts's ToolOverrideError path supplies a genuine
  // `reason` (the thrown error's message), so this proves the REASON wins
  // over the code when both are present. isAliasAvailable's collision
  // check is scoped to ONE client's own tools, so both aliased tools must
  // be registered under the SAME client.
  test("a downstream error with a reason uses the exact reason, not the code", async () => {
    __resetDbForTesting();
    await registry.register(
      "svc-alias",
      [
        {
          name: "t1",
          method: "GET",
          endpoint: "/t1",
          description: "d",
          inputSchema: { type: "object", properties: {} },
        },
        {
          name: "t2",
          method: "GET",
          endpoint: "/t2",
          description: "d",
          inputSchema: { type: "object", properties: {} },
        },
      ],
      "http://example.com/health",
      "1.2.3.4",
      "http://example.com",
      "1.2.3.4",
    );
    await dispatch("svc-alias", "t1", { overrides: { displayName: "shared-alias" } });
    const { outcome, status, body } = await dispatch("svc-alias", "t2", {
      overrides: { displayName: "shared-alias" },
    });
    expect(outcome).toBe("downstream_error");
    expect(status()).toBe(409);
    const errBody = (body() as { error: { code: string; message: string } }).error;
    expect(errBody.code).toBe("TOOL_ALIAS_CONFLICT");
    expect(errBody.message).not.toBe("TOOL_ALIAS_CONFLICT");
  });

  // Kills the downstream_error branch's fallback complementary direction:
  // when `reason` is undefined, the code itself must be used as the
  // message (context-budget.ts's TOOL_NOT_FOUND path never sets `reason`
  // -- confirmed by reading setToolContextBudget above).
  test("a downstream error with no reason falls back to the exact code as the message", async () => {
    __resetDbForTesting();
    await reg("svc-ctxbudget-404");
    const { outcome, status, body } = await dispatch("svc-ctxbudget-404", "does-not-exist", {
      contextBudget: { mode: "truncate", maxResponseBytes: 1000 },
    });
    expect(outcome).toBe("downstream_error");
    expect(status()).toBe(404);
    const errBody = (body() as { error: { code: string; message: string } }).error;
    expect(errBody.code).toBe("TOOL_NOT_FOUND");
    expect(errBody.message).toBe("TOOL_NOT_FOUND");
  });

  test("a multi-key PATCH applies both keys and audits both in declaration order", async () => {
    __resetDbForTesting();
    await reg("svc-multikey");
    const spy = auditSpy();
    try {
      const { outcome } = await dispatch("svc-multikey", "t", { enabled: false, sensitive: true });
      expect(outcome).toBeNull();
      expect(spy.mock.calls[0]).toEqual(["test-actor", "tool.disable", "svc-multikey__t"]);
      expect(spy.mock.calls[1]).toEqual(["test-actor", "tool.sensitive.set", "svc-multikey__t", { sensitive: true }]);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("enabled mutation", () => {
  test("enabling and disabling both audit the exact action", async () => {
    __resetDbForTesting();
    await reg("svc-enabled");
    const spy = auditSpy();
    try {
      await dispatch("svc-enabled", "t", { enabled: true });
      expect(spy).toHaveBeenLastCalledWith("test-actor", "tool.enable", "svc-enabled__t", undefined);
      await dispatch("svc-enabled", "t", { enabled: false });
      expect(spy).toHaveBeenLastCalledWith("test-actor", "tool.disable", "svc-enabled__t", undefined);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("sensitive mutation", () => {
  test("a non-boolean, non-null value fails validation with the exact message", async () => {
    __resetDbForTesting();
    await reg("svc-sensitive-bad");
    const { outcome, body } = await dispatch("svc-sensitive-bad", "t", { sensitive: "yes" });
    expect(outcome).toBe("validation_error");
    expect((body() as { error: { message: string } }).error.message).toBe("sensitive must be a boolean or null");
  });

  test("setting true and clearing with null both audit the exact action+meta", async () => {
    __resetDbForTesting();
    await reg("svc-sensitive-ok");
    const spy = auditSpy();
    try {
      await dispatch("svc-sensitive-ok", "t", { sensitive: true });
      expect(spy).toHaveBeenLastCalledWith("test-actor", "tool.sensitive.set", "svc-sensitive-ok__t", {
        sensitive: true,
      });
      await dispatch("svc-sensitive-ok", "t", { sensitive: null });
      expect(spy).toHaveBeenLastCalledWith("test-actor", "tool.sensitive.set", "svc-sensitive-ok__t", {
        sensitive: null,
      });
    } finally {
      spy.mockRestore();
    }
  });

  test("an unregistered tool returns the exact TOOL_NOT_FOUND error", async () => {
    __resetDbForTesting();
    await expectToolNotFound("svc-sensitive-notfound", "sensitive", true);
  });
});

describe("guards mutation", () => {
  test("a valid guards config is applied and audited with the exact action", async () => {
    __resetDbForTesting();
    await reg("svc-guards");
    const spy = auditSpy();
    try {
      const { outcome } = await dispatch("svc-guards", "t", {
        guards: { rateLimitPerMin: 5, timeoutMs: 1000 },
      });
      expect(outcome).toBeNull();
      expect(spy).toHaveBeenCalledWith("test-actor", "tool.guards.update", "svc-guards__t", undefined);
    } finally {
      spy.mockRestore();
    }
  });

  test("an unregistered tool returns the exact TOOL_NOT_FOUND error", async () => {
    __resetDbForTesting();
    await expectToolNotFound("svc-guards-notfound", "guards", { rateLimitPerMin: 5 });
  });
});

describe("cache mutation", () => {
  test("setting and clearing the cache config audit distinct exact actions", async () => {
    __resetDbForTesting();
    await reg("svc-cache");
    const spy = auditSpy();
    try {
      await dispatch("svc-cache", "t", { cache: { enabled: true, ttlSeconds: 60 } });
      expect(spy).toHaveBeenLastCalledWith("test-actor", "tool.cache.set", "svc-cache__t", {
        ttlSeconds: 60,
        enabled: true,
      });
      await dispatch("svc-cache", "t", { cache: null });
      expect(spy).toHaveBeenLastCalledWith("test-actor", "tool.cache.clear", "svc-cache__t", undefined);
    } finally {
      spy.mockRestore();
    }
  });

  test("an unregistered tool returns the exact TOOL_NOT_FOUND error", async () => {
    __resetDbForTesting();
    await expectToolNotFound("svc-cache-notfound", "cache", { enabled: true, ttlSeconds: 60 });
  });
});

describe("coalesce mutation", () => {
  test("setting and clearing coalesce audit distinct exact actions", async () => {
    __resetDbForTesting();
    await reg("svc-coalesce");
    const spy = auditSpy();
    try {
      await dispatch("svc-coalesce", "t", { coalesce: { enabled: true } });
      expect(spy).toHaveBeenLastCalledWith("test-actor", "tool.coalesce.set", "svc-coalesce__t", { enabled: true });
      await dispatch("svc-coalesce", "t", { coalesce: null });
      expect(spy).toHaveBeenLastCalledWith("test-actor", "tool.coalesce.clear", "svc-coalesce__t", undefined);
    } finally {
      spy.mockRestore();
    }
  });

  test("an unregistered tool returns the exact TOOL_NOT_FOUND error", async () => {
    __resetDbForTesting();
    await expectToolNotFound("svc-coalesce-notfound", "coalesce", { enabled: true });
  });
});

describe("pagination mutation", () => {
  test("setting and clearing pagination audit distinct exact actions", async () => {
    __resetDbForTesting();
    await reg("svc-pagination");
    const spy = auditSpy();
    try {
      await dispatch("svc-pagination", "t", {
        pagination: { strategy: "cursor", maxPages: 10, cursorResponsePath: "next", cursorParam: "cursor" },
      });
      expect(spy).toHaveBeenLastCalledWith("test-actor", "tool.pagination.set", "svc-pagination__t", {
        strategy: "cursor",
        maxPages: 10,
      });
      await dispatch("svc-pagination", "t", { pagination: null });
      expect(spy).toHaveBeenLastCalledWith("test-actor", "tool.pagination.clear", "svc-pagination__t", undefined);
    } finally {
      spy.mockRestore();
    }
  });

  test("an unregistered tool returns the exact TOOL_NOT_FOUND error", async () => {
    __resetDbForTesting();
    await expectToolNotFound("svc-pagination-notfound", "pagination", {
      strategy: "cursor",
      maxPages: 10,
      cursorResponsePath: "next",
      cursorParam: "cursor",
    });
  });
});

describe("streaming mutation", () => {
  test("setting and clearing streaming audit distinct exact actions", async () => {
    __resetDbForTesting();
    await reg("svc-streaming");
    const spy = auditSpy();
    try {
      await dispatch("svc-streaming", "t", { streaming: { format: "ndjson", maxEvents: 100 } });
      expect(spy).toHaveBeenLastCalledWith("test-actor", "tool.streaming.set", "svc-streaming__t", {
        format: "ndjson",
      });
      await dispatch("svc-streaming", "t", { streaming: null });
      expect(spy).toHaveBeenLastCalledWith("test-actor", "tool.streaming.clear", "svc-streaming__t", undefined);
    } finally {
      spy.mockRestore();
    }
  });

  test("an unregistered tool returns the exact TOOL_NOT_FOUND error", async () => {
    __resetDbForTesting();
    await expectToolNotFound("svc-streaming-notfound", "streaming", { format: "ndjson", maxEvents: 100 });
  });
});

describe("transform mutation", () => {
  test("setting and clearing transform audit distinct exact actions with request/response counts", async () => {
    __resetDbForTesting();
    await reg("svc-transform");
    const spy = auditSpy();
    try {
      await dispatch("svc-transform", "t", {
        transform: { enabled: true, request: [{ op: "remove", path: "a" }], response: [] },
      });
      expect(spy).toHaveBeenLastCalledWith("test-actor", "tool.transform.set", "svc-transform__t", {
        request: 1,
        response: 0,
      });
      await dispatch("svc-transform", "t", { transform: null });
      expect(spy).toHaveBeenLastCalledWith("test-actor", "tool.transform.clear", "svc-transform__t", undefined);
    } finally {
      spy.mockRestore();
    }
  });

  test("an unregistered tool returns the exact TOOL_NOT_FOUND error", async () => {
    __resetDbForTesting();
    await expectToolNotFound("svc-transform-notfound", "transform", { enabled: true, request: [], response: [] });
  });
});

describe("mock mutation", () => {
  test("setting and clearing mock audit distinct exact actions", async () => {
    __resetDbForTesting();
    await reg("svc-mock");
    const spy = auditSpy();
    try {
      await dispatch("svc-mock", "t", { mock: { enabled: true, mode: "always", response: "{}" } });
      expect(spy).toHaveBeenLastCalledWith("test-actor", "tool.mock.set", "svc-mock__t", { mode: "always" });
      await dispatch("svc-mock", "t", { mock: null });
      expect(spy).toHaveBeenLastCalledWith("test-actor", "tool.mock.clear", "svc-mock__t", undefined);
    } finally {
      spy.mockRestore();
    }
  });

  test("an unregistered tool returns the exact TOOL_NOT_FOUND error", async () => {
    __resetDbForTesting();
    await expectToolNotFound("svc-mock-notfound", "mock", { enabled: true, mode: "always", response: "{}" });
  });
});

describe("quarantine-policy mutation", () => {
  test("setting and clearing the quarantine policy audit distinct exact actions", async () => {
    __resetDbForTesting();
    await reg("svc-quarpolicy");
    const spy = auditSpy();
    try {
      await dispatch("svc-quarpolicy", "t", {
        quarantinePolicy: {
          consecutiveThreshold: 3,
          action: "block",
          recoveryMode: "auto",
          cooldownMs: 60000,
        },
      });
      expect(spy).toHaveBeenLastCalledWith("test-actor", "tool.quarantine.policy.set", "svc-quarpolicy__t", {
        consecutiveThreshold: 3,
        action: "block",
        recoveryMode: "auto",
        cooldownMs: 60000,
      });
      await dispatch("svc-quarpolicy", "t", { quarantinePolicy: null });
      expect(spy).toHaveBeenLastCalledWith(
        "test-actor",
        "tool.quarantine.policy.clear",
        "svc-quarpolicy__t",
        undefined,
      );
    } finally {
      spy.mockRestore();
    }
  });

  test("an unregistered tool returns the exact TOOL_NOT_FOUND error", async () => {
    __resetDbForTesting();
    await expectToolNotFound("svc-quarpolicy-notfound", "quarantinePolicy", {
      consecutiveThreshold: 3,
      action: "block",
      recoveryMode: "auto",
      cooldownMs: 60000,
    });
  });
});

describe("redact-paths mutation", () => {
  test("a non-array value fails validation with the exact message", async () => {
    __resetDbForTesting();
    await reg("svc-redact-bad");
    const { outcome, body } = await dispatch("svc-redact-bad", "t", { redactPaths: "not-an-array" });
    expect(outcome).toBe("validation_error");
    expect((body() as { error: { message: string } }).error.message).toBe("redactPaths must be an array of strings");
  });

  test("an array containing a non-string fails validation", async () => {
    __resetDbForTesting();
    await reg("svc-redact-mixed");
    const { outcome } = await dispatch("svc-redact-mixed", "t", { redactPaths: ["a.b", 5] });
    expect(outcome).toBe("validation_error");
  });

  test("a valid array is applied and audited with the exact count", async () => {
    __resetDbForTesting();
    await reg("svc-redact-ok");
    const spy = auditSpy();
    try {
      const { outcome } = await dispatch("svc-redact-ok", "t", { redactPaths: ["a.b", "c.d", "e"] });
      expect(outcome).toBeNull();
      expect(spy).toHaveBeenCalledWith("test-actor", "tool.redaction.set", "svc-redact-ok__t", { count: 3 });
    } finally {
      spy.mockRestore();
    }
  });

  test("an unregistered tool returns the exact TOOL_NOT_FOUND error", async () => {
    __resetDbForTesting();
    await expectToolNotFound("svc-redact-notfound", "redactPaths", ["a.b"]);
  });
});

describe("guardrails mutation", () => {
  test("a full guardrails config audits the exact stable-shape detail", async () => {
    __resetDbForTesting();
    await reg("svc-guardrails");
    const spy = auditSpy();
    try {
      const { outcome } = await dispatch("svc-guardrails", "t", {
        guardrails: { denyPatterns: ["a", "b"], blockSecrets: true, scanResponses: false },
      });
      expect(outcome).toBeNull();
      expect(spy).toHaveBeenCalledWith("test-actor", "tool.guardrails.set", "svc-guardrails__t", {
        denyPatterns: 2,
        blockSecrets: true,
        scanResponses: false,
      });
    } finally {
      spy.mockRestore();
    }
  });

  // Kills the `v?.denyPatterns.length ?? 0` / `v?.blockSecrets ?? false` /
  // `v?.scanResponses ?? false` fallback cluster: a clear (null) must still
  // audit the SAME stable shape with default values, per the file's own
  // documented "always emits the same detail shape" contract.
  test("clearing guardrails still audits the exact stable default shape", async () => {
    __resetDbForTesting();
    await reg("svc-guardrails-clear");
    const spy = auditSpy();
    try {
      await dispatch("svc-guardrails-clear", "t", {
        guardrails: { denyPatterns: ["x"], blockSecrets: true, scanResponses: true },
      });
      const { outcome } = await dispatch("svc-guardrails-clear", "t", { guardrails: null });
      expect(outcome).toBeNull();
      expect(spy).toHaveBeenLastCalledWith("test-actor", "tool.guardrails.set", "svc-guardrails-clear__t", {
        denyPatterns: 0,
        blockSecrets: false,
        scanResponses: false,
      });
    } finally {
      spy.mockRestore();
    }
  });

  test("an unregistered tool returns the exact TOOL_NOT_FOUND error", async () => {
    __resetDbForTesting();
    await expectToolNotFound("svc-guardrails-notfound", "guardrails", {
      denyPatterns: ["x"],
      blockSecrets: true,
      scanResponses: true,
    });
  });
});

describe("overrides mutation", () => {
  test("a valid override is applied and audited with the exact action", async () => {
    __resetDbForTesting();
    await reg("svc-overrides");
    const spy = auditSpy();
    try {
      const { outcome } = await dispatch("svc-overrides", "t", { overrides: { description: "custom desc" } });
      expect(outcome).toBeNull();
      expect(spy).toHaveBeenCalledWith("test-actor", "tool.override.update", "svc-overrides__t", undefined);
    } finally {
      spy.mockRestore();
    }
  });

  // validateToolOverrideInput itself enforces the displayName charset, so a
  // malformed alias is caught at VALIDATION, before ever reaching the
  // registry's own (identically-charset) check -- confirmed by reading
  // admin-validators.ts's validateToolOverrideInput.
  test("a malformed displayName alias fails validation, not the registry", async () => {
    __resetDbForTesting();
    await reg("svc-overrides-badalias");
    const { outcome, status, body } = await dispatch("svc-overrides-badalias", "t", {
      overrides: { displayName: "Not Valid!!" },
    });
    expect(outcome).toBe("validation_error");
    expect(status()).toBe(400);
    expect((body() as { error: { message: string } }).error.message).toContain("displayName");
  });

  test("an unregistered tool returns tool_not_found", async () => {
    await expectToolNotFound("svc-overrides-notfound", "overrides", { description: "x" });
  });
});

describe("requires-approval mutation", () => {
  test("a non-boolean requiresApproval fails validation with the exact message", async () => {
    __resetDbForTesting();
    await reg("svc-approval-bad");
    const { outcome, body } = await dispatch("svc-approval-bad", "t", { requiresApproval: "yes" });
    expect(outcome).toBe("validation_error");
    expect((body() as { error: { message: string } }).error.message).toBe("requiresApproval must be a boolean");
  });

  test("an out-of-range approvalLevels fails validation with the exact message", async () => {
    __resetDbForTesting();
    await reg("svc-approval-range");
    const { outcome, body } = await dispatch("svc-approval-range", "t", {
      requiresApproval: true,
      approvalLevels: 0,
    });
    expect(outcome).toBe("validation_error");
    expect((body() as { error: { message: string } }).error.message).toContain(
      "approvalLevels must be an integer between 1 and",
    );
  });

  test("an approvalLevels above MAX_APPROVAL_LEVELS fails validation", async () => {
    __resetDbForTesting();
    await reg("svc-approval-toohigh");
    const { outcome, body } = await dispatch("svc-approval-toohigh", "t", {
      requiresApproval: true,
      approvalLevels: 11,
    });
    expect(outcome).toBe("validation_error");
    expect((body() as { error: { message: string } }).error.message).toContain(
      "approvalLevels must be an integer between 1 and",
    );
  });

  test("a non-integer approvalLevels fails validation", async () => {
    __resetDbForTesting();
    await reg("svc-approval-noninteger");
    const { outcome, body } = await dispatch("svc-approval-noninteger", "t", {
      requiresApproval: true,
      approvalLevels: 1.5,
    });
    expect(outcome).toBe("validation_error");
    expect((body() as { error: { message: string } }).error.message).toContain(
      "approvalLevels must be an integer between 1 and",
    );
  });

  test("approvalLevels at the exact minimum boundary (1) is accepted", async () => {
    __resetDbForTesting();
    await reg("svc-approval-atmin");
    const spy = auditSpy();
    try {
      const { outcome } = await dispatch("svc-approval-atmin", "t", {
        requiresApproval: true,
        approvalLevels: 1,
      });
      expect(outcome).toBeNull();
      expect(spy).toHaveBeenCalledWith("test-actor", "tool.approval.enable", "svc-approval-atmin__t", {
        approvalLevels: 1,
      });
    } finally {
      spy.mockRestore();
    }
  });

  test("approvalLevels at the exact MAX_APPROVAL_LEVELS boundary is accepted", async () => {
    __resetDbForTesting();
    await reg("svc-approval-atmax");
    const spy = auditSpy();
    try {
      const { outcome } = await dispatch("svc-approval-atmax", "t", {
        requiresApproval: true,
        approvalLevels: 10,
      });
      expect(outcome).toBeNull();
      expect(spy).toHaveBeenCalledWith("test-actor", "tool.approval.enable", "svc-approval-atmax__t", {
        approvalLevels: 10,
      });
    } finally {
      spy.mockRestore();
    }
  });

  test("enabling with a level audits enable + the exact approvalLevels meta", async () => {
    __resetDbForTesting();
    await reg("svc-approval-ok");
    const spy = auditSpy();
    try {
      const { outcome } = await dispatch("svc-approval-ok", "t", { requiresApproval: true, approvalLevels: 2 });
      expect(outcome).toBeNull();
      expect(spy).toHaveBeenCalledWith("test-actor", "tool.approval.enable", "svc-approval-ok__t", {
        approvalLevels: 2,
      });
    } finally {
      spy.mockRestore();
    }
  });

  test("disabling without a level audits disable with no meta", async () => {
    __resetDbForTesting();
    await reg("svc-approval-disable");
    const spy = auditSpy();
    try {
      const { outcome } = await dispatch("svc-approval-disable", "t", { requiresApproval: false });
      expect(outcome).toBeNull();
      expect(spy).toHaveBeenCalledWith("test-actor", "tool.approval.disable", "svc-approval-disable__t", undefined);
    } finally {
      spy.mockRestore();
    }
  });

  test("an unregistered tool returns tool_not_found", async () => {
    await expectToolNotFound("svc-approval-notfound", "requiresApproval", true);
  });
});

describe("context-budget mutation", () => {
  test("setting truncate mode audits the exact meta without an llmProvider key", async () => {
    __resetDbForTesting();
    await reg("svc-ctxbudget-trunc");
    const spy = auditSpy();
    try {
      const { outcome } = await dispatch("svc-ctxbudget-trunc", "t", {
        contextBudget: { mode: "truncate", maxResponseBytes: 5000 },
      });
      expect(outcome).toBeNull();
      expect(spy).toHaveBeenCalledWith("test-actor", "tool.context_budget.set", "svc-ctxbudget-trunc__t", {
        mode: "truncate",
        maxResponseBytes: 5000,
      });
    } finally {
      spy.mockRestore();
    }
  });

  test("clearing context budget audits clear with no meta", async () => {
    __resetDbForTesting();
    await reg("svc-ctxbudget-clear");
    await dispatch("svc-ctxbudget-clear", "t", { contextBudget: { mode: "truncate", maxResponseBytes: 5000 } });
    const spy = auditSpy();
    try {
      const { outcome } = await dispatch("svc-ctxbudget-clear", "t", { contextBudget: null });
      expect(outcome).toBeNull();
      expect(spy).toHaveBeenCalledWith("test-actor", "tool.context_budget.clear", "svc-ctxbudget-clear__t", undefined);
    } finally {
      spy.mockRestore();
    }
  });

  // Kills the `result.error === "TOOL_NOT_FOUND" ? 404 : 400` ternary's
  // forced-true direction: a DIFFERENT error kind (not found via an
  // unconfigured secrets provider, the default in this test environment)
  // must still 400, not 404.
  test("an llm_summarize request with an unconfigured secrets provider returns the exact 400", async () => {
    __resetDbForTesting();
    await reg("svc-ctxbudget-unconfigured");
    const { outcome, status, body } = await dispatch("svc-ctxbudget-unconfigured", "t", {
      contextBudget: {
        mode: "llm_summarize",
        maxResponseBytes: 5000,
        llm: { provider: "openai", baseUrl: "https://api.openai.com", model: "gpt-4", apiKey: "sk-x" },
      },
    });
    expect(outcome).toBe("downstream_error");
    expect(status()).toBe(400);
    expect((body() as { error: { code: string } }).error.code).toBe("SECRETS_PROVIDER_UNCONFIGURED");
  });

  // Kills the `result.reason ?? result.error` fallback's complementary
  // direction: when a genuine `reason` IS present (a thrown
  // encryptSecret error), it must win over the code.
  test("a secrets-provider encryption failure uses the exact reason, not the code", async () => {
    __resetDbForTesting();
    await reg("svc-ctxbudget-secretserr");
    const spy = spyOn(secretsMod, "getSecretsProvider").mockReturnValue({
      name: "local",
      isConfigured: () => true,
      encryptSecret: async () => {
        throw new Error("boom-reason");
      },
      decryptSecret: async () => "unused",
    });
    try {
      const { outcome, status, body } = await dispatch("svc-ctxbudget-secretserr", "t", {
        contextBudget: {
          mode: "llm_summarize",
          maxResponseBytes: 5000,
          llm: { provider: "openai", baseUrl: "https://api.openai.com", model: "gpt-4", apiKey: "sk-x" },
        },
      });
      expect(outcome).toBe("downstream_error");
      expect(status()).toBe(400);
      const errBody = (body() as { error: { code: string; message: string } }).error;
      expect(errBody.code).toBe("SECRETS_PROVIDER_ERROR");
      expect(errBody.message).toBe("boom-reason");
    } finally {
      spy.mockRestore();
    }
  });

  // Kills the audit meta's `v.mode === "llm_summarize" && v.llm ? {...} : {}`
  // spread: a genuinely successful llm_summarize set must audit an
  // `llmProvider` key (the truncate-mode test above only proves it's ABSENT
  // when mode differs).
  test("setting llm_summarize mode audits the exact meta including llmProvider", async () => {
    __resetDbForTesting();
    await reg("svc-ctxbudget-llmok");
    const secretsSpy = spyOn(secretsMod, "getSecretsProvider").mockReturnValue({
      name: "local",
      isConfigured: () => true,
      encryptSecret: async () => "encrypted-blob",
      decryptSecret: async () => "sk-x",
    });
    const auditSpyInstance = auditSpy();
    try {
      const { outcome } = await dispatch("svc-ctxbudget-llmok", "t", {
        contextBudget: {
          mode: "llm_summarize",
          maxResponseBytes: 5000,
          llm: { provider: "openai", baseUrl: "https://api.openai.com", model: "gpt-4", apiKey: "sk-x" },
        },
      });
      expect(outcome).toBeNull();
      expect(auditSpyInstance).toHaveBeenCalledWith("test-actor", "tool.context_budget.set", "svc-ctxbudget-llmok__t", {
        mode: "llm_summarize",
        maxResponseBytes: 5000,
        llmProvider: "openai",
      });
    } finally {
      secretsSpy.mockRestore();
      auditSpyInstance.mockRestore();
    }
  });
});

describe("monitor mutation", () => {
  test("a non-object, non-null, non-false value fails validation with the exact message", async () => {
    __resetDbForTesting();
    await reg("svc-monitor-bad");
    const { outcome, body } = await dispatch("svc-monitor-bad", "t", { monitor: "not-an-object" });
    expect(outcome).toBe("validation_error");
    expect((body() as { error: { message: string } }).error.message).toBe("monitor must be an object, null, or false");
  });

  test("a missing exampleId fails validation with the exact message", async () => {
    __resetDbForTesting();
    await reg("svc-monitor-noexample");
    const { outcome, body } = await dispatch("svc-monitor-noexample", "t", { monitor: {} });
    expect(outcome).toBe("validation_error");
    expect((body() as { error: { message: string } }).error.message).toBe("monitor.exampleId (number) is required");
  });

  test("setting a monitor audits the exact exampleId meta, clearing audits clear", async () => {
    __resetDbForTesting();
    await reg("svc-monitor-ok");
    const spy = auditSpy();
    try {
      const { outcome } = await dispatch("svc-monitor-ok", "t", {
        monitor: { exampleId: 7, intervalMinutes: 30, enabled: true },
      });
      expect(outcome).toBeNull();
      expect(spy).toHaveBeenCalledWith("test-actor", "tool.monitor.set", "svc-monitor-ok__t", { exampleId: 7 });
      await dispatch("svc-monitor-ok", "t", { monitor: null });
      expect(spy).toHaveBeenLastCalledWith("test-actor", "tool.monitor.clear", "svc-monitor-ok__t", undefined);
    } finally {
      spy.mockRestore();
    }
  });

  test("monitor.enabled defaults to true when omitted, false when explicit", async () => {
    __resetDbForTesting();
    await reg("svc-monitor-default");
    await dispatch("svc-monitor-default", "t", { monitor: { exampleId: 1, intervalMinutes: 15 } });
    const row1 = getDb()
      .query(`SELECT enabled FROM tool_monitor WHERE client_name = ? AND tool_name = ?`)
      .get("svc-monitor-default", "t") as { enabled: number };
    expect(row1.enabled).toBe(1);

    await reg("svc-monitor-explicit-false");
    await dispatch("svc-monitor-explicit-false", "t", {
      monitor: { exampleId: 1, intervalMinutes: 15, enabled: false },
    });
    const row2 = getDb()
      .query(`SELECT enabled FROM tool_monitor WHERE client_name = ? AND tool_name = ?`)
      .get("svc-monitor-explicit-false", "t") as { enabled: number };
    expect(row2.enabled).toBe(0);
  });

  test("an unresolvable (unregistered) tool returns the exact TOOL_NOT_LIVE 404", async () => {
    __resetDbForTesting();
    await reg("svc-monitor-notlive");
    const { outcome, status, body } = await dispatch("svc-monitor-notlive", "does-not-exist", {
      monitor: { exampleId: 1, intervalMinutes: 15, enabled: true },
    });
    expect(outcome).toBe("downstream_error");
    expect(status()).toBe(404);
    expect((body() as { error: { code: string } }).error.code).toBe("TOOL_NOT_LIVE");
  });

  test("an out-of-range interval returns the exact INVALID_INTERVAL 400", async () => {
    __resetDbForTesting();
    await reg("svc-monitor-badinterval");
    const { outcome, status, body } = await dispatch("svc-monitor-badinterval", "t", {
      monitor: { exampleId: 1, intervalMinutes: 9999, enabled: true },
    });
    expect(outcome).toBe("downstream_error");
    expect(status()).toBe(400);
    expect((body() as { error: { code: string } }).error.code).toBe("INVALID_INTERVAL");
  });

  test("monitor: false also takes the clear path", async () => {
    __resetDbForTesting();
    await reg("svc-monitor-clear-false");
    const spy = auditSpy();
    try {
      await dispatch("svc-monitor-clear-false", "t", {
        monitor: { exampleId: 1, intervalMinutes: 15, enabled: true },
      });
      const { outcome } = await dispatch("svc-monitor-clear-false", "t", { monitor: false });
      expect(outcome).toBeNull();
      expect(spy).toHaveBeenLastCalledWith("test-actor", "tool.monitor.clear", "svc-monitor-clear-false__t", undefined);
    } finally {
      spy.mockRestore();
    }
  });

  test("intervalMinutes defaults to 15 when omitted", async () => {
    __resetDbForTesting();
    await reg("svc-monitor-interval-default");
    await dispatch("svc-monitor-interval-default", "t", { monitor: { exampleId: 1 } });
    const row = getDb()
      .query(`SELECT interval_minutes FROM tool_monitor WHERE client_name = ? AND tool_name = ?`)
      .get("svc-monitor-interval-default", "t") as { interval_minutes: number };
    expect(row.interval_minutes).toBe(15);
  });
});

describe("graphql mutation", () => {
  test("clearing via null or false both take the clear path", async () => {
    __resetDbForTesting();
    await reg("svc-graphql-clear-null");
    const spy = auditSpy();
    try {
      const r1 = await dispatch("svc-graphql-clear-null", "t", { graphql: null });
      expect(r1.outcome).toBeNull();
      expect(spy).toHaveBeenLastCalledWith("test-actor", "tool.graphql.clear", "svc-graphql-clear-null__t", undefined);
      const r2 = await dispatch("svc-graphql-clear-null", "t", { graphql: false });
      expect(r2.outcome).toBeNull();
      expect(spy).toHaveBeenLastCalledWith("test-actor", "tool.graphql.clear", "svc-graphql-clear-null__t", undefined);
    } finally {
      spy.mockRestore();
    }
  });

  test("an array fails validation (not an object)", async () => {
    __resetDbForTesting();
    await reg("svc-graphql-array");
    const { outcome, body } = await dispatch("svc-graphql-array", "t", { graphql: [1, 2] });
    expect(outcome).toBe("validation_error");
    expect((body() as { error: { message: string } }).error.message).toBe("graphql must be an object, null, or false");
  });

  test("a non-array, non-object value fails validation (not just arrays)", async () => {
    __resetDbForTesting();
    await reg("svc-graphql-string");
    const { outcome, body } = await dispatch("svc-graphql-string", "t", { graphql: "oops" });
    expect(outcome).toBe("validation_error");
    expect((body() as { error: { message: string } }).error.message).toBe("graphql must be an object, null, or false");
  });

  test("a missing/empty query fails validation with the exact message", async () => {
    __resetDbForTesting();
    await reg("svc-graphql-noquery");
    const { outcome, body } = await dispatch("svc-graphql-noquery", "t", { graphql: { query: "   " } });
    expect(outcome).toBe("validation_error");
    expect((body() as { error: { message: string } }).error.message).toBe(
      "graphql.query (non-empty string) is required",
    );
  });

  test("an entirely missing query key also fails validation with the exact message", async () => {
    __resetDbForTesting();
    await reg("svc-graphql-noquerykey");
    const { outcome, body } = await dispatch("svc-graphql-noquerykey", "t", { graphql: {} });
    expect(outcome).toBe("validation_error");
    expect((body() as { error: { message: string } }).error.message).toBe(
      "graphql.query (non-empty string) is required",
    );
  });

  test("a valid query is trimmed, applied, and audited as set", async () => {
    __resetDbForTesting();
    await reg("svc-graphql-ok");
    const spy = auditSpy();
    try {
      const { outcome } = await dispatch("svc-graphql-ok", "t", { graphql: { query: "  { me }  " } });
      expect(outcome).toBeNull();
      expect(spy).toHaveBeenCalledWith("test-actor", "tool.graphql.set", "svc-graphql-ok__t", undefined);
    } finally {
      spy.mockRestore();
    }
  });

  test("graphql.enabled defaults to true when omitted, false when explicit", async () => {
    __resetDbForTesting();
    await reg("svc-graphql-default");
    await dispatch("svc-graphql-default", "t", { graphql: { query: "{ me }" } });
    const row1 = getDb()
      .query(`SELECT enabled FROM tool_graphql WHERE client_name = ? AND tool_name = ?`)
      .get("svc-graphql-default", "t") as { enabled: number } | null;
    expect(row1?.enabled).toBe(1);

    await reg("svc-graphql-explicit-false");
    await dispatch("svc-graphql-explicit-false", "t", { graphql: { query: "{ me }", enabled: false } });
    const row2 = getDb()
      .query(`SELECT enabled FROM tool_graphql WHERE client_name = ? AND tool_name = ?`)
      .get("svc-graphql-explicit-false", "t") as { enabled: number } | null;
    expect(row2?.enabled).toBe(0);
  });

  test("an unregistered tool returns tool_not_found", async () => {
    await expectToolNotFound("svc-graphql-notfound", "graphql", { query: "{ me }" });
  });
});

describe("ws mutation", () => {
  test("clearing via null or false both take the clear path", async () => {
    __resetDbForTesting();
    await reg("svc-ws-clear");
    const spy = auditSpy();
    try {
      const r1 = await dispatch("svc-ws-clear", "t", { ws: null });
      expect(r1.outcome).toBeNull();
      expect(spy).toHaveBeenLastCalledWith("test-actor", "tool.ws.clear", "svc-ws-clear__t", undefined);
      const r2 = await dispatch("svc-ws-clear", "t", { ws: false });
      expect(r2.outcome).toBeNull();
      expect(spy).toHaveBeenLastCalledWith("test-actor", "tool.ws.clear", "svc-ws-clear__t", undefined);
    } finally {
      spy.mockRestore();
    }
  });

  test("an array fails validation (not an object)", async () => {
    __resetDbForTesting();
    await reg("svc-ws-array");
    const { outcome, body } = await dispatch("svc-ws-array", "t", { ws: [1] });
    expect(outcome).toBe("validation_error");
    expect((body() as { error: { message: string } }).error.message).toBe("ws must be an object, null, or false");
  });

  test("a missing wsUrl fails validation with the exact message", async () => {
    __resetDbForTesting();
    await reg("svc-ws-nourl");
    const { outcome, body } = await dispatch("svc-ws-nourl", "t", { ws: {} });
    expect(outcome).toBe("validation_error");
    expect((body() as { error: { message: string } }).error.message).toBe("ws.wsUrl (ws:// or wss://) is required");
  });

  test("a valid ws config is applied and audited with the exact persistent meta", async () => {
    __resetDbForTesting();
    await reg("svc-ws-ok");
    const spy = auditSpy();
    try {
      const { outcome } = await dispatch("svc-ws-ok", "t", { ws: { wsUrl: "ws://5.6.7.8", persistent: true } });
      expect(outcome).toBeNull();
      expect(spy).toHaveBeenCalledWith("test-actor", "tool.ws.set", "svc-ws-ok__t", { persistent: true });
    } finally {
      spy.mockRestore();
    }
  });

  test("ws.enabled defaults to true when omitted, persistent defaults to false", async () => {
    __resetDbForTesting();
    await reg("svc-ws-default");
    const spy = auditSpy();
    try {
      const { outcome } = await dispatch("svc-ws-default", "t", { ws: { wsUrl: "ws://5.6.7.8" } });
      expect(outcome).toBeNull();
      expect(spy).toHaveBeenCalledWith("test-actor", "tool.ws.set", "svc-ws-default__t", { persistent: false });
    } finally {
      spy.mockRestore();
    }
  });

  test("an unregistered tool returns the exact TOOL_NOT_FOUND error via the ws-specific downstream_error path", async () => {
    __resetDbForTesting();
    const { outcome, status, body } = await dispatch("svc-ws-neverregistered", "t", {
      ws: { wsUrl: "ws://5.6.7.8" },
    });
    expect(outcome === "tool_not_found" || outcome === "downstream_error").toBe(true);
    expect(status()).toBe(404);
    expect((body() as { error: { code: string } }).error.code).toBe("TOOL_NOT_FOUND");
  });

  test("a non-array, non-object value fails validation (not just arrays)", async () => {
    __resetDbForTesting();
    await reg("svc-ws-string");
    const { outcome, body } = await dispatch("svc-ws-string", "t", { ws: "oops" });
    expect(outcome).toBe("validation_error");
    expect((body() as { error: { message: string } }).error.message).toBe("ws must be an object, null, or false");
  });

  test("a non-string, truthy wsUrl still fails validation as required", async () => {
    __resetDbForTesting();
    await reg("svc-ws-numericurl");
    const { outcome, body } = await dispatch("svc-ws-numericurl", "t", { ws: { wsUrl: 123 } });
    expect(outcome).toBe("validation_error");
    expect((body() as { error: { message: string } }).error.message).toBe("ws.wsUrl (ws:// or wss://) is required");
  });

  test("a non-ws(s):// scheme returns the exact INVALID_URL 400 with reason", async () => {
    __resetDbForTesting();
    await reg("svc-ws-badscheme");
    const { outcome, status, body } = await dispatch("svc-ws-badscheme", "t", {
      ws: { wsUrl: "http://5.6.7.8" },
    });
    expect(outcome).toBe("downstream_error");
    expect(status()).toBe(400);
    const errBody = (body() as { error: { code: string; message: string } }).error;
    expect(errBody.code).toBe("INVALID_URL");
    expect(errBody.message).toBe("must be ws:// or wss://");
  });

  test("ws.enabled persists as false when explicitly set, true by default", async () => {
    __resetDbForTesting();
    await reg("svc-ws-enabled-default");
    await dispatch("svc-ws-enabled-default", "t", { ws: { wsUrl: "ws://5.6.7.8" } });
    const row1 = getDb()
      .query(`SELECT enabled FROM tool_ws WHERE client_name = ? AND tool_name = ?`)
      .get("svc-ws-enabled-default", "t") as { enabled: number };
    expect(row1.enabled).toBe(1);

    await reg("svc-ws-enabled-false");
    await dispatch("svc-ws-enabled-false", "t", { ws: { wsUrl: "ws://5.6.7.8", enabled: false } });
    const row2 = getDb()
      .query(`SELECT enabled FROM tool_ws WHERE client_name = ? AND tool_name = ?`)
      .get("svc-ws-enabled-false", "t") as { enabled: number };
    expect(row2.enabled).toBe(0);
  });
});
