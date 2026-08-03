/**
 * Mutation for the `redactPaths` body key. Sets the list of response
 * dot-paths whose values are redacted from the tool's outbound result.
 * See `./index.ts` for the dispatcher and the `ToolMutation` contract.
 */
import { setRedactionPaths, getRedactionPaths } from "../../../content-filtering/redaction.js";
import { hasUnsafeSegment } from "../../../lib/object-path.js";
import type { ToolMutation } from "./types.js";

export const redactPathsMutation: ToolMutation = {
  key: "redactPaths",
  purgesCache: true,
  validate: (raw) => {
    if (!Array.isArray(raw) || !raw.every((p) => typeof p === "string")) {
      return { ok: false, message: "redactPaths must be an array of strings" };
    }
    if ((raw as string[]).some(hasUnsafeSegment)) {
      return { ok: false, message: "redactPaths must not contain __proto__, constructor, or prototype" };
    }
    return { ok: true, value: raw };
  },
  apply: async (ctx, parsed) => {
    const ok = setRedactionPaths(ctx.clientName, ctx.toolName, parsed as string[]);
    return ok ? { kind: "ok" } : { kind: "tool_not_found" };
  },
  // getRedactionPaths returns [] for an unconfigured tool, which is also the
  // value that clears the list — so an empty array carries no information and
  // is omitted, keeping the export sparse.
  read: (clientName, toolName) => {
    const paths = getRedactionPaths(clientName, toolName);
    return paths.length > 0 ? paths : undefined;
  },
  audit: (_raw, parsed) => ({
    action: "tool.redaction.set",
    meta: { count: (parsed as string[]).length },
  }),
};
