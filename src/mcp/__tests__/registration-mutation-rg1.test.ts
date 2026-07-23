import { describe, test, expect, beforeEach } from "bun:test";

// Stryker mutation backstop — RG1 (registration.ts lines 1-140): the module-
// private wsProxyNameCollision(name, requestId) helper (tested indirectly via
// performRestRegistration/performMcpRegistration/performGraphqlRegistration's
// shared name-collision check), the module-private resolveRefs() $ref
// resolver that runs once at module load to build the exported
// resolvedRegistrationSchema constant (tested indirectly via that export's
// resolved shape), and the two small exported pure helpers
// toolsCountCapError() and findToolEndpointError() (tested directly). Each
// test/comment cites the exact line:column, mutator, and replacement it
// kills, per the house convention established across the P2/PX/registry
// mutation-testing series (see stryker.config.mjs's SCOPE HISTORY and the
// sibling src/mcp/__tests__/registry-mutation-rc*.test.ts files).

import {
  performRestRegistration,
  performMcpRegistration,
  performGraphqlRegistration,
  toolsCountCapError,
  findToolEndpointError,
  resolvedRegistrationSchema,
} from "../../mcp/registration.js";
import { registry } from "../../mcp/registry.js";
import { config } from "../../config.js";
import { __resetDbForTesting } from "../../db/connection.js";
import { upsertWsProxyTarget, __resetWsProxyForTesting } from "../../ws-proxy.js";

beforeEach(async () => {
  __resetDbForTesting();
  __resetWsProxyForTesting();
  // The collision fixtures below register ws-proxy targets at ws://127.0.0.1,
  // which `upsertWsProxyTarget` runs through the SSRF validator. Pin this
  // explicitly instead of inheriting it: ALLOW_PRIVATE_IPS is commonly set in a
  // contributor's gitignored .env, so relying on the ambient value passes
  // locally and fails in CI, where no .env exists (same ambient-env gotcha
  // documented in src/lib/__tests__/webhook-mutation.test.ts).
  (config as Record<string, unknown>).allowPrivateIps = true;
  for (const client of registry.listClients()) {
    await registry.unregister(client.name);
  }
});

// ---------------------------------------------------------------------------
// wsProxyNameCollision — L40:14 ObjectLiteral -> '{}'
//
// On a real collision, the function returns:
//   { ok: false, status: 409, body: { error: { code: "NAME_COLLISION",
//     message: `"${name}" is already registered as a WS proxy target`,
//     request_id: requestId } } }
//
// The mutant replaces the inner `{ code, message, request_id }` object
// literal with `{}`, which a mere `res.status === 409` / truthy check would
// never notice (the shape is still `{ok:false, status:409, body:{error:{}}}`
// — status/ok survive untouched). Assert the FULL exact object via
// toEqual(...) for at least one call site (REST), and pin the
// code/message/request_id fields individually for the other two call sites
// (MCP, GraphQL) to prove the shared helper's collision message resolves
// correctly no matter which registration branch invokes it.
// ---------------------------------------------------------------------------

