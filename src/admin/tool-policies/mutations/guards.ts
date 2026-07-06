/**
 * Mutation for the `guards` body key. Sets or clears a tool's guard
 * config (rate limit, timeout, allowed API keys). The API-key list is
 * hashed at the validation boundary, so raw keys never reach storage.
 * See `./index.ts` for the dispatcher and the `ToolMutation` contract.
 */
import { registry } from "../../../mcp/registry.js";
import { validateToolGuardInput } from "../../../routes/admin-validators.js";
import type { ToolMutation } from "./types.js";

export const guardsMutation: ToolMutation = {
  key: "guards",
  validate: (raw) => validateToolGuardInput(raw) as ReturnType<ToolMutation["validate"]>,
  apply: async (ctx, parsed) => {
    const ok = await registry.setToolGuards(
      ctx.clientName,
      ctx.toolName,
      parsed as Parameters<typeof registry.setToolGuards>[2],
    );
    return ok ? { kind: "ok" } : { kind: "tool_not_found" };
  },
  audit: () => ({ action: "tool.guards.update" }),
};
