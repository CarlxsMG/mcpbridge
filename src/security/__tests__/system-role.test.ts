import { beforeEach, describe, expect, test } from "bun:test";

import { __resetDbForTesting } from "../../db/connection.js";
import { createMcpKey } from "../mcp-key-store.js";
import { resolveSystemRole } from "../system-role.js";
import { withConfig } from "../../__tests__/_utils/with-config.js";

// ---------------------------------------------------------------------------
// resolveSystemRole — direct unit tests (Stryker mutation backstop for
// src/security/system-role.ts, the /mcp control-plane fail-closed auth). It
// was the worst-covered security file at the P2-3 baseline (60%, 10 mutants
// survived): auth.test.ts only drives it through rootMcpAuth and never asserts
// on the resolved grant object field-by-field. Each block below names the
// mutant(s) it kills by line + replacement.
// ---------------------------------------------------------------------------

beforeEach(() => {
  __resetDbForTesting();
});

describe("resolveSystemRole — AUTH_DISABLED escape hatch", () => {
  // Kills all 5 L30 mutants on
  //   `if (config.authDisabled) return { role: "admin", elevated: true, keyId: null, isEnvBearer: true }`
  //   * ConditionalExpression → `if (false)` — proven by passing UNDEFINED: the
  //     short-circuit must fire BEFORE the `!token` guard, so a `if (false)`
  //     mutant falls through to `!token` and returns null instead of the grant.
  //   * ObjectLiteral → `{}`, StringLiteral `"admin"` → `""`, and both
  //     BooleanLiterals `true` → `false` — pinned by toEqual on the full object.
  test("returns a full admin grant for any token, even undefined (kills all 5 L30 mutants)", () => {
    withConfig({ authDisabled: true }, () => {
      expect(resolveSystemRole(undefined)).toEqual({
        role: "admin",
        elevated: true,
        keyId: null,
        isEnvBearer: true,
      });
    });
  });
});

describe("resolveSystemRole — no 'allow all' fallback, fails closed", () => {
  // Kills L31 ConditionalExpression (`if (!token) return null` → `if (false)`).
  // Seeding adminApiKeys with "" is pathological on purpose: without the guard,
  // the mutant falls through to `adminApiKeys.some(safeCompare(key, ""))`, which
  // matches "" and wrongly returns an admin grant. The guarded result is null.
  test("empty token returns null even if '' is a configured admin key (kills L31)", () => {
    withConfig({ authDisabled: false, adminApiKeys: [""] }, () => {
      expect(resolveSystemRole("")).toBeNull();
    });
  });

  test("an unknown token with nothing configured returns null", () => {
    withConfig({ authDisabled: false, adminApiKeys: [] }, () => {
      expect(resolveSystemRole("mcp_nobody")).toBeNull();
    });
  });
});

describe("resolveSystemRole — env admin bearer", () => {
  // Kills L33 MethodExpression (`config.adminApiKeys.some` → `.every`) and the
  // L34 BooleanLiteral in the returned grant. Two configured keys where only the
  // SECOND matches separate some (true) from every (false); toEqual pins the
  // flags so a `true` → `false` flip is caught.
  test("matches one of several env admin keys → elevated env grant (kills L33 some→every, L34 BooleanLiteral)", () => {
    withConfig({ authDisabled: false, adminApiKeys: ["decoy-admin-key", "real-admin-key"] }, () => {
      expect(resolveSystemRole("real-admin-key")).toEqual({
        role: "admin",
        elevated: true,
        keyId: null,
        isEnvBearer: true,
      });
    });
  });
});

describe("resolveSystemRole — managed MCP keys", () => {
  // Kills L38 LogicalOperator (`rec && rec.adminRole` → `rec || rec.adminRole`).
  // A key that RESOLVES (rec truthy) but carries NO adminRole must not grant
  // system access; the `||` mutant enters the block and returns a role:null
  // grant instead of null.
  test("a resolvable key without adminRole returns null (kills L38 &&→||)", () => {
    withConfig({ authDisabled: false, adminApiKeys: [] }, () => {
      const { rawKey } = createMcpKey("no-system-role", null, null, null); // adminRole defaults to null
      expect(resolveSystemRole(rawKey)).toBeNull();
    });
  });

  // Kills L38 ConditionalExpression (`if (rec && rec.adminRole)` → `if (true)`).
  // For an unknown token rec is null; `if (true)` calls touchMcpKeyLastUsed on
  // null.id and throws. The guarded path returns null cleanly.
  test("an unknown token never enters the managed-key block (kills L38 Conditional→true)", () => {
    withConfig({ authDisabled: false, adminApiKeys: [] }, () => {
      expect(resolveSystemRole("mcp_ghost-token")).toBeNull();
    });
  });

  test("a resolvable key WITH adminRole returns that role as a managed (non-env) grant", () => {
    withConfig({ authDisabled: false, adminApiKeys: [] }, () => {
      const { record, rawKey } = createMcpKey("ops", null, null, "tester", null, true, "operator");
      expect(resolveSystemRole(rawKey)).toEqual({
        role: "operator",
        elevated: true,
        keyId: record.id,
        isEnvBearer: false,
      });
    });
  });
});
