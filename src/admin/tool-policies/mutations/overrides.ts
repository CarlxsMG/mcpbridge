/**
 * Mutation for the `overrides` body key. Sets or clears a tool's
 * presentation override (description, param hints, displayName alias).
 * `displayName` alias validation lives in the registry itself; the
 * `ToolOverrideError` thrown there is translated into a 400/409 envelope
 * by the dispatcher. See `./index.ts` for the dispatcher and the
 * `ToolMutation` contract.
 */
import { registry, ToolOverrideError } from "../../../mcp/registry.js";
import { validateToolOverrideInput } from "../../../routes/admin-validators.js";
import type { ToolMutation } from "./types.js";

export const overridesMutation: ToolMutation = {
  key: "overrides",
  validate: (raw) => validateToolOverrideInput(raw) as ReturnType<ToolMutation["validate"]>,
  apply: async (ctx, parsed) => {
    try {
      const ok = await registry.setToolOverride(
        ctx.clientName,
        ctx.toolName,
        parsed as Parameters<typeof registry.setToolOverride>[2],
      );
      return ok ? { kind: "ok" } : { kind: "tool_not_found" };
    } catch (err) {
      if (err instanceof ToolOverrideError) {
        const status = err.code === "TOOL_ALIAS_CONFLICT" ? 409 : 400;
        return { kind: "error", status, code: err.code, reason: err.message };
      }
      throw err;
    }
  },
  audit: () => ({ action: "tool.override.update" }),
};
