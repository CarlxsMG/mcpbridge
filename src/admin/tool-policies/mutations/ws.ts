/**
 * Mutation for the `ws` body key. Sets or clears a tool's WebSocket
 * backend URL (request/response over WS, with an optional `persistent`
 * mode for multi-message exchanges). The URL is SSRF-validated by
 * `setToolWs` against the same allow-list as REST backends.
 * See `./index.ts` for the dispatcher and the `ToolMutation` contract.
 */
import { setToolWs } from "../../../proxy/backends.js";
import type { ToolMutation } from "./types.js";

export const wsMutation: ToolMutation = {
  key: "ws",
  validate: (raw) => {
    if (raw === null || raw === false) return { ok: true, value: { kind: "clear" } };
    if (typeof raw !== "object" || Array.isArray(raw)) {
      return { ok: false, message: "ws must be an object, null, or false" };
    }
    const w = raw as Record<string, unknown>;
    const wsUrl = typeof w.wsUrl === "string" ? w.wsUrl : "";
    if (!wsUrl) return { ok: false, message: "ws.wsUrl (ws:// or wss://) is required" };
    return {
      ok: true,
      value: {
        kind: "set",
        enabled: w.enabled !== false,
        wsUrl,
        persistent: w.persistent === true,
      },
    };
  },
  apply: async (ctx, parsed) => {
    const v = parsed as { kind: "clear" } | { kind: "set"; enabled: boolean; wsUrl: string; persistent: boolean };
    if (v.kind === "clear") {
      await setToolWs(ctx.clientName, ctx.toolName, null);
      return { kind: "ok" };
    }
    const result = await setToolWs(ctx.clientName, ctx.toolName, {
      enabled: v.enabled,
      wsUrl: v.wsUrl,
      persistent: v.persistent,
    });
    if (!result.ok) {
      return {
        kind: "error",
        status: result.error === "TOOL_NOT_FOUND" ? 404 : 400,
        code: result.error,
        reason: result.reason ?? result.error,
      };
    }
    return { kind: "ok" };
  },
  audit: (_raw, parsed) => {
    const v = parsed as { kind: "clear" } | { kind: "set"; persistent: boolean };
    if (v.kind === "clear") return { action: "tool.ws.clear" };
    return { action: "tool.ws.set", meta: { persistent: v.persistent } };
  },
};
