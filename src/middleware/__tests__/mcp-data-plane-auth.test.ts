/**
 * Regression tests for the MCP data-plane "open mode" and its REQUIRE_MCP_AUTH
 * opt-out (src/middleware/auth.ts). Locks in the fix for the fail-open gap:
 * with no auth material configured the data plane historically accepted any
 * caller, and REQUIRE_MCP_AUTH=true must force it closed.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { config } from "../../config.js";
import { __resetDbForTesting } from "../../db/connection.js";
import { isMcpDataPlaneOpen, evaluateMcpAuth } from "../auth.js";

const saved = {
  mcpApiKeys: config.mcpApiKeys,
  requireMcpAuth: config.requireMcpAuth,
  jwtJwksUrl: config.jwtJwksUrl,
  authDisabled: config.authDisabled,
};

beforeEach(() => {
  __resetDbForTesting(); // fresh :memory: DB — no managed MCP keys
  const c = config as Record<string, unknown>;
  c.mcpApiKeys = [];
  c.requireMcpAuth = false;
  c.jwtJwksUrl = undefined;
  c.authDisabled = false;
});

afterEach(() => {
  Object.assign(config as Record<string, unknown>, saved);
});

describe("MCP data-plane open mode", () => {
  test("with no auth material at all, the data plane is open (backward-compat)", async () => {
    expect(isMcpDataPlaneOpen()).toBe(true);
    const verdict = await evaluateMcpAuth({});
    expect(verdict.ok).toBe(true);
  });

  test("REQUIRE_MCP_AUTH=true forces the data plane closed even before a key exists", async () => {
    (config as Record<string, unknown>).requireMcpAuth = true;
    expect(isMcpDataPlaneOpen()).toBe(false);
    const verdict = await evaluateMcpAuth({});
    expect(verdict.ok).toBe(false);
    expect(verdict.status).toBe(401);
  });

  test("configuring an env MCP key also closes open mode (no REQUIRE_MCP_AUTH needed)", async () => {
    (config as Record<string, unknown>).mcpApiKeys = ["some-key"];
    expect(isMcpDataPlaneOpen()).toBe(false);
    // A request with no token is now rejected rather than allowed through.
    const verdict = await evaluateMcpAuth({});
    expect(verdict.ok).toBe(false);
  });
});
