/**
 * Mutation for the `sensitive` body key. Marks a tool as sensitive
 * (boolean) or clears the flag (null). See `./index.ts` for the
 * dispatcher and the `ToolMutation` contract.
 */
import { setToolSensitive } from "../../../tool-meta/tool-sensitivity.js";
import type { ToolMutation } from "./types.js";

export const sensitiveMutation: ToolMutation = {
  key: "sensitive",
  validate: (raw) => {
    if (raw !== null && typeof raw !== "boolean") {
      return { ok: false, message: "sensitive must be a boolean or null" };
    }
    return { ok: true, value: raw };
  },
  apply: async (ctx, parsed) => {
    const ok = setToolSensitive(ctx.clientName, ctx.toolName, parsed as boolean | null);
    return ok ? { kind: "ok" } : { kind: "tool_not_found" };
  },
  audit: (_raw, parsed) => ({ action: "tool.sensitive.set", meta: { sensitive: parsed } }),
};
