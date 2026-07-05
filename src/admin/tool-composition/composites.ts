import { getDb } from "../../db/connection.js";
import { notifyToolsChanged } from "../../mcp/mcp-server.js";
import { proxyToolCall } from "../../proxy/proxy.js";
import { TOOL_KEY_SEPARATOR } from "../../mcp/registry.js";
import { SEARCH_TOOL_NAME, type AdvertisedTool } from "../../mcp/tool-search.js";
import { log } from "../../logger.js";
import { TOOL_NAME_RE } from "../../lib/identifier.js";
import { createKeyedMutex, reloadLiveCache } from "../../lib/async-lock.js";

/**
 * Composite (a.k.a. virtual/macro) tools: an admin-authored tool that chains
 * several *existing* tool calls into one. Not reachable anywhere by default —
 * a composite must be added to a bundle's `composites[]` (see bundles.ts) to
 * be advertised/callable, at that bundle's /mcp-custom/:bundleName endpoint.
 * Each step forwards to a real `clientName__toolName` through the unchanged
 * proxyToolCall() — so every guard, quota, sensitivity gate, circuit breaker,
 * SSRF pin and guardrail applies to each step exactly as if the caller had
 * invoked it directly. A composite therefore grants no new capability; it
 * only orchestrates. Composites are never registry tools (they carry no `__`
 * separator in their name, so they can't collide with a real tool), never
 * reference other composites (no recursion), and can't be exposed on a
 * sharded /mcp/:clientName endpoint (client-scoped, not cross-client).
 *
 * Step arguments are built from a JSON template that can reference the
 * composite's own input and any prior step's output:
 *   - {"$ref": "input.<dotpath>"}          -> a value from the composite args
 *   - {"$ref": "steps.<i>.text"}           -> raw text of step i's result
 *   - {"$ref": "steps.<i>.json.<dotpath>"} -> a value from step i's parsed JSON
 *   - "literal ${input.x} / ${steps.0.json.id}" -> string interpolation
 */

export interface CompositeStep {
  targetClient: string;
  targetTool: string;
  /** JSON template resolved against {input, steps} to produce the step's arguments. */
  argsTemplate: Record<string, unknown>;
}

export interface CompositeSummary {
  name: string;
  description: string | null;
  enabled: boolean;
  stepsCount: number;
}

export interface CompositeDetail {
  name: string;
  description: string | null;
  enabled: boolean;
  inputSchema: Record<string, unknown>;
  steps: CompositeStep[];
  createdAt: number;
  updatedAt: number;
}

export type CompositeMutationError =
  | { code: "INVALID_NAME"; message: string }
  | { code: "INVALID_SCHEMA"; message: string }
  | { code: "INVALID_STEPS"; message: string }
  | { code: "ALREADY_EXISTS"; message: string }
  | { code: "NOT_FOUND"; message: string }
  | { code: "UNKNOWN_TOOL"; message: string };

export type CompositeMutationResult = { ok: true } | { ok: false; error: CompositeMutationError };

interface LiveComposite {
  enabled: boolean;
  description: string | null;
  inputSchema: Record<string, unknown>;
  steps: CompositeStep[];
}

/** Hot-path cache (name -> composite), loaded once at boot and kept in sync on every mutation — mirrors bundles.ts. */
const liveComposites = new Map<string, LiveComposite>();

// Per-composite-name async mutex — same shape as bundles.ts's (see
// lib/async-lock.ts's createKeyedMutex).
const { withLock } = createKeyedMutex();

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

/** Composite names must be tool-name-shaped but MUST NOT contain the `__` separator (would shadow a real tool) or be reserved. */
export function isValidCompositeName(name: string): boolean {
  return TOOL_NAME_RE.test(name) && !name.includes(TOOL_KEY_SEPARATOR) && name !== SEARCH_TOOL_NAME;
}