describe("wsProxyNameCollision — L40:14 ObjectLiteral -> '{}' (full RegisterOutcome shape on a name collision)", () => {
  test("performRestRegistration returns the exact 409 NAME_COLLISION outcome when the name is taken by a ws-proxy target", async () => {
    const created = await upsertWsProxyTarget("collide-rest", { backendWsUrl: "ws://127.0.0.1:9" });
    expect(created.ok).toBe(true);

    const outcome = await performRestRegistration(
      { name: "collide-rest", health_url: "http://192.0.2.1/health" },
      undefined,
      "req-rest-1",
    );

    // Full, exact shape — not just a truthy/falsy or status-only check. This
    // is what actually distinguishes the real object from the `{}`-collapsed
    // mutant: an emptied `error` object would fail this toEqual outright.
    expect(outcome).toEqual({
      ok: false,
      status: 409,
      body: {
        error: {
          code: "NAME_COLLISION",
          message: `"collide-rest" is already registered as a WS proxy target`,
          request_id: "req-rest-1",
        },
      },
    });
  });

  test("performMcpRegistration surfaces the same exact NAME_COLLISION fields", async () => {
    const created = await upsertWsProxyTarget("collide-mcp", { backendWsUrl: "ws://127.0.0.1:9" });
    expect(created.ok).toBe(true);

    const outcome = await performMcpRegistration({ name: "collide-mcp" }, undefined, "req-mcp-1");

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected a collision outcome");
    expect(outcome.status).toBe(409);
    expect(outcome.body.error.code).toBe("NAME_COLLISION");
    expect(outcome.body.error.message).toBe(`"collide-mcp" is already registered as a WS proxy target`);
    expect(outcome.body.error.request_id).toBe("req-mcp-1");
  });

  test("performGraphqlRegistration surfaces the same exact NAME_COLLISION fields", async () => {
    const created = await upsertWsProxyTarget("collide-gql", { backendWsUrl: "ws://127.0.0.1:9" });
    expect(created.ok).toBe(true);

    const outcome = await performGraphqlRegistration({ name: "collide-gql" }, undefined, "req-gql-1");

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected a collision outcome");
    expect(outcome.status).toBe(409);
    expect(outcome.body.error.code).toBe("NAME_COLLISION");
    expect(outcome.body.error.message).toBe(`"collide-gql" is already registered as a WS proxy target`);
    expect(outcome.body.error.request_id).toBe("req-gql-1");
  });

  test("baseline: a non-colliding name is unaffected (wsProxyNameCollision returns null, registration proceeds past it)", async () => {
    // Same required fields as the REST collision test above, but no ws-proxy
    // target named "no-collision-here" exists, so this must NOT be a 409 —
    // it should fall through to the next validation step (providedCount === 0
    // here, since neither 'tools' nor 'openapi_url'/'curl_input'/
    // 'postman_collection' is supplied), proving the collision check is not
    // firing unconditionally.
    const outcome = await performRestRegistration(
      { name: "no-collision-here", health_url: "http://192.0.2.1/health" },
      undefined,
      "req-rest-2",
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected a validation-error outcome");
    expect(outcome.status).toBe(400);
    expect(outcome.body.error.code).toBe("VALIDATION_ERROR");
  });
});

// ---------------------------------------------------------------------------
// resolveRefs / resolvedRegistrationSchema — L53:91 (function body
// BlockStatement -> '{}'), L54:23 (ConditionalExpression on the
// `obj === null || typeof obj !== "object"` base case), L55:27
// (ConditionalExpression/BlockStatement on the `Array.isArray(obj)`
// recursion branch), and the `$ref`-resolution branch itself: L60:7
// (ConditionalExpression/LogicalOperator on
// `"$ref" in obj && typeof obj["$ref"] === "string"`), L62:9
// (EqualityOperator on `_schemaComponents == null`), L63:23 (StringLiteral
// inside that branch's thrown error message).
//
// resolveRefs runs exactly once, at module load, against the real bundled
// openapi.yaml — it is not callable directly from a test. Instead we assert
// properties of the resulting `resolvedRegistrationSchema` export that can
// only be correct if EVERY kind of recursion actually ran: object-key
// recursion (L68-71, exercised on every plain schema object), array
// recursion (L55-56, exercised by e.g. `enum`/`required` arrays), and $ref
// resolution (L60-66, exercised by `RegistrationPayload.properties.tools.
// items`, which is `$ref: '#/components/schemas/RestToolDefinition'` in the
// raw src/openapi.yaml, and by that resolved schema's own nested
// `inputSchema` field, which is itself `$ref: '#/components/schemas/
// InputSchema'` in the raw spec — a second, nested $ref one level down).
// ---------------------------------------------------------------------------

type JsonValue = string | number | boolean | null | JsonValue[] | { [k: string]: JsonValue };
type SchemaObj = { [k: string]: JsonValue };

function asObj(v: JsonValue | undefined | null): SchemaObj {
  if (v === null || v === undefined || typeof v !== "object" || Array.isArray(v)) {
    throw new Error(`expected a schema object, got ${JSON.stringify(v)}`);
  }
  return v;
}

function asArr(v: JsonValue | undefined | null): JsonValue[] {
  if (!Array.isArray(v)) {
    throw new Error(`expected an array, got ${JSON.stringify(v)}`);
  }
  return v;
}

describe("resolvedRegistrationSchema — proves resolveRefs's object/array recursion and $ref resolution all ran", () => {
  test("is non-null (the module-load try block succeeded — see L62/L63/L82 equivalence note below)", () => {
    expect(resolvedRegistrationSchema).not.toBeNull();
  });

  test("no unresolved $ref keys survive anywhere in the resolved tree", () => {
    // If the $ref branch (L60-66) were skipped (L60:7 forced false) a raw
    // `{"$ref": "#/components/schemas/RestToolDefinition"}` object would be
    // copied through verbatim by the generic object-recursion loop instead
    // of being replaced by the real target schema.
    expect(JSON.stringify(resolvedRegistrationSchema)).not.toContain("$ref");
  });

  test("top-level object recursion + primitive base case: 'type'/'description' string leaves and the 'required' array survive unchanged", () => {
    const root = asObj(resolvedRegistrationSchema);
    // L54's base case (`typeof obj !== "object"` -> return obj unchanged) is
    // what lets a plain string leaf like `type: "object"` pass through
    // resolveRefs untouched instead of being treated as a nested schema.
    expect(root.type).toBe("object");
    // A plain top-level array with no $ref involvement anywhere near it —
    // isolates L55-56's array-recursion branch from the $ref-branch tests
    // below.
    expect(asArr(root.required)).toEqual(["name"]);
  });

  test("array recursion on a plain (non-$ref) nested array: kind.enum stays a real 3-element array, in order", () => {
    // RegistrationPayload.properties.kind.enum: [rest, graphql, mcp] in the
    // raw spec — a plain array of strings with no $ref anywhere in its
    // subtree. If L55's `Array.isArray(obj)` check were forced false, this
    // array would instead be treated as a plain object and rebuilt via
    // Object.keys() into `{0: "rest", 1: "graphql", 2: "mcp"}` — which
    // toEqual against a real array correctly rejects. If forced true
    // unconditionally, plain (non-array) objects elsewhere in the tree would
    // throw `.map is not a function` during module load, which the
    // non-null check above already catches.
    const root = asObj(resolvedRegistrationSchema);
    const properties = asObj(root.properties);
    const kind = asObj(properties.kind);
    expect(asArr(kind.enum)).toEqual(["rest", "graphql", "mcp"]);
  });

  test("$ref resolution (single level): properties.tools.items resolves to the full RestToolDefinition object shape, not a raw {$ref} stub", () => {
    // Raw spec: properties.tools.items === { $ref: '#/components/schemas/RestToolDefinition' }.
    const root = asObj(resolvedRegistrationSchema);
    const properties = asObj(root.properties);
    const tools = asObj(properties.tools);
    expect(tools.type).toBe("array");
    const items = asObj(tools.items);
    // A corrupted/empty resolution (e.g. the L60:7 condition forced false,
    // leaving the raw $ref object copied through by the generic
    // object-recursion loop) would have `items` still be `{ $ref: "..." }`
    // — no `type`, no `properties` — so these would be undefined instead.
    expect(items.type).toBe("object");
    const itemProps = asObj(items.properties);
    expect(Object.keys(itemProps).sort()).toEqual([
      "description",
      "endpoint",
      "inputSchema",
      "method",
      "name",
      "paramLocations",
    ]);
    // required is itself an array nested inside the $ref-resolved object —
    // pins array-recursion running INSIDE a $ref-resolved subtree too, not
    // just at the top level.
    expect(asArr(items.required)).toEqual(["name", "method", "endpoint", "description", "inputSchema"]);
  });

  test("$ref resolution (nested, two levels deep): tools.items.properties.inputSchema resolves RestToolDefinition's own nested $ref to InputSchema", () => {
    // Raw spec: RestToolDefinition.properties.inputSchema === { $ref:
    // '#/components/schemas/InputSchema' } — this $ref only becomes visible
    // to resolveRefs AFTER the outer RestToolDefinition $ref has already
    // been resolved once (L66's `return resolveRefs(refClone, visited)` is
    // what recurses into the just-cloned RestToolDefinition and discovers
    // this second $ref). A single-level-only resolution would leave this as
    // a raw `{$ref: ...}` stub.
    const root = asObj(resolvedRegistrationSchema);
    const items = asObj(asObj(asObj(root.properties).tools).items);
    const inputSchema = asObj(asObj(items.properties).inputSchema);
    expect(inputSchema.type).toBe("object");
    expect(asArr(inputSchema.required)).toEqual(["type"]);
    const inputSchemaProps = asObj(inputSchema.properties);
    const typeProp = asObj(inputSchemaProps.type);
    // enum array nested three levels inside a doubly-resolved $ref chain —
    // the strongest single assertion available for "recursion genuinely
    // descended all the way down".
    expect(asArr(typeProp.enum)).toEqual(["object"]);
  });
});

// ---------------------------------------------------------------------------
// L62:9 EqualityOperator (`_schemaComponents == null` -> `!= null`), L63:23
// StringLiteral (inside that branch's thrown error message), and L82:7
// StringLiteral -> '""' (the catch block's log message: `log("warn", "Failed
// to pre-load /register/schema", {...})`) are grouped here as DOCUMENTED
// EQUIVALENT / effectively-unreachable-in-practice, per the same reasoning
// pattern used for registry.ts's proven-equivalent survivors (see
// stryker.config.mjs SCOPE HISTORY).
//
// In a healthy checkout, `_schemaComponents` is populated successfully from
// the real, valid src/openapi.yaml before resolveRefs is ever invoked (see
// module-load order: L79 assigns it, L80 calls resolveRefs). The
// `_schemaComponents == null` guard inside resolveRefs's $ref branch (L62)
// therefore never evaluates true during any real resolution — the throw at
// L63 never fires, and the catch block's warn log at L82 never runs either
// (the try block completes without error).
//
// This is empirically verifiable rather than merely asserted: the "is
// non-null" test above already proves it. If L62's `==` were flipped to
// `!=`, the guard would become true on EVERY real $ref (since
// _schemaComponents is genuinely non-null), throwing on the very first
// $ref encountered (`properties.tools.items`) — caught by the try/catch,
// leaving `resolvedRegistrationSchema` (and thus `_resolvedSchema`) null.
// That failure mode is already caught by the "is non-null" test, so L62 is
// NOT actually equivalent — it IS killed, just via the non-null check
// rather than a dedicated test of its own. L63's message-string mutant and
// L82's message-string mutant, by contrast, only affect the *text* passed to
// `log("warn", ...)` on a code path that (per the above) never executes in
// a healthy repo — corrupting the string a throw/log call would have used
// has zero observable effect on any value a caller can read, since the
// throw/log is never reached. These two remain genuinely equivalent /
// unreachable-in-practice. Documented rather than chased with a test that
// would require corrupting the bundled src/openapi.yaml itself.
//
// L82:15 StringLiteral -> '""' — the SAME log call (`log("warn", "Failed to
// pre-load /register/schema", { error: String(err) })`) has a second string
// literal on this line: the "warn" level argument, a distinct AST node from
// the message text at a later column. Same reasoning applies — the whole
// log() call is inside a catch block that never runs against the real spec,
// so mutating "warn" to "" is equally unobservable. Grouped with the L82
// message-string mutant above rather than repeated.
//
// L58:7 ConditionalExpression -> 'false' — resolveRefs's cycle-detection
// guard: `if (visited.has(obj)) return ("$ref" in obj ? obj["$ref"] : obj);`.
// DOCUMENTED EQUIVALENT: `visited.has(obj)` can provably never be true for
// ANY input this function ever receives, real spec or otherwise. Every
// `$ref` resolution clones its target via `JSON.parse(JSON.stringify(...))`
// (L65) before recursing into it — a fresh, uniquely-identified object tree
// with zero structural sharing — and the plain object-recursion branch
// (L68-71) only ever walks forward into a node's own properties, never back
// to an already-visited ancestor. There is therefore no code path in this
// function, for any object graph, where the same object reference can reach
// this check twice. Forcing the guard to `false` is a no-op because the
// guard was never observed to be `true` in the first place, on any input.
//
// L60:7 LogicalOperator (`&&` -> `||` on `"$ref" in obj && typeof
// obj["$ref"] === "string"`) — DOCUMENTED EQUIVALENT, distinct from the
// already-addressed L60:7 ConditionalExpression-forced-false mutant above.
// The `&&`/`||` swap only diverges from real behavior when `"$ref" in obj`
// is true but `obj["$ref"]` is NOT a string (e.g. a number or nested
// object) — a malformed $ref that cannot occur in a valid OpenAPI/JSON
// Schema document, and `src/openapi.yaml` is a fixed, build-time-bundled,
// schema-valid file, not attacker- or caller-controlled input. Every `$ref`
// node resolveRefs ever actually encounters (verified by the "is non-null"
// and "no leftover $ref keys" tests above, which prove every $ref in the
// real file resolved successfully) has a string value, so `&&` and `||`
// agree on every reachable input.
//
// L60:24 ConditionalExpression -> 'true' (the `typeof obj["$ref"] ===
// "string"` right operand forced true) — DOCUMENTED EQUIVALENT, same root
// cause as the L60:7 LogicalOperator note above: on every real $ref this
// codebase's `openapi.yaml` ever contains, the operand is already true, so
// forcing it constant-true changes nothing observable.
//
// L62:9 ConditionalExpression -> 'false' (forces the WHOLE `_schemaComponents
// == null` check to never fire, as opposed to the already-addressed
// EqualityOperator `==`->`!=` variant above) — DOCUMENTED EQUIVALENT. Since
// `_schemaComponents` is genuinely non-null in every real run (verified by
// the "is non-null" test), the real guard already never evaluates true —
// forcing it to permanently-false produces the identical always-false
// behavior on this input, so there is no divergence to observe.
//
// L81:15 BlockStatement -> '{}' (empties the ENTIRE `catch (err) { ... }`
// block body, as opposed to the already-addressed StringLiteral mutants on
// the log call's arguments) and L82:54 ObjectLiteral -> '{}' (empties the
// `{ error: String(err) }` meta object passed to that log call) —
// DOCUMENTED EQUIVALENT, same "catch never runs in a healthy repo" root
// cause covering every mutant inside this block.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// toolsCountCapError — L118:99 (BlockStatement on the if-branch), L119:7
// (ConditionalExpression on `toolsLength > maxToolsPerClient`, and
// EqualityOperator variants of the same comparison).
// ---------------------------------------------------------------------------

describe("toolsCountCapError — L118/L119 boundary + exact message", () => {
  test("exactly at the cap (toolsLength === maxToolsPerClient) returns null — boundary is > not >=", () => {
    expect(toolsCountCapError(5, 5)).toBeNull();
  });

  test("one over the cap returns the exact formatted message", () => {
    expect(toolsCountCapError(6, 5)).toBe("Parsed 6 tools, exceeds maximum of 5");
  });

  test("comfortably under the cap returns null", () => {
    expect(toolsCountCapError(3, 5)).toBeNull();
  });

  test("zero tools against a zero cap is still the boundary (not >) — returns null, not the error string", () => {
    expect(toolsCountCapError(0, 0)).toBeNull();
  });

  test("one tool against a zero cap is over the cap — returns the exact message", () => {
    expect(toolsCountCapError(1, 0)).toBe("Parsed 1 tools, exceeds maximum of 0");
  });
});

// ---------------------------------------------------------------------------
// findToolEndpointError — L132:101 (BlockStatement of the for-loop), L134:9
// (ConditionalExpression on `typeof tool.endpoint === "string"`), L136:11
// (ConditionalExpression on `if (pathError)`), L136:29 (StringLiteral in the
// `Tool "${tool.name}": ${pathError}` template).
// ---------------------------------------------------------------------------

describe("findToolEndpointError — L132/L134/L136 per-tool skip + exact error format", () => {
  test("(a) a tool with a valid endpoint returns null", () => {
    expect(findToolEndpointError([{ name: "get-users", endpoint: "/users" }])).toBeNull();
  });

  test("(b) a tool with a path-traversal endpoint returns the exact 'Tool \"<name>\": <validateEndpointPath message>' format", () => {
    const result = findToolEndpointError([{ name: "get-users", endpoint: "/users/../admin" }]);
    // validateEndpointPath's own exact message format, confirmed against
    // src/mcp/registry.ts's `Endpoint contains invalid path segment: ${endpoint}`.
    expect(result).toBe('Tool "get-users": Endpoint contains invalid path segment: /users/../admin');
  });

  test("(c) a tool whose endpoint is missing entirely is skipped without throwing, not treated as an error", () => {
    expect(findToolEndpointError([{ name: "weird-tool" }])).toBeNull();
  });

  test("(c) a tool whose endpoint is a non-string value is skipped without throwing, not treated as an error", () => {
    expect(findToolEndpointError([{ name: "also-weird", endpoint: 123 }])).toBeNull();
  });

  test("iterates past a valid leading tool to find a traversal error in a later one (L132's for-loop doesn't stop early)", () => {
    const result = findToolEndpointError([
      { name: "ok-tool", endpoint: "/users" },
      { name: "bad-tool", endpoint: "/users/../admin" },
    ]);
    expect(result).toBe('Tool "bad-tool": Endpoint contains invalid path segment: /users/../admin');
  });

  test("an empty tools array returns null (for-loop body never runs)", () => {
    expect(findToolEndpointError([])).toBeNull();
  });
});
