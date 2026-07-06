/**
 * Mutation for the `cache` body key. Sets or clears a tool's response
 * cache (TTL + enabled). See `./index.ts` for the dispatcher and the
 * `ToolMutation` contract.
 */
import { setToolCacheConfig } from "../../../tool-policies/response-cache.js";
import { validateCacheInput } from "../../../routes/admin-validators.js";
import type { ToolMutation } from "./types.js";

export const cacheMutation: ToolMutation = {
  key: "cache",
  validate: (raw) => validateCacheInput(raw) as ReturnType<ToolMutation["validate"]>,
  apply: async (ctx, parsed) => {
    const ok = setToolCacheConfig(ctx.clientName, ctx.toolName, parsed as Parameters<typeof setToolCacheConfig>[2]);
    return ok ? { kind: "ok" } : { kind: "tool_not_found" };
  },
  audit: (_raw, parsed) => {
    const v = parsed as { enabled: boolean; ttlSeconds: number } | null;
    return {
      action: v ? "tool.cache.set" : "tool.cache.clear",
      meta: v ? { ttlSeconds: v.ttlSeconds, enabled: v.enabled } : undefined,
    };
  },
};
