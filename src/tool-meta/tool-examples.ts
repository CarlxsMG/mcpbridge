import { getDb } from "../db/connection.js";
import { toolExists } from "../lib/tool-config.js";

/**
 * Saved example arguments for a tool — reusable inputs an admin can pin so the
 * playground ("Test a tool") can reload a known-good call instead of retyping
 * it. Purely an admin convenience; example args carry no privilege and are
 * validated by the normal tool schema when the test call runs.
 */
export interface ToolExample {
  id: number;
  label: string;
  args: Record<string, unknown>;
  createdAt: number;
  createdBy: string | null;
}

interface ExampleRow {
  id: number;
  label: string;
  args_json: string;
  created_at: number;
  created_by: string | null;
}

const MAX_ARGS_BYTES = 16384;

export function listExamples(clientName: string, toolName: string): ToolExample[] {
  const rows = getDb()
    .query(
      `SELECT id, label, args_json, created_at, created_by FROM tool_examples WHERE client_name = ? AND tool_name = ? ORDER BY id`,
    )
    .all(clientName, toolName) as ExampleRow[];
  return rows.map((r) => ({
    id: r.id,
    label: r.label,
    args: JSON.parse(r.args_json) as Record<string, unknown>,
    createdAt: r.created_at,
    createdBy: r.created_by,
  }));
}

export type ExampleError = "TOOL_NOT_FOUND" | "INVALID_ARGS";

/** Creates a saved example. Returns the row, or an error code (unknown tool / oversized args). */
export function createExample(
  clientName: string,
  toolName: string,
  label: string,
  args: unknown,
  actor: string | null,
): ToolExample | ExampleError {
  if (!toolExists(clientName, toolName)) return "TOOL_NOT_FOUND";
  if (typeof args !== "object" || args === null || Array.isArray(args)) return "INVALID_ARGS";
  const argsJson = JSON.stringify(args);
  if (argsJson.length > MAX_ARGS_BYTES) return "INVALID_ARGS";

  const now = Date.now();
  const row = getDb()
    .query(
      `INSERT INTO tool_examples (client_name, tool_name, label, args_json, created_at, created_by)
       VALUES (?, ?, ?, ?, ?, ?) RETURNING id`,
    )
    .get(clientName, toolName, label, argsJson, now, actor) as { id: number };
  return { id: row.id, label, args: args as Record<string, unknown>, createdAt: now, createdBy: actor };
}

/** Deletes one example scoped to its tool. Returns false when it doesn't exist for that tool. */
export function deleteExample(clientName: string, toolName: string, id: number): boolean {
  const result = getDb()
    .query(`DELETE FROM tool_examples WHERE id = ? AND client_name = ? AND tool_name = ?`)
    .run(id, clientName, toolName);
  return result.changes > 0;
}
