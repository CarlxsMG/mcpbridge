import type { StoredSpan, TopSessionRow, TraceSummary } from "@/types/api";
import { hours } from "./time";

export const spansByTrace: Record<string, StoredSpan[]> = {
  "trace-a1": [
    {
      id: 1,
      traceId: "trace-a1",
      spanId: "span-a1",
      name: "tool_call github__search_issues",
      mcpToolName: "github__search_issues",
      sessionId: "session-agent-alpha",
      startMs: hours(0.1),
      endMs: hours(0.1) + 118,
      statusCode: 1,
      attributes: {
        "mcp.tool": "github__search_issues",
        "mcp.tool.is_error": false,
        "mcp.session_id": "session-agent-alpha",
      },
      createdAt: hours(0.1),
    },
  ],
  "trace-b2": [
    {
      id: 2,
      traceId: "trace-b2",
      spanId: "span-b2",
      name: "tool_call internal-crm__find_account",
      mcpToolName: "internal-crm__find_account",
      sessionId: "session-agent-beta",
      startMs: hours(1.2),
      endMs: hours(1.2) + 8003,
      statusCode: 2,
      attributes: {
        "mcp.tool": "internal-crm__find_account",
        "mcp.tool.is_error": true,
        "mcp.session_id": "session-agent-beta",
      },
      createdAt: hours(1.2),
    },
  ],
  "trace-c3": [
    {
      id: 3,
      traceId: "trace-c3",
      spanId: "span-c3",
      name: "tool_call stripe__create_refund",
      mcpToolName: "stripe__create_refund",
      sessionId: "session-agent-alpha",
      startMs: hours(3),
      endMs: hours(3) + 188,
      statusCode: 1,
      attributes: {
        "mcp.tool": "stripe__create_refund",
        "mcp.tool.is_error": false,
        "mcp.session_id": "session-agent-alpha",
      },
      createdAt: hours(3),
    },
  ],
};

export const traces: TraceSummary[] = Object.entries(spansByTrace).map(([traceId, spans]) => ({
  traceId,
  spanCount: spans.length,
  startMs: Math.min(...spans.map((s) => s.startMs)),
  endMs: Math.max(...spans.map((s) => s.endMs)),
  mcpToolName: spans[0]?.mcpToolName ?? null,
  sessionId: spans[0]?.sessionId ?? null,
  hasError: spans.some((s) => s.statusCode === 2),
}));

export const topSessions: TopSessionRow[] = (() => {
  const byId = new Map<string, { calls: number; hasError: boolean }>();
  for (const spans of Object.values(spansByTrace)) {
    for (const s of spans) {
      if (!s.sessionId) continue;
      const entry = byId.get(s.sessionId) ?? { calls: 0, hasError: false };
      entry.calls += 1;
      entry.hasError = entry.hasError || s.statusCode === 2;
      byId.set(s.sessionId, entry);
    }
  }
  return Array.from(byId.entries())
    .map(([sessionId, v]) => ({ sessionId, ...v }))
    .sort((a, b) => b.calls - a.calls);
})();
