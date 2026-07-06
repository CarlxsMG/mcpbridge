/**
 * Mutation for the `contextBudget` body key. Sets or clears a tool's
 * response-size budget — either plain truncation (`truncate`) or LLM
 * summarisation (`llm_summarize`, which requires an LLM provider config
 * and goes through the secrets provider for the API key).
 *
 * `setToolContextBudget` returns its own error codes (`TOOL_NOT_FOUND`,
 * `SECRETS_PROVIDER_UNCONFIGURED`, `SECRETS_PROVIDER_ERROR`); the apply
 * step maps them to the appropriate HTTP envelope. See `./index.ts` for
 * the dispatcher and the `ToolMutation` contract.
 */
import { setToolContextBudget } from "../../../tool-policies/context-budget.js";
import { validateContextBudgetInput } from "../../../routes/admin-validators.js";
import type { ToolMutation } from "./types.js";

export const contextBudgetMutation: ToolMutation = {
  key: "contextBudget",
  validate: (raw) => validateContextBudgetInput(raw) as ReturnType<ToolMutation["validate"]>,
  apply: async (ctx, parsed) => {
    const result = await setToolContextBudget(
      ctx.clientName,
      ctx.toolName,
      parsed as Parameters<typeof setToolContextBudget>[2],
    );
    if (!result.ok) {
      return {
        kind: "error",
        status: result.error === "TOOL_NOT_FOUND" ? 404 : 400,
        code: result.error,
        reason: result.reason ?? result.error,
      };
    }
    return { kind: "ok" };
  },
  audit: (_raw, parsed) => {
    const v = parsed as
      | { mode: string; maxResponseBytes: number; llm?: { provider: string } }
      | null;
    return {
      action: v ? "tool.context_budget.set" : "tool.context_budget.clear",
      meta: v
        ? {
            mode: v.mode,
            maxResponseBytes: v.maxResponseBytes,
            ...(v.mode === "llm_summarize" && v.llm ? { llmProvider: v.llm.provider } : {}),
          }
        : undefined,
    };
  },
};
