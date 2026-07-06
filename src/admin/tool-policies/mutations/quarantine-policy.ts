/**
 * Mutation for the `quarantinePolicy` body key. Sets the auto-quarantine
 * policy a tool falls under after N consecutive guardrail hits
 * (consecutiveThreshold + action + recoveryMode + cooldownMs).
 * See `./index.ts` for the dispatcher and the `ToolMutation` contract.
 */
import { setQuarantinePolicy } from "../../../tool-policies/quarantine.js";
import { validateQuarantinePolicyInput } from "../../../routes/admin-validators.js";
import type { ToolMutation } from "./types.js";

export const quarantinePolicyMutation: ToolMutation = {
  key: "quarantinePolicy",
  validate: (raw) => validateQuarantinePolicyInput(raw) as ReturnType<ToolMutation["validate"]>,
  apply: async (ctx, parsed) => {
    const ok = setQuarantinePolicy(ctx.clientName, ctx.toolName, parsed as Parameters<typeof setQuarantinePolicy>[2]);
    return ok ? { kind: "ok" } : { kind: "tool_not_found" };
  },
  audit: (_raw, parsed) => {
    const v = parsed as Record<string, unknown> | null;
    return {
      action: v ? "tool.quarantine.policy.set" : "tool.quarantine.policy.clear",
      meta: (v as Record<string, unknown> | undefined) ?? undefined,
    };
  },
};
