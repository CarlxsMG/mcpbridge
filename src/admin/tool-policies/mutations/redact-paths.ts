/**
 * Mutation for the `redactPaths` body key. Sets the list of response
 * dot-paths whose values are redacted from the tool's outbound result.
 * See `./index.ts` for the dispatcher and the `ToolMutation` contract.
 */
import { setRedactionPaths } from "../../../content-filtering/redaction.js";
import type { ToolMutation } from "./types.js";

export const redactPathsMutation: ToolMutation = {
  key: "redactPaths",
  validate: (raw) => {
    if (!Array.isArray(raw) || !raw.every((p) => typeof p === "string")) {
      return { ok: false, message: "redactPaths must be an array of strings" };
    }
    return { ok: true, value: raw };
  },
  apply: async (ctx, parsed) => {
    const ok = setRedactionPaths(ctx.clientName, ctx.toolName, parsed as string[]);
    return ok ? { kind: "ok" } : { kind: "tool_not_found" };
  },
  audit: (_raw, parsed) => ({
    action: "tool.redaction.set",
    meta: { count: (parsed as string[]).length },
  }),
};
