/**
 * Mutation for the `requiresApproval` body key. Enables or disables the
 * approval requirement for a tool, and its N-of-M distinct-approver
 * threshold (`approvalLevels`, co-read from the same body).
 *
 * The only mutation that reads a second body key — necessary because
 * `requiresApproval` and `approvalLevels` are conceptually one operation
 * (turn approval on, optionally set the threshold) and the admin UI sends
 * them together. See `./index.ts` for the dispatcher contract.
 */
import { setApprovalRequired, MAX_APPROVAL_LEVELS } from "../../../admin/entities/approvals.js";
import type { ToolMutation } from "./types.js";

export const requiresApprovalMutation: ToolMutation = {
  key: "requiresApproval",
  validate: (raw, body) => {
    if (typeof raw !== "boolean") return { ok: false, message: "requiresApproval must be a boolean" };
    let approvalLevels: number | undefined;
    if (body.approvalLevels !== undefined) {
      if (
        typeof body.approvalLevels !== "number" ||
        !Number.isInteger(body.approvalLevels) ||
        body.approvalLevels < 1 ||
        body.approvalLevels > MAX_APPROVAL_LEVELS
      ) {
        return {
          ok: false,
          message: `approvalLevels must be an integer between 1 and ${MAX_APPROVAL_LEVELS}`,
        };
      }
      approvalLevels = body.approvalLevels;
    }
    return { ok: true, value: { enabled: raw, approvalLevels } };
  },
  apply: async (ctx, parsed) => {
    const v = parsed as { enabled: boolean; approvalLevels: number | undefined };
    const ok = setApprovalRequired(ctx.clientName, ctx.toolName, v.enabled, v.approvalLevels);
    return ok ? { kind: "ok" } : { kind: "tool_not_found" };
  },
  audit: (_raw, parsed) => {
    const v = parsed as { enabled: boolean; approvalLevels: number | undefined };
    return {
      action: v.enabled ? "tool.approval.enable" : "tool.approval.disable",
      meta: v.approvalLevels !== undefined ? { approvalLevels: v.approvalLevels } : undefined,
    };
  },
};
