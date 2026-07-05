# Admin route split — P0-2b retrospective

Snapshot from W170-onwards: the 1200-LOC `src/routes/admin.ts` monolith
became a per-entity router directory under `src/routes/admin/`,
with a `legacyMount` fallback for handlers not yet split.

## State (last refactor: 42c9961)

- 18 commits, all green (tsc clean, 1168/1168 tests pass).
- 11 routers extracted (one file per admin entity).
- `src/routes/admin/legacyMount.ts` shrunk **1207 → 414 LOC** (−66%).

## Routers in `src/routes/admin/`

| File | Endpoints | Note |
|---|---:|---|
| `connect.ts` | 1 | `GET /connect/gateway-url` |
| `overview.ts` | 1 | `GET /overview` |
| `users.ts` | 4 | admin user CRUD |
| `audit-log.ts` | 4 | list / verify / actions / export |
| `approvals.ts` | 3 | list + approve + reject |
| `traffic.ts` | 3 | list / get / replay |
| `monitors.ts` | 1 | `GET /monitors` (create/update/delete happens inside `tools.ts` PATCH mutations) |
| `oauth.ts` | 2 | `GET / PUT /clients/:name/oauth` |
| `canary.ts` | 2 | `GET / PUT /clients/:name/canary` |
| `lb.ts` | 5 | `GET / PUT /clients/:name/lb` + upstreams CRUD |
| `clients.ts` | 5 | list / get / PATCH / DELETE / bulk-PATCH |
| `tools.ts` | 8 | bulk enable, test, examples CRUD, breaker reset, cache purge, quarantine clear |

Each router file is small (50–250 LOC), follows the same shape:

```ts
export const <entity>Routes = Router();
<entity>Routes.get("/path", ..., handler);
```

Mounted in `src/routes/admin/index.ts` AFTER `adminAuth` and BEFORE
`mountLegacy(r)`. The barrel `src/routes/admin.ts` re-exports the
public `adminRoutes(app)` so `src/index.ts` doesn't have to change
its import path during the migration.

## What's left in `legacyMount`

**Only one big endpoint** remains:

```http
PATCH /clients/:name/tools/:tool
```

A ~370-LOC handler that internally dispatches on **13 body keys**,
each triggering a different policy mutation + audit recording:

| Body key | Validation | Mutation | Audit action |
|---|---|---|---|
| `enabled` | bool | `registry.setToolEnabled` | `tool.enable` / `tool.disable` |
| `guards` | `validateToolGuardInput` | `registry.setToolGuards` | `tool.guards.update` |
| `overrides` | `validateToolOverrideInput` | `registry.setToolOverride` | `tool.override.update` |
| `sensitive` | bool \| null | `setToolSensitive` | `tool.sensitive.set` |
| `redactPaths` | `string[]` | `setRedactionPaths` | `tool.redaction.set` |
| `guardrails` | `validateGuardrailsInput` | `setGuardrails` | `tool.guardrails.set` |
| `cache` | `validateCacheInput` | `setToolCacheConfig` | `tool.cache.set` / `tool.cache.clear` |
| `coalesce` | `validateCoalesceInput` | `setToolCoalesce` | `tool.coalesce.set` / `tool.coalesce.clear` |
| `mock` | `validateMockInput` | `setToolMock` | `tool.mock.set` / `tool.mock.clear` |
| `transform` | `validateTransformInput` | `setToolTransform` | `tool.transform.set` / `tool.transform.clear` |
| `pagination` | `validatePaginationInput` | `setPaginationConfig` | `tool.pagination.set` |
| `streaming` | `validateStreamingInput` | `setStreamingConfig` | `tool.streaming.set` |
| `contextBudget` | `validateContextBudgetInput` | `setToolContextBudget` | `tool.context_budget.set` |

(Plus a few more: `graphql`, `websocket`, `quarantine` — covered in
the source.)

## Why this isn't yet split

Copying each `if (body.X !== undefined) { validate → set → audit }`
block to its own router file does NOT work: all 13 still need to land
in the same `PATCH` endpoint and run as one atomic operation. The
right shape is a **sub-handler dispatcher**:

1. Define `ToolMutation = { validate(body): Result | ValidationResult, apply(actor, name, tool, value): Result, audit(action, target, body) }`
2. Declare `TOOL_MUTATIONS: Record<string, ToolMutation>` map.
3. The PATCH handler iterates the map (in declaration order) and
   dispatches body keys to the registered sub-handlers.

This is a **structural** refactor, not a move. Behavioural equivalence
needs a test fixture with every body-field combination before it's
safe to merge.

## Suggested next commit (not done here)

```ts
// src/admin/tool-policies/tool-mutations.ts (new)
export interface ToolMutation {
  validate(raw: unknown): { ok: true; value: any } | { ok: false; message: string };
  apply(actor: string, name: string, tool: string, value: any): boolean | Promise<boolean>;
  audit: (value: any) => { action: string; meta?: unknown };
}

export const TOOL_MUTATIONS: Record<string, ToolMutation> = {
  cache: { validate: validateCacheInput, apply: ..., audit: ... },
  coalesce: { ... },
  // ...
};

// legacyMount.ts (PATCH handler becomes ~25 lines):
for (const [key, mutation] of Object.entries(TOOL_MUTATIONS)) {
  if (body[key] === undefined) continue;
  const parsed = mutation.validate(body[key]);
  if (!parsed.ok) { validationError(res, parsed.message); return; }
  const ok = await mutation.apply(actor, name, tool, parsed.value);
  if (!ok) { notFound(res, "TOOL_NOT_FOUND", "Client or tool not found"); return; }
  const { action, meta } = mutation.audit(parsed.value);
  recordAudit(actor, action, toolKey(name, tool), meta);
}
```

Once that lands and behaviour-equivalence tests pass, each
`ToolMutation` entry can move to its own file
(`src/admin/tool-policies/mutations/cache.ts`, …) without
further ceremony, and `legacyMount.ts` will finally be empty enough
to delete outright.

## How to do the next PATCH-mutations refactor

1. Write a fixture file that POSTs every body-field combination to
   the PATCH endpoint against a freshly registered client, captures
   the response + the audit log, and stores the snapshot.
2. Refactor the handler to use the dispatcher. Snapshot the response
   + audit log again.
3. Assert byte-equal before vs after.
4. Land.
5. Move each `ToolMutation` declaration to its own file (one commit
   per move).
6. Delete `legacyMount.ts` once empty.

The snapshot is the contract. Without it, this is a refactor that
can quietly change audit-action strings or log ordering.
