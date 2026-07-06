/**
 * Mutation for the `guardrails` body key. Sets a tool's input-filter
 * (deny patterns) and response-scan (block secrets) configuration.
 *
 * Unlike every other per-tool mutation, guardrails always emits the same
 * detail shape (with default values when the input was null/clear) so
 * downstream audit consumers can rely on a stable payload regardless of
 * set-vs-clear. See `./index.ts` for the dispatcher and the
 * `ToolMutation` contract.
 */
import { setGuardrails } from "../../../tool-policies/guardrails.js";
import { validateGuardrailsInput } from "../../../routes/admin-validators.js";
import type { ToolMutation } from "./types.js";

export const guardrailsMutation: ToolMutation = {
  key: "guardrails",
  validate: (raw) => validateGuardrailsInput(raw) as ReturnType<ToolMutation["validate"]>,
  apply: async (ctx, parsed) => {
    const ok = setGuardrails(ctx.clientName, ctx.toolName, parsed as Parameters<typeof setGuardrails>[2]);
    return ok ? { kind: "ok" } : { kind: "tool_not_found" };
  },
  audit: (_raw, parsed) => {
    const v = parsed as { denyPatterns: string[]; blockSecrets: boolean; scanResponses: boolean } | null;
    return {
      action: "tool.guardrails.set",
      meta: {
        denyPatterns: v?.denyPatterns.length ?? 0,
        blockSecrets: v?.blockSecrets ?? false,
        scanResponses: v?.scanResponses ?? false,
      },
    };
  },
};
