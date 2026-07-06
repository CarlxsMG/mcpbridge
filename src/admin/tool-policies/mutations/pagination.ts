/**
 * Mutation for the `pagination` body key. Configures automatic
 * follow-the-X pagination (cursor / page / link strategy).
 * See `./index.ts` for the dispatcher and the `ToolMutation` contract.
 */
import { setPaginationConfig } from "../../../tool-policies/pagination.js";
import { validatePaginationInput } from "../../../routes/admin-validators.js";
import type { ToolMutation } from "./types.js";

export const paginationMutation: ToolMutation = {
  key: "pagination",
  validate: (raw) => validatePaginationInput(raw) as ReturnType<ToolMutation["validate"]>,
  apply: async (ctx, parsed) => {
    const ok = setPaginationConfig(ctx.clientName, ctx.toolName, parsed as Parameters<typeof setPaginationConfig>[2]);
    return ok ? { kind: "ok" } : { kind: "tool_not_found" };
  },
  audit: (_raw, parsed) => {
    const v = parsed as { strategy: string; maxPages: number } | null;
    return {
      action: v ? "tool.pagination.set" : "tool.pagination.clear",
      meta: v ? { strategy: v.strategy, maxPages: v.maxPages } : undefined,
    };
  },
};
