import type { ClientDetail, ClientSummary, TagSummary, TagToolRef, ToolDetail, ToolListItem } from "../../types/api";
import { clients } from "./clients";

// ─── Tool catalogs per client (drive the flat list + client detail) ──────────

export const TOOLS: Record<
  string,
  Array<{
    name: string;
    method: ToolDetail["method"];
    endpoint: string;
    description: string;
    upstream?: string;
    tags?: string[];
    sensitive?: boolean;
  }>
> = {
  github: [
    {
      name: "search_issues",
      method: "GET",
      endpoint: "",
      description: "Search issues and pull requests",
      upstream: "search_issues",
      tags: ["read"],
    },
    {
      name: "create_issue",
      method: "POST",
      endpoint: "",
      description: "Open a new issue in a repository",
      upstream: "create_issue",
      tags: ["write"],
    },
    {
      name: "get_repo",
      method: "GET",
      endpoint: "",
      description: "Fetch repository metadata",
      upstream: "get_repo",
      tags: ["read"],
    },
    {
      name: "list_pull_requests",
      method: "GET",
      endpoint: "",
      description: "List pull requests for a repo",
      upstream: "list_pull_requests",
      tags: ["read"],
    },
  ],
  stripe: [
    {
      name: "create_refund",
      method: "POST",
      endpoint: "/v1/refunds",
      description: "Refund a charge",
      tags: ["write"],
      sensitive: true,
    },
    {
      name: "get_customer",
      method: "GET",
      endpoint: "/v1/customers/{id}",
      description: "Retrieve a customer",
      tags: ["read"],
      sensitive: true,
    },
    { name: "list_invoices", method: "GET", endpoint: "/v1/invoices", description: "List invoices", tags: ["read"] },
    {
      name: "create_payment_intent",
      method: "POST",
      endpoint: "/v1/payment_intents",
      description: "Start a payment",
      tags: ["write"],
      sensitive: true,
    },
  ],
  slack: [
    {
      name: "post_message",
      method: "POST",
      endpoint: "/chat.postMessage",
      description: "Send a channel message",
      tags: ["write"],
    },
    {
      name: "list_channels",
      method: "GET",
      endpoint: "/conversations.list",
      description: "List channels",
      tags: ["read"],
    },
    { name: "get_user", method: "GET", endpoint: "/users.info", description: "Look up a user", tags: ["read"] },
  ],
  "internal-crm": [
    {
      name: "find_account",
      method: "GET",
      endpoint: "/accounts/search",
      description: "Search CRM accounts",
      tags: ["read"],
      sensitive: true,
    },
    {
      name: "update_deal",
      method: "PATCH",
      endpoint: "/deals/{id}",
      description: "Update a deal stage",
      tags: ["write"],
    },
  ],
  weather: [
    { name: "current", method: "GET", endpoint: "/v1/current", description: "Current conditions for a location" },
    { name: "forecast", method: "GET", endpoint: "/v1/forecast", description: "7-day forecast" },
  ],
  "legacy-billing": [
    { name: "get_balance", method: "GET", endpoint: "/balance", description: "Legacy balance lookup" },
  ],
};

export function toolDetail(client: ClientSummary, t: (typeof TOOLS)[string][number]): ToolDetail {
  return {
    name: t.name,
    method: t.method,
    endpoint: t.endpoint,
    upstreamName: client.kind === "mcp" ? (t.upstream ?? t.name) : undefined,
    description: t.description,
    inputSchema: { type: "object", properties: {}, additionalProperties: true },
    enabled: true,
    guards: t.name === "create_refund" ? { rateLimitPerMin: 10, timeoutMs: 8000 } : undefined,
    tags: t.tags ?? [],
    sensitive: t.sensitive ?? false,
    guardrails: t.sensitive ? { denyPatterns: [], blockSecrets: true, scanResponses: true } : undefined,
  };
}

export function clientDetail(name: string): ClientDetail {
  const c = clients.find((x) => x.name === name) ?? clients[0];
  const catalog = TOOLS[c.name] ?? [
    { name: "example_tool", method: "GET" as const, endpoint: "/example", description: "Example tool" },
  ];
  return {
    name: c.name,
    enabled: c.enabled,
    live: c.live,
    status: c.status,
    ip: "203.0.113.10",
    healthUrl: c.healthUrl,
    baseUrl: c.baseUrl,
    resolvedIp: "203.0.113.10",
    retryNonSafeMethods: false,
    consecutiveFailures: c.status === "degraded" ? 2 : 0,
    circuitBreakerState: c.status === "degraded" ? "half_open" : "closed",
    kind: c.kind,
    mcpUrl: c.kind === "mcp" ? "https://api.githubcopilot.com/mcp/" : null,
    mcpTransport: c.kind === "mcp" ? "streamable-http" : null,
    teamId: c.teamId,
    tools: catalog.map((t) => toolDetail(c, t)),
  };
}

export const flatTools: ToolListItem[] = clients.flatMap((c) =>
  (TOOLS[c.name] ?? []).map((t) => ({
    client: c.name,
    tool: t.name,
    description: t.description,
    enabled: true,
    clientEnabled: c.enabled,
    tags: t.tags ?? [],
  })),
);

// Derived from flatTools' `tags` fields — never hand-maintained separately, so it can't drift
// from the tool catalog above.
export const tagCounts: TagSummary[] = (() => {
  const counts = new Map<string, number>();
  for (const t of flatTools) for (const tag of t.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  return Array.from(counts.entries())
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
})();

export function toolsByTag(tag: string): TagToolRef[] {
  return flatTools.filter((t) => t.tags.includes(tag)).map((t) => ({ client: t.client, tool: t.tool }));
}
