// ─────────────────────────────────────────────────────────────────────────────
// DEMO MODE — in-browser mock of the /admin-api/* + /register backend.
//
// Loaded ONLY when built with VITE_DEMO=true (see useApi.ts — dynamic import in a
// statically-false branch, so this file is tree-shaken out of the real product
// build). Powers the public "try it" demo on GitHub Pages with realistic, mutable
// fixture data — no server, no persistence beyond the current tab.
// ─────────────────────────────────────────────────────────────────────────────
import type {
  AdminSession,
  AlertRule,
  ApprovalRecord,
  ApprovalStatus,
  AuditLogEntry,
  BundleDetail,
  BundleInstallLink,
  BundleInstallLinkWithToken,
  BundleSummary,
  CatalogEntry,
  ClientDetail,
  ClientSummary,
  CompositeSummary,
  ConfigSnapshotSummary,
  ConsumerWithUsage,
  CurrentUser,
  DiscoveryPreview,
  GuardPolicy,
  McpApiKey,
  McpApiKeyWithSecret,
  MonitorRecord,
  OidcPublicConfig,
  OidcSettings,
  OverviewStats,
  Schedule,
  StoredSpan,
  Team,
  ToolDetail,
  ToolListItem,
  TagSummary,
  TagToolRef,
  TopSessionRow,
  TopToolRow,
  TraceSummary,
  TrafficRecord,
  UsageByKeyRow,
  UsageSummary,
  UsageTimeseries,
  UsageTimeseriesPoint,
  AdminUserSummary,
  WsProxyTarget,
} from "../types/api";

const NOW = Date.now();
const days = (n: number): number => NOW - n * 86_400_000;
const hours = (n: number): number => NOW - n * 3_600_000;
const hex = (seed: number): string =>
  Array.from({ length: 16 }, (_, i) => (((seed * 2654435761 + i * 40503) >>> 0) % 16).toString(16)).join("");

// ─── Mutable session state (toggles persist within the tab) ──────────────────

// SSO is off by default in the public demo (there's no real IdP to redirect
// to) but the settings form itself is still interactive, like every other
// admin-only config screen in this demo.
let oidcSettings: OidcSettings | null = null;

const clients: ClientSummary[] = [
  {
    name: "github",
    enabled: true,
    live: true,
    status: "healthy",
    toolsCount: 8,
    healthUrl: "https://api.github.com",
    baseUrl: "https://api.github.com",
    kind: "mcp",
    teamId: 1,
  },
  {
    name: "stripe",
    enabled: true,
    live: true,
    status: "healthy",
    toolsCount: 12,
    healthUrl: "https://api.stripe.com/healthz",
    baseUrl: "https://api.stripe.com",
    kind: "rest",
    teamId: 1,
  },
  {
    name: "slack",
    enabled: true,
    live: true,
    status: "healthy",
    toolsCount: 6,
    healthUrl: "https://slack.com/api/api.test",
    baseUrl: "https://slack.com/api",
    kind: "rest",
    teamId: 2,
  },
  {
    name: "internal-crm",
    enabled: true,
    live: true,
    status: "degraded",
    toolsCount: 9,
    healthUrl: "https://crm.internal/health",
    baseUrl: "https://crm.internal",
    kind: "rest",
    teamId: 2,
  },
  {
    name: "weather",
    enabled: true,
    live: true,
    status: "healthy",
    toolsCount: 4,
    healthUrl: "https://api.weather.example/health",
    baseUrl: "https://api.weather.example",
    kind: "rest",
    teamId: null,
  },
  {
    name: "legacy-billing",
    enabled: false,
    live: false,
    status: "unreachable",
    toolsCount: 3,
    healthUrl: "https://legacy.internal/ping",
    baseUrl: "https://legacy.internal",
    kind: "rest",
    teamId: null,
  },
];

const bundles: BundleSummary[] = [
  {
    name: "support-agent",
    description: "Read-only GitHub + Slack tools for the support copilot",
    enabled: true,
    toolsCount: 5,
  },
  { name: "billing-ops", description: "Stripe refunds & invoice lookups for finance", enabled: true, toolsCount: 4 },
  {
    name: "readonly-explorer",
    description: "Safe, read-only slice across every backend",
    enabled: false,
    toolsCount: 7,
  },
];

const catalogEntries: CatalogEntry[] = [
  {
    id: "builtin:petstore",
    source: "builtin",
    slug: "petstore",
    name: "Swagger Petstore",
    description: "The canonical OpenAPI sample API — pets, orders, and inventory.",
    kind: "rest",
    category: "Examples",
    tags: ["demo", "no-auth", "openapi-sample"],
    icon: "paw-print",
    healthUrl: "https://petstore3.swagger.io/",
    openapiUrl: "https://petstore3.swagger.io/api/v3/openapi.json",
    featured: true,
  },
  {
    id: "custom:1",
    source: "custom",
    slug: "internal-crm-staging",
    name: "Internal CRM (staging)",
    description: "Reusable template for spinning up a staging CRM registration.",
    kind: "rest",
    category: "Internal",
    tags: ["internal", "staging"],
    icon: null,
    healthUrl: "https://crm.staging.internal/health",
    openapiUrl: "https://crm.staging.internal/openapi.json",
    featured: false,
  },
];

const wsProxyTargets: WsProxyTarget[] = [
  {
    name: "iot-gateway",
    backendWsUrl: "wss://iot.internal/socket",
    resolvedIp: "203.0.113.20",
    maxConnections: 10,
    maxMessageBytes: 1_048_576,
    idleTimeoutMs: 300_000,
    enabled: true,
    activeConnections: 3,
    createdAt: days(30),
    updatedAt: days(2),
  },
  {
    name: "legacy-feed",
    backendWsUrl: "wss://feed.legacy.internal/stream",
    resolvedIp: "203.0.113.21",
    maxConnections: 5,
    maxMessageBytes: 262_144,
    idleTimeoutMs: 120_000,
    enabled: false,
    activeConnections: 0,
    createdAt: days(60),
    updatedAt: days(10),
  },
];

