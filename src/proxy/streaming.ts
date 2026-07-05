/**
 * Per-tool normalization of streaming-format upstream bodies (NDJSON / SSE) into
 * a single aggregated JSON result.
 *
 * MCP returns ONE result per tool call, so the bridge cannot stream partial
 * output to the MCP client. What it can do — and what this provides — is consume
 * a streaming-format response body (which must complete; it's bounded by the
 * global response byte cap like any other body) and turn it into a tidy
 * `{ "events": [ ... ] }` JSON result. Useful for backends that emit NDJSON logs
 * or SSE token/event streams and then close.
 */
import { getDb } from "../db/connection.js";
import { toolExists, upsertConfig } from "../lib/tool-config.js";

export type StreamFormat = "ndjson" | "sse";

export interface StreamingConfig {
  enabled: boolean;
  format: StreamFormat;
  maxEvents: number;
}

/** Hard cap on parsed events regardless of a tool's configured maxEvents. */
export const MAX_STREAM_EVENTS = 10_000;

interface StreamingRow {
  format: string;
  max_events: number;
  enabled: number;
}

export function getStreamingConfig(clientName: string, toolName: string): StreamingConfig | null {
  const row = getDb()
    .query(`SELECT format, max_events, enabled FROM tool_streaming WHERE client_name = ? AND tool_name = ?`)
    .get(clientName, toolName) as StreamingRow | null;
  if (!row) return null;
  return { enabled: row.enabled === 1, format: row.format as StreamFormat, maxEvents: row.max_events };
}

/** Persists (or clears with null) a tool's streaming config. False when the tool is unknown. */
export function setStreamingConfig(
  clientName: string,
  toolName: string,
  input: { enabled: boolean; format: StreamFormat; maxEvents: number } | null,
): boolean {
  if (!toolExists(clientName, toolName)) return false;

  if (input === null) {
    getDb().query(`DELETE FROM tool_streaming WHERE client_name = ? AND tool_name = ?`).run(clientName, toolName);
    return true;
  }
  upsertConfig(
    "tool_streaming",
    { client_name: clientName, tool_name: toolName },
    { format: input.format, max_events: input.maxEvents, enabled: input.enabled ? 1 : 0 },
    Date.now(),
  );
  return true;
}

/**
 * Parses a streaming-format body into an array of events, bounded by maxEvents.
 *   - ndjson: one JSON value per non-blank line (unparseable lines are skipped).
 *   - sse:    `data:` payloads per event block (blank-line separated); a payload
 *             that isn't JSON is kept as a raw string; `[DONE]` sentinels dropped.
 */
export function parseStream(text: string, format: StreamFormat, maxEvents: number): unknown[] {
  const cap = Math.min(maxEvents, MAX_STREAM_EVENTS);
  const out: unknown[] = [];

  if (format === "ndjson") {
    for (const line of text.split(/\r?\n/)) {
      const t = line.trim();
      if (!t) continue;
      try {
        out.push(JSON.parse(t));
      } catch {
        /* skip a non-JSON line */
      }
      if (out.length >= cap) break;
    }
    return out;
  }

  // sse
  for (const block of text.split(/\r?\n\r?\n/)) {
    const dataLines = block
      .split(/\r?\n/)
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trim());
    if (dataLines.length === 0) continue;
    const payload = dataLines.join("\n");
    if (payload === "[DONE]") continue;
    try {
      out.push(JSON.parse(payload));
    } catch {
      out.push(payload);
    }
    if (out.length >= cap) break;
  }
  return out;
}
