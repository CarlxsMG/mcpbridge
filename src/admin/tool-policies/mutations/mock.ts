/**
 * Mutation for the `mock` body key. Sets or clears a tool's inline
 * mock response (used in `always` or `fallback` mode). Capped at 1 MB
 * in the validator. See `./index.ts` for the dispatcher and the
 * `ToolMutation` contract.
 */
import { setToolMock } from "../../../tool-meta/tool-mock.js";
import { validateMockInput } from "../../../routes/admin-validators.js";
import type { ToolMutation } from "./types.js";

export const mockMutation: ToolMutation = {
  key: "mock",
  validate: (raw) => validateMockInput(raw) as ReturnType<ToolMutation["validate"]>,
  apply: async (ctx, parsed) => {
    const ok = setToolMock(
      ctx.clientName,
      ctx.toolName,
      parsed as Parameters<typeof setToolMock>[2],
    );
    return ok ? { kind: "ok" } : { kind: "tool_not_found" };
  },
  audit: (_raw, parsed) => {
    const v = parsed as { mode: string } | null;
    return {
      action: v ? "tool.mock.set" : "tool.mock.clear",
      meta: v ? { mode: v.mode } : undefined,
    };
  },
};
