/**
 * Stryker mutation-testing backstop for src/backend-auth/upstream-auth.ts.
 * Baseline 76.47% (39/51) — the existing upstream-auth.test.ts covers store
 * CRUD and the bearer/basic/header proxy-injection happy paths plus one
 * wrong-key decrypt-failure case, but never spies on the decrypt-failure log
 * call itself, never feeds a "basic" secret missing one of username/password,
 * never feeds a "header" row missing headerName or value, never exercises an
 * unrecognized auth_type (the switch's `default` branch), and never calls
 * getUpstreamAuthHeaders for a client with no row at all.
 */
import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { config } from "../../config.js";
import { __resetDbForTesting } from "../../db/connection.js";
import { registry } from "../../mcp/registry.js";
import * as loggerMod from "../../logger.js";
import { setUpstreamAuth, getUpstreamAuthHeaders } from "../../backend-auth/upstream-auth.js";
import type { UpstreamAuthType, UpstreamSecret } from "../../backend-auth/upstream-auth.js";
import type { RestToolDefinition } from "../../mcp/types.js";

const CLIENT = "svc";
const originalKey = config.secretEncryptionKey;

function makeTool(): RestToolDefinition {
  return {
    name: "get-users",
    method: "GET",
    endpoint: "/users",
    description: "x",
    inputSchema: { type: "object", properties: {} },
  };
}
async function reg(): Promise<void> {
  await registry.register(
    CLIENT,
    [makeTool()],
    "http://example.com/health",
    "1.2.3.4",
    "http://example.com",
    "1.2.3.4",
  );
}

beforeEach(async () => {
  __resetDbForTesting();
  (config as Record<string, unknown>).secretEncryptionKey = Buffer.alloc(32, 9).toString("base64");
  for (const c of registry.listClients()) await registry.unregister(c.name);
});
afterEach(async () => {
  (config as Record<string, unknown>).secretEncryptionKey = originalKey;
  for (const c of registry.listClients()) await registry.unregister(c.name);
});

// 72:7-72:11 ConditionalExpression [Survived] false (`!row` forced false).
// The internal crash on a null row's `.secret_enc` is swallowed by the same
// catch block that handles genuine decrypt failures, so the return value
// (null either way) can't distinguish real from mutant — but the mutant
// reaches far enough into the try block to trigger the decrypt-failure LOG
// call, which the real early-return never does.
describe("getUpstreamAuthHeaders — an unconfigured client short-circuits before any decrypt attempt", () => {
  test("no row at all returns null without logging a decrypt failure", async () => {
    await reg();
    const spy = spyOn(loggerMod, "log");
    try {
      expect(getUpstreamAuthHeaders(CLIENT)).toBeNull();
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});

// 78:9-78:15 StringLiteral [Survived] `""` ("warn" emptied), 78:17-78:86
// StringLiteral [Survived] `""` (the message text emptied), 78:88-78:110
// ObjectLiteral [Survived] (the `{ client: clientName }` meta emptied). The
// existing wrong-key test proves the proxy proceeds unauthenticated, but
// never inspects the log call itself.
describe("getUpstreamAuthHeaders — a decrypt failure logs a warning with the client name", () => {
  test("a wrong encryption key logs exactly the expected level/message/meta", async () => {
    await reg();
    setUpstreamAuth(CLIENT, "bearer", { token: "up-secret" }, null);
    (config as Record<string, unknown>).secretEncryptionKey = Buffer.alloc(32, 1).toString("base64");
    const spy = spyOn(loggerMod, "log");
    try {
      expect(getUpstreamAuthHeaders(CLIENT)).toBeNull();
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0][0]).toBe("warn");
      expect(spy.mock.calls[0][1]).toBe("Failed to decrypt upstream auth — is SECRET_ENCRYPTION_KEY correct?");
      expect(spy.mock.calls[0][2]).toEqual({ client: CLIENT });
    } finally {
      spy.mockRestore();
    }
  });
});

// 86:14-86:76 ConditionalExpression/LogicalOperator [Survived] (the whole
// `secret.username !== undefined && secret.password !== undefined` guard,
// forced true / turned into `||`), 86:14-86:43 and 86:47-86:76
// ConditionalExpression [Survived] true (each half forced true
// individually). Two tests, each with exactly one field present, are needed
// to isolate both halves and the `&&`-vs-`||` swap: neither field missing
// alone converges with the other on the SAME outcome as the other test.
describe("basic auth requires BOTH username and password, not either alone", () => {
  test("username present, password missing (undefined) returns null", async () => {
    await reg();
    setUpstreamAuth(CLIENT, "basic", { username: "u" } as unknown as UpstreamSecret, null);
    expect(getUpstreamAuthHeaders(CLIENT)).toBeNull();
  });
  test("password present, username missing (undefined) returns null", async () => {
    await reg();
    setUpstreamAuth(CLIENT, "basic", { password: "p" } as unknown as UpstreamSecret, null);
    expect(getUpstreamAuthHeaders(CLIENT)).toBeNull();
  });
});

// 90:14-90:59 ConditionalExpression/LogicalOperator [Survived] (the whole
// `row.header_name && secret.value !== undefined` guard, forced true /
// turned into `||`), 90:33-90:59 ConditionalExpression [Survived] true (the
// second half alone forced true). Mirrors the basic-auth pair above: one
// test per missing half.
describe("header auth requires BOTH a headerName and a value, not either alone", () => {
  test("a value with no configured headerName returns null, not { null: value }", async () => {
    await reg();
    setUpstreamAuth(CLIENT, "header", { value: "abc123" }, null);
    expect(getUpstreamAuthHeaders(CLIENT)).toBeNull();
  });
  test("a configured headerName with no value returns null, not { headerName: undefined }", async () => {
    await reg();
    setUpstreamAuth(CLIENT, "header", {} as unknown as UpstreamSecret, "X-Api-Key");
    expect(getUpstreamAuthHeaders(CLIENT)).toBeNull();
  });
});

// 91:5-92:19 ConditionalExpression [Survived] (Stryker's switch-mutator on
// the `default: return null;` branch) — no existing test ever configures an
// unrecognized auth_type at all.
describe("an unrecognized auth_type falls through the switch's default branch", () => {
  test("a bogus auth_type returns null", async () => {
    await reg();
    setUpstreamAuth(CLIENT, "totally-bogus" as UpstreamAuthType, { token: "x" }, null);
    expect(getUpstreamAuthHeaders(CLIENT)).toBeNull();
  });
});