function validateSteps(db: ReturnType<typeof getDb>, steps: CompositeStep[]): CompositeMutationError | null {
  if (!Array.isArray(steps) || steps.length === 0) {
    return { code: "INVALID_STEPS", message: "A composite needs at least one step" };
  }
  const exists = db.query(`SELECT 1 FROM tools WHERE client_name = ? AND name = ?`);
  for (const s of steps) {
    if (typeof s.targetClient !== "string" || typeof s.targetTool !== "string") {
      return { code: "INVALID_STEPS", message: "Each step needs targetClient and targetTool" };
    }
    if (typeof s.argsTemplate !== "object" || s.argsTemplate === null || Array.isArray(s.argsTemplate)) {
      return { code: "INVALID_STEPS", message: "Each step's argsTemplate must be an object" };
    }
    if (!exists.get(s.targetClient, s.targetTool)) {
      return { code: "UNKNOWN_TOOL", message: `Unknown tool "${s.targetClient}${TOOL_KEY_SEPARATOR}${s.targetTool}"` };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Boot + hot-path reads
// ---------------------------------------------------------------------------

/** Loads every composite (and its steps) from SQLite into the cache. Call once at boot after migrations. */
export function initComposites(): void {
  const db = getDb();
  const rows = db.query(`SELECT name, description, enabled, input_schema_json FROM composite_tools`).all() as {
    name: string;
    description: string | null;
    enabled: number;
    input_schema_json: string;
  }[];
  const stepStmt = db.query(
    `SELECT target_client, target_tool, args_template_json FROM composite_tool_steps WHERE composite_name = ? ORDER BY step_order`,
  );
  const count = reloadLiveCache(liveComposites, (cache) => {
    for (const r of rows) {
      const steps = (
        stepStmt.all(r.name) as { target_client: string; target_tool: string; args_template_json: string }[]
      ).map((s) => ({
        targetClient: s.target_client,
        targetTool: s.target_tool,
        argsTemplate: JSON.parse(s.args_template_json) as Record<string, unknown>,
      }));
      cache.set(r.name, {
        enabled: r.enabled === 1,
        description: r.description,
        inputSchema: JSON.parse(r.input_schema_json) as Record<string, unknown>,
        steps,
      });
    }
  });
  log("info", "Loaded composite tools", { count });
}

/** Whether `name` is a known composite (enabled or not). Used to route tools/call. */
export function hasComposite(name: string): boolean {
  return liveComposites.has(name);
}

/** Advertised (tools/list) definitions for every enabled composite. */
export function listAdvertisedComposites(): AdvertisedTool[] {
  const out: AdvertisedTool[] = [];
  for (const [name, c] of liveComposites) {
    if (c.enabled)
      out.push({ name, description: c.description ?? `Composite tool: ${name}`, inputSchema: c.inputSchema });
  }
  return out;
}

/** Single-name lookup for a bundle's tools/list — undefined for unknown OR disabled (same "don't advertise" rule as listAdvertisedComposites). */
export function getAdvertisedComposite(name: string): AdvertisedTool | undefined {
  const c = liveComposites.get(name);
  if (!c?.enabled) return undefined;
  return { name, description: c.description ?? `Composite tool: ${name}`, inputSchema: c.inputSchema };
}

// ---------------------------------------------------------------------------
// Argument templating
// ---------------------------------------------------------------------------

interface RunContext {
  input: Record<string, unknown>;
  steps: { text: string; json: unknown }[];
}

function getByPath(root: unknown, path: string): unknown {
  if (path === "") return root;
  let node: unknown = root;
  for (const seg of path.split(".")) {
    if (node === null || node === undefined) return undefined;
    if (Array.isArray(node)) {
      const idx = Number(seg);
      node = Number.isInteger(idx) ? node[idx] : undefined;
    } else if (typeof node === "object") {
      node = (node as Record<string, unknown>)[seg];
    } else {
      return undefined;
    }
  }
  return node;
}

/** Resolves a "$ref"-style path (input.* / steps.<i>.text / steps.<i>.json.*) against the run context. */
export function resolveRef(ref: string, ctx: RunContext): unknown {
  const parts = ref.split(".");
  const head = parts[0];
  if (head === "input") return getByPath(ctx.input, parts.slice(1).join("."));
  if (head === "steps") {
    const idx = Number(parts[1]);
    if (!Number.isInteger(idx)) return undefined;
    const step = ctx.steps[idx];
    if (!step) return undefined;
    const sub = parts[2];
    if (sub === "text") return step.text;
    if (sub === "json") return getByPath(step.json, parts.slice(3).join("."));
    return undefined;
  }
  return undefined;
}

function interpolate(str: string, ctx: RunContext): string {
  return str.replace(/\$\{([^}]+)\}/g, (_m, path: string) => {
    const v = resolveRef(path.trim(), ctx);
    if (v === undefined || v === null) return "";
    return typeof v === "object" ? JSON.stringify(v) : String(v);
  });
}

/** Recursively resolves a template node into concrete args, honouring `$ref` objects and `${}` string interpolation. */
export function resolveTemplate(node: unknown, ctx: RunContext): unknown {
  if (Array.isArray(node)) return node.map((n) => resolveTemplate(n, ctx));
  if (node !== null && typeof node === "object") {
    const keys = Object.keys(node as Record<string, unknown>);
    if (keys.length === 1 && keys[0] === "$ref" && typeof (node as Record<string, unknown>).$ref === "string") {
      return resolveRef((node as Record<string, unknown>).$ref as string, ctx);
    }
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) out[k] = resolveTemplate(v, ctx);
    return out;
  }
  if (typeof node === "string") return interpolate(node, ctx);
  return node;
}

function extractText(result: { content: Array<{ type: string; text: string }> }): string {
  return result.content
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}

// ---------------------------------------------------------------------------
// Runner — executes a composite by chaining proxyToolCall over its steps
// ---------------------------------------------------------------------------

/**
 * Runs a composite: resolves each step's args from prior context, forwards to
 * the real tool through proxyToolCall (full guard stack), and threads the
 * output forward. Short-circuits on the first step error and returns the last
 * step's result on success.
 */
export async function runComposite(
  name: string,
  args: Record<string, unknown>,
  callerToken?: string,
): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
  const comp = liveComposites.get(name);
  if (!comp) return { isError: true, content: [{ type: "text", text: `Unknown composite tool: ${name}` }] };
  if (!comp.enabled)
    return { isError: true, content: [{ type: "text", text: `Composite tool '${name}' is disabled` }] };
  if (comp.steps.length === 0)
    return { isError: true, content: [{ type: "text", text: `Composite tool '${name}' has no steps` }] };

  const ctx: RunContext = { input: args ?? {}, steps: [] };
  let last: { content: Array<{ type: string; text: string }>; isError?: boolean } = { content: [] };

  for (let i = 0; i < comp.steps.length; i++) {
    const step = comp.steps[i];
    const target = `${step.targetClient}${TOOL_KEY_SEPARATOR}${step.targetTool}`;
    const resolved = resolveTemplate(step.argsTemplate, ctx);
    if (resolved === null || typeof resolved !== "object" || Array.isArray(resolved)) {
      return {
        isError: true,
        content: [{ type: "text", text: `Composite '${name}' step ${i + 1} produced non-object arguments` }],
      };
    }
    const result = await proxyToolCall(target, resolved as Record<string, unknown>, callerToken);
    const text = extractText(result);
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
    ctx.steps.push({ text, json });
    last = result;
    if (result.isError) {
      return {
        isError: true,
        content: [{ type: "text", text: `Composite '${name}' failed at step ${i + 1} (${target}): ${text}` }],
      };
    }
  }

  return { content: last.content };
}

