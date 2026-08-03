/**
 * Mutation for the `monitor` body key. Creates, updates, or clears a
 * tool's synthetic monitor (a leader-gated schedule that replays a saved
 * example and detects schema drift).
 *
 * `setMonitor` requires the tool to be live (so the baseline inputSchema
 * can be captured); if the tool isn't live, the apply step surfaces
 * `TOOL_NOT_LIVE` as a 404. See `./index.ts` for the dispatcher and the
 * `ToolMutation` contract.
 */
import { setMonitor, deleteMonitor, getMonitor } from "../../../observability/monitor.js";
import type { ToolMutation } from "./types.js";

export const monitorMutation: ToolMutation = {
  key: "monitor",
  validate: (raw) => {
    if (raw === null || raw === false) return { ok: true, value: { kind: "clear" } };
    if (typeof raw !== "object" || Array.isArray(raw)) {
      return { ok: false, message: "monitor must be an object, null, or false" };
    }
    const mo = raw as Record<string, unknown>;
    const exampleId = typeof mo.exampleId === "number" ? mo.exampleId : NaN;
    if (!Number.isInteger(exampleId)) {
      return { ok: false, message: "monitor.exampleId (number) is required" };
    }
    return {
      ok: true,
      value: {
        kind: "set",
        exampleId,
        intervalMinutes: typeof mo.intervalMinutes === "number" ? mo.intervalMinutes : 15,
        enabled: mo.enabled !== false,
      },
    };
  },
  apply: async (ctx, parsed) => {
    const v = parsed as
      { kind: "clear" } | { kind: "set"; exampleId: number; intervalMinutes: number; enabled: boolean };
    if (v.kind === "clear") {
      await deleteMonitor(ctx.clientName, ctx.toolName);
      return { kind: "ok" };
    }
    const result = await setMonitor(ctx.clientName, ctx.toolName, {
      exampleId: v.exampleId,
      intervalMinutes: v.intervalMinutes,
      enabled: v.enabled,
    });
    if (!result.ok) {
      return {
        kind: "error",
        status: result.error === "TOOL_NOT_LIVE" ? 404 : 400,
        code: result.error,
        reason: result.error,
      };
    }
    return { kind: "ok" };
  },
  // Only the three fields `validate` accepts — the rest of MonitorRecord
  // (driftDetected, lastStatus, lastCheckedAt) is observed runtime state, not
  // config, and re-importing it would restore a stale verdict as if it were
  // fresh. `exampleId` is a tool_examples row id, so a monitor imported into an
  // instance without that example is refused by setMonitor and lands in the
  // import's `skipped` list rather than failing the whole import.
  read: (clientName, toolName) => {
    const m = getMonitor(clientName, toolName);
    return m ? { exampleId: m.exampleId, intervalMinutes: m.intervalMinutes, enabled: m.enabled } : undefined;
  },
  audit: (_raw, parsed) => {
    const v = parsed as { kind: "clear" } | { kind: "set"; exampleId: number };
    if (v.kind === "clear") return { action: "tool.monitor.clear" };
    return { action: "tool.monitor.set", meta: { exampleId: v.exampleId } };
  },
};
