/**
 * Mutation for the `graphql` body key. Sets or clears a tool's GraphQL
 * wrapper (query string + enabled flag). The wrapper rewrites the
 * tool's args as `{ query, variables }` and POSTs them to the client's
 * base URL. See `./index.ts` for the dispatcher and the `ToolMutation`
 * contract.
 */
import { setToolGraphql } from "../../../proxy/backends.js";
import type { ToolMutation } from "./types.js";

export const graphqlMutation: ToolMutation = {
  key: "graphql",
  validate: (raw) => {
    if (raw === null || raw === false) return { ok: true, value: { kind: "clear" } };
    if (typeof raw !== "object" || Array.isArray(raw)) {
      return { ok: false, message: "graphql must be an object, null, or false" };
    }
    const g = raw as Record<string, unknown>;
    const query = typeof g.query === "string" ? g.query.trim() : "";
    if (!query) return { ok: false, message: "graphql.query (non-empty string) is required" };
    return { ok: true, value: { kind: "set", enabled: g.enabled !== false, query } };
  },
  apply: async (ctx, parsed) => {
    const v = parsed as { kind: "clear" } | { kind: "set"; enabled: boolean; query: string };
    if (v.kind === "clear") {
      setToolGraphql(ctx.clientName, ctx.toolName, null);
      return { kind: "ok" };
    }
    const ok = setToolGraphql(ctx.clientName, ctx.toolName, { enabled: v.enabled, query: v.query });
    return ok ? { kind: "ok" } : { kind: "tool_not_found" };
  },
  audit: (_raw, parsed) => {
    const v = parsed as { kind: "clear" } | { kind: "set" };
    return { action: v.kind === "clear" ? "tool.graphql.clear" : "tool.graphql.set" };
  },
};
