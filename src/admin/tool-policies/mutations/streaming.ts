/**
 * Mutation for the `streaming` body key. Sets or clears a tool's
 * streaming response format (ndjson / sse) and event cap.
 * See `./index.ts` for the dispatcher and the `ToolMutation` contract.
 */
import { setStreamingConfig } from "../../../proxy/streaming.js";
import { validateStreamingInput } from "../../../routes/admin-validators.js";
import type { ToolMutation } from "./types.js";

export const streamingMutation: ToolMutation = {
  key: "streaming",
  validate: (raw) => validateStreamingInput(raw) as ReturnType<ToolMutation["validate"]>,
  apply: async (ctx, parsed) => {
    const ok = setStreamingConfig(
      ctx.clientName,
      ctx.toolName,
      parsed as Parameters<typeof setStreamingConfig>[2],
    );
    return ok ? { kind: "ok" } : { kind: "tool_not_found" };
  },
  audit: (_raw, parsed) => {
    const v = parsed as { format: string } | null;
    return {
      action: v ? "tool.streaming.set" : "tool.streaming.clear",
      meta: v ? { format: v.format } : undefined,
    };
  },
};