// ---------------------------------------------------------------------------
// Admin CRUD
// ---------------------------------------------------------------------------

export function listComposites(): CompositeSummary[] {
  const db = getDb();
  const rows = db
    .query(
      `SELECT c.name, c.description, c.enabled, COUNT(s.step_order) as steps_count
       FROM composite_tools c LEFT JOIN composite_tool_steps s ON s.composite_name = c.name
       GROUP BY c.name ORDER BY c.name`,
    )
    .all() as { name: string; description: string | null; enabled: number; steps_count: number }[];
  return rows.map((r) => ({
    name: r.name,
    description: r.description,
    enabled: r.enabled === 1,
    stepsCount: r.steps_count,
  }));
}

export function getCompositeDetail(name: string): CompositeDetail | undefined {
  const db = getDb();
  const row = db
    .query(
      `SELECT name, description, enabled, input_schema_json, created_at, updated_at FROM composite_tools WHERE name = ?`,
    )
    .get(name) as {
    name: string;
    description: string | null;
    enabled: number;
    input_schema_json: string;
    created_at: number;
    updated_at: number;
  } | null;
  if (!row) return undefined;
  const steps = (
    db
      .query(
        `SELECT target_client, target_tool, args_template_json FROM composite_tool_steps WHERE composite_name = ? ORDER BY step_order`,
      )
      .all(name) as { target_client: string; target_tool: string; args_template_json: string }[]
  ).map((s) => ({
    targetClient: s.target_client,
    targetTool: s.target_tool,
    argsTemplate: JSON.parse(s.args_template_json) as Record<string, unknown>,
  }));
  return {
    name: row.name,
    description: row.description,
    enabled: row.enabled === 1,
    inputSchema: JSON.parse(row.input_schema_json) as Record<string, unknown>,
    steps,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function refreshCache(name: string): void {
  const detail = getCompositeDetail(name);
  if (!detail) {
    liveComposites.delete(name);
    return;
  }
  liveComposites.set(name, {
    enabled: detail.enabled,
    description: detail.description,
    inputSchema: detail.inputSchema,
    steps: detail.steps,
  });
}

export async function createComposite(
  name: string,
  description: string | undefined,
  inputSchema: Record<string, unknown>,
  steps: CompositeStep[],
  actor: string,
): Promise<CompositeMutationResult> {
  if (!isValidCompositeName(name)) {
    return {
      ok: false,
      error: {
        code: "INVALID_NAME",
        message: "Composite name must match /^[a-z0-9][a-z0-9_-]{0,62}$/ and not contain '__'",
      },
    };
  }
  if (
    typeof inputSchema !== "object" ||
    inputSchema === null ||
    (inputSchema as Record<string, unknown>).type !== "object"
  ) {
    return {
      ok: false,
      error: { code: "INVALID_SCHEMA", message: "inputSchema must be an object schema (type: object)" },
    };
  }
  return withLock(name, async () => {
    const db = getDb();
    if (db.query(`SELECT 1 FROM composite_tools WHERE name = ?`).get(name)) {
      return { ok: false, error: { code: "ALREADY_EXISTS", message: `Composite "${name}" already exists` } };
    }
    const stepError = validateSteps(db, steps);
    if (stepError) return { ok: false, error: stepError };

    const now = Date.now();
    const txn = db.transaction(() => {
      db.query(
        `INSERT INTO composite_tools (name, description, input_schema_json, enabled, created_at, updated_at, created_by)
         VALUES (?, ?, ?, 1, ?, ?, ?)`,
      ).run(name, description ?? null, JSON.stringify(inputSchema), now, now, actor);
      const insert = db.query(
        `INSERT INTO composite_tool_steps (composite_name, step_order, target_client, target_tool, args_template_json) VALUES (?, ?, ?, ?, ?)`,
      );
      steps.forEach((s, i) => insert.run(name, i, s.targetClient, s.targetTool, JSON.stringify(s.argsTemplate)));
    });
    txn();

    refreshCache(name);
    notifyToolsChanged();
    return { ok: true };
  });
}

export async function updateComposite(
  name: string,
  updates: {
    description?: string | null;
    enabled?: boolean;
    inputSchema?: Record<string, unknown>;
    steps?: CompositeStep[];
  },
): Promise<CompositeMutationResult> {
  return withLock(name, async () => {
    const db = getDb();
    if (!db.query(`SELECT 1 FROM composite_tools WHERE name = ?`).get(name)) {
      return { ok: false, error: { code: "NOT_FOUND", message: `Composite "${name}" not found` } };
    }
    if (updates.inputSchema !== undefined) {
      if (
        typeof updates.inputSchema !== "object" ||
        updates.inputSchema === null ||
        updates.inputSchema.type !== "object"
      ) {
        return {
          ok: false,
          error: { code: "INVALID_SCHEMA", message: "inputSchema must be an object schema (type: object)" },
        };
      }
    }
    if (updates.steps !== undefined) {
      const stepError = validateSteps(db, updates.steps);
      if (stepError) return { ok: false, error: stepError };
    }

    const now = Date.now();
    const txn = db.transaction(() => {
      if (updates.description !== undefined)
        db.query(`UPDATE composite_tools SET description = ?, updated_at = ? WHERE name = ?`).run(
          updates.description,
          now,
          name,
        );
      if (updates.enabled !== undefined)
        db.query(`UPDATE composite_tools SET enabled = ?, updated_at = ? WHERE name = ?`).run(
          updates.enabled ? 1 : 0,
          now,
          name,
        );
      if (updates.inputSchema !== undefined)
        db.query(`UPDATE composite_tools SET input_schema_json = ?, updated_at = ? WHERE name = ?`).run(
          JSON.stringify(updates.inputSchema),
          now,
          name,
        );
      if (updates.steps !== undefined) {
        db.query(`DELETE FROM composite_tool_steps WHERE composite_name = ?`).run(name);
        const insert = db.query(
          `INSERT INTO composite_tool_steps (composite_name, step_order, target_client, target_tool, args_template_json) VALUES (?, ?, ?, ?, ?)`,
        );
        updates.steps.forEach((s, i) =>
          insert.run(name, i, s.targetClient, s.targetTool, JSON.stringify(s.argsTemplate)),
        );
        db.query(`UPDATE composite_tools SET updated_at = ? WHERE name = ?`).run(now, name);
      }
    });
    txn();

    refreshCache(name);
    // Name/schema/enabled/steps all change what tools/list advertises or how it
    // behaves; a description-only edit does not, but re-notifying is harmless.
    const scopeChanged =
      updates.enabled !== undefined || updates.inputSchema !== undefined || updates.steps !== undefined;
    if (scopeChanged) notifyToolsChanged();
    return { ok: true };
  });
}

export async function deleteComposite(name: string): Promise<boolean> {
  return withLock(name, async () => {
    const db = getDb();
    const result = db.query(`DELETE FROM composite_tools WHERE name = ?`).run(name);
    if (result.changes === 0) return false;
    liveComposites.delete(name);
    notifyToolsChanged();
    return true;
  });
}