// ─── Tool catalogs per client (drive the flat list + client detail) ──────────

const TOOLS: Record<
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

function toolDetail(client: ClientSummary, t: (typeof TOOLS)[string][number]): ToolDetail {
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

function clientDetail(name: string): ClientDetail {
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

const flatTools: ToolListItem[] = clients.flatMap((c) =>
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
const tagCounts: TagSummary[] = (() => {
  const counts = new Map<string, number>();
  for (const t of flatTools) for (const tag of t.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  return Array.from(counts.entries())
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
})();

function toolsByTag(tag: string): TagToolRef[] {
  return flatTools.filter((t) => t.tags.includes(tag)).map((t) => ({ client: t.client, tool: t.tool }));
}

const mcpKeys: McpApiKey[] = [
  {
    id: 1,
    label: "Claude Desktop",
    keyPrefix: "mcp_live_a1b2",
    consumerId: 1,
    elevated: false,
    scopes: { clients: ["github", "slack"] },
    enabled: true,
    expiresAt: null,
    revokedAt: null,
    lastUsedAt: hours(3),
    createdAt: days(41),
    updatedAt: days(2),
    createdBy: "demo",
  },
  {
    id: 2,
    label: "Cursor IDE",
    keyPrefix: "mcp_live_c3d4",
    consumerId: 2,
    elevated: false,
    scopes: { clients: ["stripe"] },
    enabled: true,
    expiresAt: days(-60),
    revokedAt: null,
    lastUsedAt: hours(27),
    createdAt: days(30),
    updatedAt: days(4),
    createdBy: "demo",
  },
  {
    id: 3,
    label: "CI pipeline (elevated)",
    keyPrefix: "mcp_live_e5f6",
    consumerId: null,
    elevated: true,
    scopes: null,
    enabled: true,
    expiresAt: null,
    revokedAt: null,
    lastUsedAt: hours(9),
    createdAt: days(18),
    updatedAt: days(1),
    createdBy: "demo",
  },
  {
    id: 4,
    label: "Old prototype key",
    keyPrefix: "mcp_live_9z8y",
    consumerId: null,
    elevated: false,
    scopes: null,
    enabled: false,
    expiresAt: null,
    revokedAt: days(6),
    lastUsedAt: days(22),
    createdAt: days(60),
    updatedAt: days(6),
    createdBy: "demo",
  },
];

let installLinkNextId = 1;
const installLinks: BundleInstallLink[] = [];

const consumers: ConsumerWithUsage[] = [
  {
    id: 1,
    name: "Support team",
    monthlyQuota: 50000,
    endUserRateLimitPerMin: 20,
    usedThisMonth: 18423,
    createdAt: days(90),
    updatedAt: days(2),
    createdBy: "demo",
  },
  {
    id: 2,
    name: "Finance",
    monthlyQuota: 10000,
    endUserRateLimitPerMin: null,
    usedThisMonth: 2140,
    createdAt: days(75),
    updatedAt: days(5),
    createdBy: "demo",
  },
  {
    id: 3,
    name: "Internal agents",
    monthlyQuota: null,
    endUserRateLimitPerMin: null,
    usedThisMonth: 60127,
    createdAt: days(120),
    updatedAt: days(1),
    createdBy: "demo",
  },
];

const alerts: AlertRule[] = [
  {
    id: 1,
    name: "CRM circuit breaker open",
    eventType: "circuit_breaker_open",
    enabled: true,
    webhookUrl: "https://hooks.slack.com/services/T000/B000/xxx",
    threshold: null,
    minCalls: null,
    lastFiredAt: hours(20),
    createdAt: days(30),
    updatedAt: hours(20),
    createdBy: "demo",
  },
  {
    id: 2,
    name: "High error rate",
    eventType: "error_rate",
    enabled: true,
    webhookUrl: "https://hooks.slack.com/services/T000/B001/yyy",
    threshold: 0.1,
    minCalls: 50,
    lastFiredAt: null,
    createdAt: days(21),
    updatedAt: days(21),
    createdBy: "demo",
  },
  {
    id: 3,
    name: "Usage spike detector",
    eventType: "usage_spike",
    enabled: false,
    webhookUrl: "https://hooks.slack.com/services/T000/B002/zzz",
    threshold: 3,
    minCalls: 100,
    lastFiredAt: days(5),
    createdAt: days(14),
    updatedAt: days(3),
    createdBy: "demo",
  },
];

const auditLog: AuditLogEntry[] = [
  {
    id: 128,
    actor: "demo",
    action: "mcpkey.create",
    target: "key:3",
    detail: { label: "CI pipeline (elevated)", elevated: true },
    createdAt: hours(2),
    hash: hex(128),
  },
  {
    id: 127,
    actor: "demo",
    action: "tool.guard.update",
    target: "stripe__create_refund",
    detail: { rateLimitPerMin: 10, timeoutMs: 8000 },
    createdAt: hours(6),
    hash: hex(127),
  },
  {
    id: 126,
    actor: "demo",
    action: "bundle.create",
    target: "bundle:billing-ops",
    detail: { tools: 4 },
    createdAt: hours(9),
    hash: hex(126),
  },
  {
    id: 125,
    actor: "demo",
    action: "client.disable",
    target: "legacy-billing",
    detail: null,
    createdAt: days(1),
    hash: hex(125),
  },
  {
    id: 124,
    actor: "demo",
    action: "alert.fire",
    target: "internal-crm",
    detail: { eventType: "circuit_breaker_open" },
    createdAt: days(1),
    hash: hex(124),
  },
  {
    id: 123,
    actor: "demo",
    action: "client.register",
    target: "github",
    detail: { kind: "mcp", tools: 8 },
    createdAt: days(2),
    hash: hex(123),
  },
  {
    id: 122,
    actor: "demo",
    action: "config.snapshot",
    target: "snapshot:12",
    detail: { label: "before rollout" },
    createdAt: days(2),
    hash: hex(122),
  },
  {
    id: 121,
    actor: "demo",
    action: "user.login",
    target: "demo",
    detail: { method: "session" },
    createdAt: days(3),
    hash: hex(121),
  },
  {
    id: 120,
    actor: "demo",
    action: "team.create",
    target: "team:2",
    detail: { name: "Support" },
    createdAt: days(4),
    hash: hex(120),
  },
  {
    id: 119,
    actor: "demo",
    action: "client.register",
    target: "stripe",
    detail: { kind: "rest", tools: 12 },
    createdAt: days(5),
    hash: hex(119),
  },
];

const users: AdminUserSummary[] = [
  { username: "demo", role: "admin", is_active: true, created_at: days(120), last_login_at: hours(2), team_id: null },
  {
    username: "ops-oncall",
    role: "operator",
    is_active: true,
    created_at: days(60),
    last_login_at: days(1),
    team_id: 2,
  },
  {
    username: "auditor",
    role: "auditor",
    is_active: true,
    created_at: days(45),
    last_login_at: days(7),
    team_id: null,
  },
];

const teams: Team[] = [
  { id: 1, name: "Platform", createdAt: days(120), createdBy: "demo" },
  { id: 2, name: "Support", createdAt: days(90), createdBy: "demo" },
];

const policies: GuardPolicy[] = [
  {
    id: 1,
    name: "Standard read",
    rateLimitPerMin: 120,
    timeoutMs: 10000,
    createdAt: days(50),
    updatedAt: days(10),
    createdBy: "demo",
  },
  {
    id: 2,
    name: "Sensitive write",
    rateLimitPerMin: 10,
    timeoutMs: 8000,
    createdAt: days(40),
    updatedAt: days(4),
    createdBy: "demo",
  },
];

const composites: CompositeSummary[] = [
  { name: "triage_issue", description: "Search GitHub, then post a Slack summary", enabled: true, stepsCount: 2 },
  {
    name: "refund_and_notify",
    description: "Create a Stripe refund and DM the customer owner",
    enabled: true,
    stepsCount: 3,
  },
];

const schedules: Schedule[] = [
  {
    id: 1,
    targetType: "client",
    clientName: "legacy-billing",
    toolName: null,
    action: "disable",
    cron: "0 2 * * *",
    enabled: true,
    lastRunMinute: null,
    createdAt: days(20),
    createdBy: "demo",
  },
  {
    id: 2,
    targetType: "tool",
    clientName: "stripe",
    toolName: "create_refund",
    action: "enable",
    cron: "0 8 * * 1-5",
    enabled: true,
    lastRunMinute: null,
    createdAt: days(15),
    createdBy: "demo",
  },
];

const snapshots: ConfigSnapshotSummary[] = [
  { id: 12, label: "before rollout", createdAt: days(2), createdBy: "demo" },
  { id: 11, label: "add billing-ops bundle", createdAt: days(9), createdBy: "demo" },
  { id: 10, label: "initial", createdAt: days(30), createdBy: "demo" },
];

const topTools: TopToolRow[] = [
  { client: "github", tool: "search_issues", calls: 4210, errors: 12, errorRate: 0.0028, avgMs: 118, maxMs: 940 },
  { client: "stripe", tool: "get_customer", calls: 3320, errors: 8, errorRate: 0.0024, avgMs: 96, maxMs: 610 },
  { client: "slack", tool: "post_message", calls: 2870, errors: 31, errorRate: 0.0108, avgMs: 142, maxMs: 1200 },
  { client: "internal-crm", tool: "find_account", calls: 1980, errors: 54, errorRate: 0.0273, avgMs: 260, maxMs: 2210 },
  { client: "stripe", tool: "create_refund", calls: 640, errors: 3, errorRate: 0.0047, avgMs: 180, maxMs: 880 },
  { client: "weather", tool: "forecast", calls: 5203, errors: 2, errorRate: 0.0004, avgMs: 72, maxMs: 410 },
];

const byKey: UsageByKeyRow[] = [
  { keyId: 1, label: "Claude Desktop", calls: 8120, errors: 44 },
  { keyId: 3, label: "CI pipeline (elevated)", calls: 6010, errors: 61 },
  { keyId: 2, label: "Cursor IDE", calls: 3140, errors: 22 },
  { keyId: null, label: "(no key)", calls: 1153, errors: 10 },
];

const usageSummary: UsageSummary = {
  from: days(7),
  calls: 18423,
  errors: 137,
  errorRate: 0.0074,
  avgMs: 142,
  maxMs: 2210,
  tools: 39,
  keys: 6,
};

const overview: OverviewStats = {
  clients: { live: 5, disabled: 1, healthy: 4, degraded: 1, unreachable: 1 },
  tools: { total: 42, disabled: 3 },
  circuit_breakers: { open: 0, half_open: 1, closed: 4 },
  admin_users: 3,
};

function timeseriesPoints(bucketMs: number, count: number): UsageTimeseriesPoint[] {
  const end = Math.floor(NOW / bucketMs) * bucketMs;
  const points: UsageTimeseriesPoint[] = [];
  for (let i = count - 1; i >= 0; i--) {
    const wave = Math.sin((count - i) / 3) * 0.5 + 0.5;
    const calls = Math.round(80 + wave * 220 + ((i * 37) % 23));
    const errors = Math.round(calls * (0.005 + ((i * 13) % 7) / 400));
    points.push({ t: end - i * bucketMs, calls, errors, avgMs: 90 + ((i * 17) % 60) });
  }
  return points;
}

const usageTimeseries: UsageTimeseries = { bucketMs: 60 * 60_000, points: timeseriesPoints(60 * 60_000, 24) };

const trafficRecords: TrafficRecord[] = [
  {
    id: 14,
    mcpToolName: "github__search_issues",
    clientName: "github",
    toolName: "search_issues",
    keyId: 1,
    argsJson: '{"query":"is:open label:bug"}',
    preview: '{"total_count":6,"items":[{"number":412,"title":"Timeout on large repos"}]}',
    isError: false,
    durationMs: 118,
    createdAt: hours(0.1),
  },
  {
    id: 13,
    mcpToolName: "stripe__get_customer",
    clientName: "stripe",
    toolName: "get_customer",
    keyId: 2,
    argsJson: '{"id":"cus_8Fk2"}',
    preview: '{"id":"cus_8Fk2","email":"finance@example.com"}',
    isError: false,
    durationMs: 96,
    createdAt: hours(0.4),
  },
  {
    id: 12,
    mcpToolName: "slack__post_message",
    clientName: "slack",
    toolName: "post_message",
    keyId: 1,
    argsJson: '{"channel":"#support","text":"Refund issued"}',
    preview: '{"ok":true,"ts":"1719900000.000200"}',
    isError: false,
    durationMs: 142,
    createdAt: hours(0.8),
  },
  {
    id: 11,
    mcpToolName: "internal-crm__find_account",
    clientName: "internal-crm",
    toolName: "find_account",
    keyId: 3,
    argsJson: '{"query":"acme"}',
    preview: "upstream timeout after 8000ms",
    isError: true,
    durationMs: 8003,
    createdAt: hours(1.2),
  },
  {
    id: 10,
    mcpToolName: "weather__forecast",
    clientName: "weather",
    toolName: "forecast",
    keyId: null,
    argsJson: '{"location":"Berlin"}',
    preview: '{"days":[{"high":21,"low":13}]}',
    isError: false,
    durationMs: 61,
    createdAt: hours(1.6),
  },
  {
    id: 9,
    mcpToolName: "github__create_issue",
    clientName: "github",
    toolName: "create_issue",
    keyId: 3,
    argsJson: '{"title":"Docs typo"}',
    preview: '{"number":413,"html_url":"https://github.com/acme/repo/issues/413"}',
    isError: false,
    durationMs: 205,
    createdAt: hours(2.3),
  },
  {
    id: 8,
    mcpToolName: "stripe__create_refund",
    clientName: "stripe",
    toolName: "create_refund",
    keyId: 2,
    argsJson: '{"chargeId":"ch_22aa","amount":2000}',
    preview: '{"id":"re_11bb","status":"succeeded"}',
    isError: false,
    durationMs: 188,
    createdAt: hours(3),
  },
  {
    id: 7,
    mcpToolName: "slack__list_channels",
    clientName: "slack",
    toolName: "list_channels",
    keyId: 1,
    argsJson: "{}",
    preview: '{"channels":[{"id":"C01","name":"support"}]}',
    isError: false,
    durationMs: 74,
    createdAt: hours(3.9),
  },
  {
    id: 6,
    mcpToolName: "internal-crm__update_deal",
    clientName: "internal-crm",
    toolName: "update_deal",
    keyId: 3,
    argsJson: '{"id":"deal_88","stage":"closed_won"}',
    preview: '{"id":"deal_88","stage":"closed_won"}',
    isError: false,
    durationMs: 133,
    createdAt: hours(4.5),
  },
  {
    id: 5,
    mcpToolName: "github__list_pull_requests",
    clientName: "github",
    toolName: "list_pull_requests",
    keyId: 1,
    argsJson: '{"repo":"acme/repo"}',
    preview: '{"total_count":3}',
    isError: false,
    durationMs: 101,
    createdAt: hours(5.2),
  },
  {
    id: 4,
    mcpToolName: "stripe__list_invoices",
    clientName: "stripe",
    toolName: "list_invoices",
    keyId: 2,
    argsJson: "{}",
    preview: "rate limited by upstream",
    isError: true,
    durationMs: 340,
    createdAt: hours(5.8),
  },
  {
    id: 3,
    mcpToolName: "weather__current",
    clientName: "weather",
    toolName: "current",
    keyId: null,
    argsJson: '{"location":"Lisbon"}',
    preview: '{"tempC":24,"condition":"clear"}',
    isError: false,
    durationMs: 58,
    createdAt: hours(6.4),
  },
];

const spansByTrace: Record<string, StoredSpan[]> = {
  "trace-a1": [
    {
      id: 1,
      traceId: "trace-a1",
      spanId: "span-a1",
      name: "tool_call github__search_issues",
      mcpToolName: "github__search_issues",
      sessionId: "session-agent-alpha",
      startMs: hours(0.1),
      endMs: hours(0.1) + 118,
      statusCode: 1,
      attributes: {
        "mcp.tool": "github__search_issues",
        "mcp.tool.is_error": false,
        "mcp.session_id": "session-agent-alpha",
      },
      createdAt: hours(0.1),
    },
  ],
  "trace-b2": [
    {
      id: 2,
      traceId: "trace-b2",
      spanId: "span-b2",
      name: "tool_call internal-crm__find_account",
      mcpToolName: "internal-crm__find_account",
      sessionId: "session-agent-beta",
      startMs: hours(1.2),
      endMs: hours(1.2) + 8003,
      statusCode: 2,
      attributes: {
        "mcp.tool": "internal-crm__find_account",
        "mcp.tool.is_error": true,
        "mcp.session_id": "session-agent-beta",
      },
      createdAt: hours(1.2),
    },
  ],
  "trace-c3": [
    {
      id: 3,
      traceId: "trace-c3",
      spanId: "span-c3",
      name: "tool_call stripe__create_refund",
      mcpToolName: "stripe__create_refund",
      sessionId: "session-agent-alpha",
      startMs: hours(3),
      endMs: hours(3) + 188,
      statusCode: 1,
      attributes: {
        "mcp.tool": "stripe__create_refund",
        "mcp.tool.is_error": false,
        "mcp.session_id": "session-agent-alpha",
      },
      createdAt: hours(3),
    },
  ],
};

const traces: TraceSummary[] = Object.entries(spansByTrace).map(([traceId, spans]) => ({
  traceId,
  spanCount: spans.length,
  startMs: Math.min(...spans.map((s) => s.startMs)),
  endMs: Math.max(...spans.map((s) => s.endMs)),
  mcpToolName: spans[0]?.mcpToolName ?? null,
  sessionId: spans[0]?.sessionId ?? null,
  hasError: spans.some((s) => s.statusCode === 2),
}));

const topSessions: TopSessionRow[] = (() => {
  const byId = new Map<string, { calls: number; hasError: boolean }>();
  for (const spans of Object.values(spansByTrace)) {
    for (const s of spans) {
      if (!s.sessionId) continue;
      const entry = byId.get(s.sessionId) ?? { calls: 0, hasError: false };
      entry.calls += 1;
      entry.hasError = entry.hasError || s.statusCode === 2;
      byId.set(s.sessionId, entry);
    }
  }
  return Array.from(byId.entries())
    .map(([sessionId, v]) => ({ sessionId, ...v }))
    .sort((a, b) => b.calls - a.calls);
})();

const monitors: MonitorRecord[] = [
  {
    clientName: "github",
    toolName: "search_issues",
    exampleId: 1,
    intervalMinutes: 15,
    enabled: true,
    driftDetected: false,
    lastStatus: "ok",
    lastError: null,
    lastCheckedAt: hours(0.2),
  },
  {
    clientName: "stripe",
    toolName: "get_customer",
    exampleId: 2,
    intervalMinutes: 15,
    enabled: true,
    driftDetected: true,
    lastStatus: "ok",
    lastError: null,
    lastCheckedAt: hours(0.3),
  },
  {
    clientName: "internal-crm",
    toolName: "find_account",
    exampleId: 3,
    intervalMinutes: 30,
    enabled: true,
    driftDetected: false,
    lastStatus: "fail",
    lastError: "Timeout after 8000ms",
    lastCheckedAt: hours(1),
  },
  {
    clientName: "slack",
    toolName: "post_message",
    exampleId: 4,
    intervalMinutes: 60,
    enabled: true,
    driftDetected: false,
    lastStatus: null,
    lastError: null,
    lastCheckedAt: null,
  },
  {
    clientName: "weather",
    toolName: "forecast",
    exampleId: 5,
    intervalMinutes: 30,
    enabled: false,
    driftDetected: false,
    lastStatus: "ok",
    lastError: null,
    lastCheckedAt: days(3),
  },
];

const approvals: ApprovalRecord[] = [
  {
    id: 4,
    clientName: "stripe",
    toolName: "create_refund",
    argsHash: hex(4),
    argsJson: '{"chargeId":"ch_501","amount":4200}',
    status: "pending",
    createdAt: hours(1),
    decidedAt: null,
    decidedBy: null,
    note: null,
    consumedAt: null,
    requestedBy: 1,
    requiredLevels: 2,
    decisions: [{ id: 1, approvalId: 4, decidedBy: "alice", decision: "approved", note: null, decidedAt: hours(0.5) }],
  },
  {
    id: 3,
    clientName: "internal-crm",
    toolName: "update_deal",
    argsHash: hex(3),
    argsJson: '{"id":"deal_41","stage":"closed_lost"}',
    status: "pending",
    createdAt: hours(3),
    decidedAt: null,
    decidedBy: null,
    note: null,
    consumedAt: null,
    requestedBy: 3,
    requiredLevels: 1,
    decisions: [],
  },
  {
    id: 2,
    clientName: "stripe",
    toolName: "create_refund",
    argsHash: hex(2),
    argsJson: '{"chargeId":"ch_099","amount":500}',
    status: "approved",
    createdAt: days(1),
    decidedAt: hours(20),
    decidedBy: "demo",
    note: "Confirmed with customer",
    consumedAt: hours(20),
    requestedBy: 2,
    requiredLevels: 1,
    decisions: [
      {
        id: 2,
        approvalId: 2,
        decidedBy: "demo",
        decision: "approved",
        note: "Confirmed with customer",
        decidedAt: hours(20),
      },
    ],
  },
  {
    id: 1,
    clientName: "internal-crm",
    toolName: "update_deal",
    argsHash: hex(1),
    argsJson: '{"id":"deal_12","stage":"closed_won"}',
    status: "rejected",
    createdAt: days(2),
    decidedAt: days(1),
    decidedBy: "demo",
    note: "Needs manager sign-off first",
    consumedAt: null,
    requestedBy: null,
    requiredLevels: 1,
    decisions: [
      {
        id: 3,
        approvalId: 1,
        decidedBy: "demo",
        decision: "rejected",
        note: "Needs manager sign-off first",
        decidedAt: days(1),
      },
    ],
  },
];

const DEMO_USER: NonNullable<CurrentUser["user"]> = { username: "demo", role: "admin" };

const discoveryPreview: DiscoveryPreview = {
  count: 5,
  tools: [
    { name: "list_pets", method: "GET", endpoint: "/pet/findByStatus", description: "Finds pets by status" },
    { name: "get_pet", method: "GET", endpoint: "/pet/{petId}", description: "Find pet by ID" },
    { name: "add_pet", method: "POST", endpoint: "/pet", description: "Add a new pet to the store" },
    { name: "update_pet", method: "PUT", endpoint: "/pet", description: "Update an existing pet" },
    { name: "delete_pet", method: "DELETE", endpoint: "/pet/{petId}", description: "Deletes a pet" },
  ],
};

// ─── Router ──────────────────────────────────────────────────────────────────

function ok<T>(v: T): T {
  return v;
}

function route(
  pathname: string,
  method: string,
  body: Record<string, unknown> | undefined,
  params: URLSearchParams,
): unknown {
  const p = pathname.replace(/\/+$/, "") || "/";

  // Auth — always "logged in" as the demo admin.
  if (p === "/admin-api/auth/me")
    return ok<CurrentUser>({ authenticated: true, auth_method: "session", user: DEMO_USER });
  if (p === "/admin-api/auth/login") return ok({ user: DEMO_USER, csrf_token: "demo-csrf-token" });
  if (p === "/admin-api/auth/logout") return ok({});
  if (p === "/admin-api/auth/me/password" && method === "PATCH") return ok({});
  if (p === "/admin-api/auth/sessions" && method === "GET") {
    return ok<{ sessions: AdminSession[] }>({
      sessions: [
        {
          id: 1,
          createdAt: NOW - 3600_000,
          lastSeenAt: NOW,
          expiresAt: NOW + 3600_000,
          ipAddress: "203.0.113.10",
          userAgent: "Mozilla/5.0 (this device)",
        },
        {
          id: 2,
          createdAt: NOW - 86_400_000,
          lastSeenAt: NOW - 7200_000,
          expiresAt: NOW + 86_400_000,
          ipAddress: "198.51.100.42",
          userAgent: "Mozilla/5.0 (another device)",
        },
      ],
    });
  }
  if (/^\/admin-api\/auth\/sessions\/[^/]+$/.test(p) && method === "DELETE") return ok({});

  // SSO — GET/config is what LoginPage.vue checks pre-auth; the demo never
  // enables it (no real IdP to redirect to), but /settings is still a real,
  // interactive form like the rest of this demo's admin-only config screens.
  // /start and /callback are real OAuth redirect targets a static demo SPA
  // has no backend to stand behind, so they're excluded from the demo-vs-real
  // contract test instead of mocked here.
  if (p === "/admin-api/auth/oidc/config") return ok<OidcPublicConfig>({ enabled: oidcSettings?.enabled ?? false });
  if (p === "/admin-api/auth/oidc/settings") {
    if (method === "GET") return ok<{ settings: OidcSettings | null }>({ settings: oidcSettings });
    if (method === "PUT") {
      const b = body ?? {};
      oidcSettings = {
        issuer: typeof b.issuer === "string" ? b.issuer : "",
        clientId: typeof b.clientId === "string" ? b.clientId : "",
        redirectUri: typeof b.redirectUri === "string" ? b.redirectUri : "",
        scopes: typeof b.scopes === "string" ? b.scopes : "openid profile email",
        enabled: b.enabled === true,
        defaultRole: "viewer",
        updatedAt: NOW,
      };
      return ok({ status: "updated" });
    }
  }

  if (p === "/admin-api/overview") return ok(overview);
  if (p === "/admin-api/connect/gateway-url") return ok({ publicUrl: null });

  // Clients (servers)
  if (p === "/admin-api/clients" && method === "GET") return ok({ items: clients });
  const clientDetailMatch = p.match(/^\/admin-api\/clients\/([^/]+)$/);
  if (clientDetailMatch) {
    const name = decodeURIComponent(clientDetailMatch[1]);
    if (method === "GET") return ok(clientDetail(name));
    if (method === "PATCH") {
      const c = clients.find((x) => x.name === name);
      if (c && body && typeof body.enabled === "boolean") c.enabled = body.enabled;
      return ok(clientDetail(name));
    }
    if (method === "DELETE") return undefined;
  }
  if (/^\/admin-api\/clients\/[^/]+\/canary$/.test(p)) return ok({ canary: null });
  if (/^\/admin-api\/clients\/[^/]+\/upstream-auth$/.test(p)) return ok({ configured: false });
  if (/^\/admin-api\/clients\//.test(p)) return ok({}); // any other per-client mutation

  // Bundles
  if (p === "/admin-api/bundles" && method === "GET") return ok({ items: bundles });
  if (p === "/admin-api/bundles" && method === "POST") {
    const name = String(body?.name ?? "new-bundle");
    return ok<BundleDetail>({
      name,
      description: (body?.description as string) ?? null,
      enabled: true,
      createdAt: NOW,
      updatedAt: NOW,
      tools: [],
    });
  }
  const bundleDetailMatch = p.match(/^\/admin-api\/bundles\/([^/]+)$/);
  if (bundleDetailMatch) {
    const name = decodeURIComponent(bundleDetailMatch[1]);
    if (method === "DELETE") return undefined;
    if (method === "PATCH") {
      const b = bundles.find((x) => x.name === name);
      if (b && body && typeof body.enabled === "boolean") b.enabled = body.enabled;
    }
    const b = bundles.find((x) => x.name === name);
    return ok<BundleDetail>({
      name,
      description: b?.description ?? null,
      enabled: b?.enabled ?? true,
      createdAt: days(9),
      updatedAt: NOW,
      tools: (TOOLS[clients[0].name] ?? []).slice(0, 2).map((t) => ({ client: clients[0].name, tool: t.name })),
    });
  }

  // Bundle install links
  const installLinksListMatch = p.match(/^\/admin-api\/bundles\/([^/]+)\/install-links$/);
  if (installLinksListMatch) {
    const bundleName = decodeURIComponent(installLinksListMatch[1]);
    if (method === "GET") {
      return ok({ items: installLinks.filter((l) => l.bundleName === bundleName) });
    }
    if (method === "POST") {
      const id = installLinkNextId++;
      const tokenPrefix = `bil_demo${String(id).padStart(3, "0")}`;
      const link: BundleInstallLinkWithToken = {
        id,
        bundleName,
        tokenPrefix,
        mcpKeyId: 900 + id,
        createdBy: "demo",
        createdAt: NOW,
        expiresAt: null,
        revokedAt: null,
        lastUsedAt: null,
        token: `${tokenPrefix}xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`,
      };
      installLinks.unshift(link);
      return ok<BundleInstallLinkWithToken>(link);
    }
  }
  const installLinkRevokeMatch = p.match(/^\/admin-api\/bundles\/[^/]+\/install-links\/(\d+)$/);
  if (installLinkRevokeMatch && method === "DELETE") {
    const id = Number(installLinkRevokeMatch[1]);
    const link = installLinks.find((l) => l.id === id);
    if (link) link.revokedAt = NOW;
    return ok({ status: "revoked", id });
  }

  if (p === "/admin-api/tools") return ok({ items: flatTools });

  // Catalog
  if (p === "/admin-api/catalog" && method === "GET") return ok({ items: catalogEntries });
  if (p === "/admin-api/catalog" && method === "POST") {
    const entry: CatalogEntry = {
      id: `custom:${catalogEntries.length + 1}`,
      source: "custom",
      slug: String(body?.slug ?? "new-entry"),
      name: String(body?.name ?? "New entry"),
      description: (body?.description as string) ?? null,
      kind: (body?.kind as "rest" | "mcp") ?? "rest",
      category: (body?.category as string) ?? null,
      tags: [],
      icon: null,
      healthUrl: (body?.healthUrl as string) ?? null,
      openapiUrl: (body?.openapiUrl as string) ?? null,
      mcpUrl: (body?.mcpUrl as string) ?? null,
      featured: false,
    };
    catalogEntries.push(entry);
    return ok(entry);
  }
  const catalogInstallMatch = p.match(/^\/admin-api\/catalog\/([^/]+)\/install$/);
  if (catalogInstallMatch) {
    const entry = catalogEntries.find((e) => e.id === decodeURIComponent(catalogInstallMatch[1]));
    const name = String(body?.name ?? entry?.slug ?? "new-server");
    return ok({ status: "registered", name, tools_count: 3, source: entry?.kind === "mcp" ? "mcp" : "openapi" });
  }
  const catalogEntryMatch = p.match(/^\/admin-api\/catalog\/([^/]+)$/);
  if (catalogEntryMatch) {
    const id = decodeURIComponent(catalogEntryMatch[1]);
    if (method === "DELETE") {
      const idx = catalogEntries.findIndex((e) => e.id === id);
      if (idx !== -1) catalogEntries.splice(idx, 1);
      return ok({ status: "deleted", id });
    }
    if (method === "PATCH") {
      const e = catalogEntries.find((x) => x.id === id);
      if (e && body) Object.assign(e, body);
      return ok(e ?? {});
    }
  }

  // WS proxy targets
  if (p === "/admin-api/ws-proxy-targets" && method === "GET") return ok({ items: wsProxyTargets });
  if (p === "/admin-api/ws-proxy-targets" && method === "POST") {
    const target: WsProxyTarget = {
      name: String(body?.name ?? "new-target"),
      backendWsUrl: String(body?.backendWsUrl ?? ""),
      resolvedIp: "203.0.113.99",
      maxConnections: Number(body?.maxConnections ?? 10),
      maxMessageBytes: Number(body?.maxMessageBytes ?? 1_048_576),
      idleTimeoutMs: Number(body?.idleTimeoutMs ?? 300_000),
      enabled: true,
      activeConnections: 0,
      createdAt: NOW,
      updatedAt: NOW,
    };
    wsProxyTargets.push(target);
    return ok(target);
  }
  const wsProxyDisconnectMatch = p.match(/^\/admin-api\/ws-proxy-targets\/([^/]+)\/disconnect-all$/);
  if (wsProxyDisconnectMatch) {
    const t = wsProxyTargets.find((x) => x.name === decodeURIComponent(wsProxyDisconnectMatch[1]));
    const closed = t?.activeConnections ?? 0;
    if (t) t.activeConnections = 0;
    return ok({ status: "disconnected", closed });
  }
  const wsProxyTargetMatch = p.match(/^\/admin-api\/ws-proxy-targets\/([^/]+)$/);
  if (wsProxyTargetMatch) {
    const name = decodeURIComponent(wsProxyTargetMatch[1]);
    if (method === "DELETE") {
      const idx = wsProxyTargets.findIndex((x) => x.name === name);
      if (idx !== -1) wsProxyTargets.splice(idx, 1);
      return ok({ status: "deleted", name });
    }
    if (method === "PATCH") {
      const t = wsProxyTargets.find((x) => x.name === name);
      if (t && body) Object.assign(t, body);
      return ok(t ?? {});
    }
  }

  // Keys & consumers
  if (p === "/admin-api/mcp-keys" && method === "GET") return ok({ items: mcpKeys });
  if (p === "/admin-api/mcp-keys" && method === "POST") {
    return ok<McpApiKeyWithSecret>({
      id: 99,
      label: String(body?.label ?? "New key"),
      keyPrefix: "mcp_live_new0",
      consumerId: null,
      elevated: Boolean(body?.elevated),
      scopes: null,
      enabled: true,
      expiresAt: null,
      revokedAt: null,
      lastUsedAt: null,
      createdAt: NOW,
      updatedAt: NOW,
      createdBy: "demo",
      key: "mcp_live_new0DEMOxxxxxxxxxxxxxxxxxxxxxxxx",
    });
  }
  if (/^\/admin-api\/mcp-keys\/\d+\/revoke$/.test(p)) return ok({});
  if (/^\/admin-api\/mcp-keys\//.test(p)) return undefined;
  if (p === "/admin-api/consumers" && method === "GET") return ok({ items: consumers });
  const consumerUsageMatch = p.match(/^\/admin-api\/consumers\/(\d+)\/usage$/);
  if (consumerUsageMatch && method === "GET") {
    const c = consumers.find((x) => x.id === Number(consumerUsageMatch[1]));
    return ok({ used: c?.usedThisMonth ?? 0, quota: c?.monthlyQuota ?? null });
  }
  if (/^\/admin-api\/consumers/.test(p)) return ok({ id: 99, name: String(body?.name ?? "New") });

  // Tags (browse-by-tag)
  if (p === "/admin-api/tags" && method === "GET") return ok({ items: tagCounts });
  const tagToolsMatch = p.match(/^\/admin-api\/tags\/([^/]+)\/tools$/);
  if (tagToolsMatch && method === "GET") return ok({ items: toolsByTag(decodeURIComponent(tagToolsMatch[1])) });

  // Observability
  if (p === "/admin-api/usage/summary") return ok(usageSummary);
  if (p === "/admin-api/usage/top-tools") return ok({ items: topTools });
  if (p === "/admin-api/usage/by-key") return ok({ items: byKey });
  if (p === "/admin-api/usage/timeseries") return ok(usageTimeseries);
  if (p === "/admin-api/alerts" && method === "GET") return ok({ items: alerts });
  if (/^\/admin-api\/alerts/.test(p)) return ok({ id: 99 });
  if (p === "/admin-api/audit-log/actions") {
    return ok({ actions: Array.from(new Set(auditLog.map((e) => e.action))).sort() });
  }
  if (p === "/admin-api/audit-log") return ok({ items: auditLog });
  if (p === "/admin-api/audit-log/export") return ok({ items: auditLog });
  if (p === "/admin-api/audit-log/verify") return ok({ ok: true, checked: auditLog.length });

  // Traffic explorer
  if (p === "/admin-api/traffic" && method === "GET") {
    let items = trafficRecords.slice();
    const client = params.get("client");
    const tool = params.get("tool");
    if (client) items = items.filter((r) => r.clientName === client);
    if (tool) items = items.filter((r) => r.toolName === tool);
    if (params.get("errors") === "true") items = items.filter((r) => r.isError);
    return ok({ items });
  }
  const trafficDetailMatch = p.match(/^\/admin-api\/traffic\/(\d+)$/);
  if (trafficDetailMatch && method === "GET") {
    const rec = trafficRecords.find((r) => r.id === Number(trafficDetailMatch[1]));
    return rec ? ok(rec) : undefined;
  }
  if (/^\/admin-api\/traffic\/\d+\/replay$/.test(p) && method === "POST") {
    return ok({
      content: [{ type: "text", text: "Replayed successfully (demo — no real upstream was called)." }],
      isError: false,
    });
  }

  // Trace viewer
  if (p === "/admin-api/traces" && method === "GET") {
    const tool = params.get("tool");
    const sessionId = params.get("session_id");
    let items = tool ? traces.filter((t) => t.mcpToolName === tool) : traces;
    if (sessionId) items = items.filter((t) => t.sessionId === sessionId);
    return ok({ items });
  }
  if (p === "/admin-api/traces" && method === "DELETE") {
    return ok({ status: "purged", removed: traces.length });
  }
  if (p === "/admin-api/traces/top-sessions" && method === "GET") {
    return ok({ items: topSessions });
  }
  const traceDetailMatch = p.match(/^\/admin-api\/traces\/([^/]+)$/);
  if (traceDetailMatch && method === "GET") {
    const spans = spansByTrace[traceDetailMatch[1]];
    return spans ? ok({ traceId: traceDetailMatch[1], spans }) : undefined;
  }

  // Synthetic monitors
  if (p === "/admin-api/monitors") return ok({ items: monitors });

  // Approvals
  if (p === "/admin-api/approvals" && method === "GET") {
    const status = params.get("status") as ApprovalStatus | null;
    // Always return a fresh array (never the live `approvals` reference) — Vue's ref
    // setter no-ops on an unchanged object identity, so reusing the same reference
    // across reloads would silently stop the status-breakdown donut from updating.
    const items = status ? approvals.filter((a) => a.status === status) : approvals.slice();
    return ok({ items });
  }
  const approvalDecideMatch = p.match(/^\/admin-api\/approvals\/(\d+)\/(approve|reject)$/);
  if (approvalDecideMatch && method === "POST") {
    const id = Number(approvalDecideMatch[1]);
    const decision: ApprovalStatus = approvalDecideMatch[2] === "approve" ? "approved" : "rejected";
    const a = approvals.find((x) => x.id === id);
    if (a && a.status === "pending") {
      const note = typeof body?.note === "string" ? body.note : null;
      a.decisions.push({
        id: a.decisions.length + 1,
        approvalId: a.id,
        decidedBy: "demo",
        decision,
        note,
        decidedAt: NOW,
      });
      const approvedCount = a.decisions.filter((d) => d.decision === "approved").length;
      if (decision === "rejected" || approvedCount >= a.requiredLevels) {
        a.status = decision === "rejected" ? "rejected" : "approved";
        a.decidedAt = NOW;
        a.decidedBy = "demo";
        a.note = note;
      }
    }
    return ok({ status: a?.status ?? decision, id });
  }

  // Administration
  if (p === "/admin-api/users" && method === "GET") return ok({ users });
  const userTeamMatch = p.match(/^\/admin-api\/users\/([^/]+)\/team$/);
  if (userTeamMatch && method === "PUT") {
    const u = users.find((x) => x.username === decodeURIComponent(userTeamMatch[1]));
    const teamId = body?.teamId === null ? null : typeof body?.teamId === "number" ? body.teamId : null;
    if (u) u.team_id = teamId;
    return ok({ status: "updated", username: u?.username, teamId });
  }
  if (/^\/admin-api\/users/.test(p)) return ok({ ok: true });
  if (p === "/admin-api/teams" && method === "GET") return ok({ items: teams });
  if (/^\/admin-api\/teams/.test(p)) return ok({ id: 99 });
  if (p === "/admin-api/policies") return ok({ items: policies });
  if (/^\/admin-api\/policies/.test(p)) return ok({ applied: 3, skipped: [] });
  if (p === "/admin-api/composites") return ok({ items: composites });
  if (/^\/admin-api\/composites/.test(p)) return ok({});
  if (p === "/admin-api/schedules") return ok({ items: schedules });
  if (/^\/admin-api\/schedules/.test(p)) return ok({ id: 99 });
  if (p === "/admin-api/config/snapshots") return ok({ items: snapshots });
  if (p === "/admin-api/config/export") return ok({ version: 1, clients: clients.length, bundles: bundles.length });
  if (/^\/admin-api\/config\/(snapshots|import)/.test(p))
    return ok({
      dryRun: true,
      applied: { bundles: 3, alertRules: 3, clientsConfigured: 6, toolsConfigured: 42 },
      skipped: [],
    });

  // Discovery preview (Add server / re-sync)
  if (p === "/admin-api/discovery/preview" || p === "/admin-api/discovery/preview-graphql" || p === "/register")
    return ok(discoveryPreview);

  // Graceful default: never 404 the demo.
  if (method === "GET") return ok({ items: [] });
  return ok({ ok: true });
}

/** Drop-in replacement for the real fetch path, used only in demo builds. */
export async function demoFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const method = (init.method ?? "GET").toUpperCase();
  let body: Record<string, unknown> | undefined;
  if (typeof init.body === "string") {
    try {
      body = JSON.parse(init.body) as Record<string, unknown>;
    } catch {
      body = undefined;
    }
  }
  const [pathname, search] = path.split("?");
  const params = new URLSearchParams(search ?? "");
  // A touch of latency so spinners/skeletons behave like the real thing.
  await new Promise((r) => setTimeout(r, 90 + Math.floor(Math.random() * 120)));
  return route(pathname, method, body, params) as T;
}
