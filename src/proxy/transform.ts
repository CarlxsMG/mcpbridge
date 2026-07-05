/**
 * Per-tool declarative request/response transformation (dependency-free).
 *
 * An admin can reshape a tool's arguments (before the upstream call) and/or its
 * JSON response (before redaction) without touching code, via an ordered list of
 * safe operations — no expression eval, so there's no injection surface:
 *   - set    { path, value }  inject/overwrite a constant at a dot-path
 *   - remove { path }         delete a dot-path
 *   - rename { from, to }     move a value
 *   - copy   { from, to }     duplicate a value
 *
 * Request ops run AFTER Ajv validation/stripping (so an injected field the MCP
 * inputSchema doesn't declare survives to the backend). Response ops run on the
 * parsed JSON body before redaction.
 */
import { getDb } from "../db/connection.js";
import { toolExists, upsertConfig } from "../lib/tool-config.js";

export type TransformOp =
  | { op: "set"; path: string; value: unknown }
  | { op: "remove"; path: string }
  | { op: "rename"; from: string; to: string }
  | { op: "copy"; from: string; to: string };

export interface ToolTransform {
  enabled: boolean;
  request: TransformOp[];
  response: TransformOp[];
}

export const MAX_TRANSFORM_OPS = 50;

interface TransformRow {
  request_json: string;
  response_json: string;
  enabled: number;
}

export function getToolTransform(clientName: string, toolName: string): ToolTransform | null {
  const row = getDb()
    .query(`SELECT request_json, response_json, enabled FROM tool_transforms WHERE client_name = ? AND tool_name = ?`)
    .get(clientName, toolName) as TransformRow | null;
  if (!row) return null;
  return {
    enabled: row.enabled === 1,
    request: safeParseOps(row.request_json),
    response: safeParseOps(row.response_json),
  };
}

/** Persists (or clears with null) a tool's transform config. False when the tool is unknown. */
export function setToolTransform(
  clientName: string,
  toolName: string,
  input: { enabled: boolean; request: TransformOp[]; response: TransformOp[] } | null,
): boolean {
  if (!toolExists(clientName, toolName)) return false;

  if (input === null) {
    getDb().query(`DELETE FROM tool_transforms WHERE client_name = ? AND tool_name = ?`).run(clientName, toolName);
    return true;
  }
  upsertConfig(
    "tool_transforms",
    { client_name: clientName, tool_name: toolName },
    {
      request_json: JSON.stringify(input.request),
      response_json: JSON.stringify(input.response),
      enabled: input.enabled ? 1 : 0,
    },
    Date.now(),
  );
  return true;
}

function safeParseOps(json: string): TransformOp[] {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? (v as TransformOp[]) : [];
  } catch {
    return [];
  }
}

// ── Pure application (unit-tested; used by the proxy) ───────────────────────

function getByPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const key of path.split(".")) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

function setByPath(obj: Record<string, unknown>, path: string, value: unknown): void {
  const keys = path.split(".");
  let cur = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    const k = keys[i];
    const child = cur[k];
    if (child === null || typeof child !== "object" || Array.isArray(child)) cur[k] = {};
    cur = cur[k] as Record<string, unknown>;
  }
  cur[keys[keys.length - 1]] = value;
}

function removeByPath(obj: Record<string, unknown>, path: string): void {
  const keys = path.split(".");
  let cur: Record<string, unknown> = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    const child = cur[keys[i]];
    if (child === null || typeof child !== "object") return;
    cur = child as Record<string, unknown>;
  }
  delete cur[keys[keys.length - 1]];
}

/**
 * Applies an ordered op list to a JSON value, returning a new value (the input
 * is never mutated). Non-object inputs (including arrays) are returned unchanged
 * — the ops address object dot-paths.
 */
export function applyOps(input: unknown, ops: TransformOp[]): unknown {
  if (input === null || typeof input !== "object") return input;
  const obj = JSON.parse(JSON.stringify(input));
  if (Array.isArray(obj)) return obj;
  const rec = obj as Record<string, unknown>;
  for (const op of ops) {
    if (op.op === "set") {
      setByPath(rec, op.path, op.value);
    } else if (op.op === "remove") {
      removeByPath(rec, op.path);
    } else if (op.op === "rename") {
      const v = getByPath(rec, op.from);
      if (v !== undefined) {
        setByPath(rec, op.to, v);
        removeByPath(rec, op.from);
      }
    } else if (op.op === "copy") {
      const v = getByPath(rec, op.from);
      if (v !== undefined) setByPath(rec, op.to, v);
    }
  }
  return rec;
}
