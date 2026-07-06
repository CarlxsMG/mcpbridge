/**
 * Mutation for the `transform` body key. Sets or clears a tool's
 * request/response transform pipelines (set/remove/rename/copy ops).
 * See `./index.ts` for the dispatcher and the `ToolMutation` contract.
 */
import { setToolTransform } from "../../../proxy/transform.js";
import { validateTransformInput } from "../../../routes/admin-validators.js";
import type { ToolMutation } from "./types.js";

export const transformMutation: ToolMutation = {
  key: "transform",
  validate: (raw) => validateTransformInput(raw) as ReturnType<ToolMutation["validate"]>,
  apply: async (ctx, parsed) => {
    const ok = setToolTransform(
      ctx.clientName,
      ctx.toolName,
      parsed as Parameters<typeof setToolTransform>[2],
    );
    return ok ? { kind: "ok" } : { kind: "tool_not_found" };
  },
  audit: (_raw, parsed) => {
    const v = parsed as { request: unknown[]; response: unknown[] } | null;
    return {
      action: v ? "tool.transform.set" : "tool.transform.clear",
      meta: v ? { request: v.request.length, response: v.response.length } : undefined,
    };
  },
};
