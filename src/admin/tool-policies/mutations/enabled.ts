/**
 * Mutation for the `enabled` body key. Toggles a tool on or off.
 * See `./index.ts` for the dispatcher and the `ToolMutation` contract.
 */
import { registry } from "../../../mcp/registry.js";
import type { ToolMutation } from "./types.js";

export const enabledMutation: ToolMutation = {
  key: "enabled",
  validate: (raw) => {
    if (typeof raw !== "boolean") return { ok: false, message: "enabled must be a boolean" };
    return { ok: true, value: raw };
  },
  apply: async (ctx, parsed) => {
    const ok = await registry.setToolEnabled(ctx.clientName, ctx.toolName, parsed as boolean);
    return ok ? { kind: "ok" } : { kind: "tool_not_found" };
  },
  // Always exported, unlike the opt-in policies: `enabled` has no "unset"
  // state, and an export that omitted a disabled tool's flag would silently
  // re-enable it on import.
  read: (clientName, toolName) => registry.getClientTools(clientName)?.find((t) => t.name === toolName)?.enabled,
  audit: (_raw, parsed) => ({ action: parsed ? "tool.enable" : "tool.disable" }),
};
