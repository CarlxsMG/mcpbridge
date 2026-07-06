/**
 * Mutation for the `coalesce` body key. Enables or disables request
 * coalescing for a tool. See `./index.ts` for the dispatcher and the
 * `ToolMutation` contract.
 */
import { setToolCoalesce } from "../../../tool-policies/coalesce.js";
import { validateCoalesceInput } from "../../../routes/admin-validators.js";
import type { ToolMutation } from "./types.js";

export const coalesceMutation: ToolMutation = {
  key: "coalesce",
  validate: (raw) => validateCoalesceInput(raw) as ReturnType<ToolMutation["validate"]>,
  apply: async (ctx, parsed) => {
    const ok = setToolCoalesce(ctx.clientName, ctx.toolName, parsed as Parameters<typeof setToolCoalesce>[2]);
    return ok ? { kind: "ok" } : { kind: "tool_not_found" };
  },
  audit: (_raw, parsed) => {
    const v = parsed as { enabled: boolean } | null;
    return {
      action: v ? "tool.coalesce.set" : "tool.coalesce.clear",
      meta: v ? { enabled: v.enabled } : undefined,
    };
  },
};
