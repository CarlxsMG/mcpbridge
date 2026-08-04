// The admin UI must refuse the same numbers this API refuses.
//
// The create forms validated with a "is it a finite number" check while the routes
// below demand positive integers and a timeout ceiling, so the form happily submitted
// values the server then rejected. Measured against a running backend: monthlyQuota
// -5 and 2.7, endUserRateLimitPerMin 0, and timeoutMs 900000 all passed the form and
// came back 400. The user paid a round trip to learn a rule the page already could
// have told them.
//
// admin-ui/src/utils/fieldConstraints.ts now holds the client's copy of each rule.
// This test is what keeps the copy honest, and it lives HERE rather than in admin-ui
// because this is the only project that can see both sides — admin-ui shares zero
// dependencies with the backend by design, so it cannot import these validators, and
// a test over there could only pin the numbers to themselves.
//
// It reads the client file as text for the same reason: importing a Vue-project module
// from the backend's test run would drag in that project's toolchain.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MAX_GUARD_TIMEOUT_MS } from "../routes/validation.js";

const CLIENT_CONSTRAINTS = join(import.meta.dir, "..", "..", "admin-ui", "src", "utils", "fieldConstraints.ts");
const source = readFileSync(CLIENT_CONSTRAINTS, "utf8");

/** Reads one `export const NAME = { … } as const;` back out of the client source. */
function clientConstraint(name: string): { integer?: boolean; min?: number; max?: number } {
  const match = source.match(new RegExp(`export const ${name} = \\{([^}]*)\\}`));
  if (!match) throw new Error(`${name} is not exported from admin-ui/src/utils/fieldConstraints.ts`);
  const body = match[1];
  const out: { integer?: boolean; min?: number; max?: number } = {};
  if (/integer:\s*true/.test(body)) out.integer = true;
  const min = body.match(/min:\s*([\w.]+)/);
  if (min) out.min = min[1] === "Number.MIN_VALUE" ? Number.MIN_VALUE : Number(min[1].replace(/_/g, ""));
  const max = body.match(/max:\s*([\w.]+)/);
  if (max) out.max = Number(max[1].replace(/_/g, ""));
  return out;
}

describe("admin-ui numeric field constraints match the API", () => {
  test.each([
    // [client constant, what routes/admin/consumers.ts enforces]
    ["CONSUMER_QUOTA", { integer: true, min: 1 }],
    ["CONSUMER_END_USER_RATE_LIMIT", { integer: true, min: 1 }],
    // routes/admin/policies.ts
    ["POLICY_RATE_LIMIT", { min: Number.MIN_VALUE }],
    ["POLICY_TIMEOUT_MS", { min: Number.MIN_VALUE, max: MAX_GUARD_TIMEOUT_MS }],
    // routes/admin/ws-proxy-admin.ts — hand-rolled `Number.isInteger(v) && v >= 1`
    ["WS_MAX_CONNECTIONS", { integer: true, min: 1 }],
    ["WS_MAX_MESSAGE_BYTES", { integer: true, min: 1 }],
    ["WS_IDLE_TIMEOUT_MINUTES", { integer: true, min: 1 }],
  ])("%s", (name, expected) => {
    expect(clientConstraint(name as string)).toEqual(expected);
  });

  test("reads the real file, so a renamed or deleted constant fails loudly", () => {
    expect(() => clientConstraint("NOT_A_REAL_CONSTRAINT")).toThrow(/not exported/);
    // And the ceiling is the backend's own constant, not a number retyped here — if
    // MAX_GUARD_TIMEOUT_MS moves, the POLICY_TIMEOUT_MS case above fails until the
    // client is updated too.
    expect(MAX_GUARD_TIMEOUT_MS).toBe(600_000);
  });
});
