/**
 * Per-tool mock / virtualization. An admin can make a tool return a canned
 * response instead of calling the backend:
 *   - "always":   short-circuit the upstream entirely (dev, demos, contract-first
 *                 development before a backend exists). Runs after all guards but
 *                 before the circuit breaker, like the response cache.
 *   - "fallback": return the canned response only when the backend is unavailable
 *                 (breaker open, connection error, 5xx, or retries exhausted), so
 *                 a flaky dependency degrades gracefully instead of erroring.
 *
 * The mock body is admin-supplied text (typically JSON). Distinct from
 * `tool_examples`, which store request ARGS, not responses.
 */
import { getDb } from "../db/connection.js";
import { toolExists, upsertConfig } from "../lib/tool-config.js";

export type MockMode = "always" | "fallback";

export interface ToolMock {
  enabled: boolean;
  mode: MockMode;
  response: string;
}

interface MockRow {
  mode: string;
  response: string;
  enabled: number;
}

export function getToolMock(clientName: string, toolName: string): ToolMock | null {
  const row = getDb()
    .query(`SELECT mode, response, enabled FROM tool_mock WHERE client_name = ? AND tool_name = ?`)
    .get(clientName, toolName) as MockRow | null;
  if (!row) return null;
  return { enabled: row.enabled === 1, mode: row.mode as MockMode, response: row.response };
}

/** Persists (or clears with null) a tool's mock config. False when the tool is unknown. */
export function setToolMock(
  clientName: string,
  toolName: string,
  input: { enabled: boolean; mode: MockMode; response: string } | null,
): boolean {
  if (!toolExists(clientName, toolName)) return false;

  if (input === null) {
    getDb().query(`DELETE FROM tool_mock WHERE client_name = ? AND tool_name = ?`).run(clientName, toolName);
    return true;
  }
  upsertConfig(
    "tool_mock",
    { client_name: clientName, tool_name: toolName },
    { mode: input.mode, response: input.response, enabled: input.enabled ? 1 : 0 },
    Date.now(),
  );
  return true;
}
