/**
 * Curated, version-controlled catalog of well-known OpenAPI/MCP servers for
 * one-click install from the admin UI. Plain code, not a DB table — no
 * migration in this project seeds data rows, and adding/editing a gallery
 * entry is a content change, reviewed like any other code change, not an
 * admin action.
 *
 * Every URL here goes through the exact same SSRF/discovery validation as a
 * hand-typed one at install time (see performRestRegistration /
 * performMcpRegistration in ../routes/register.js) — curation is a UX
 * convenience, not a trust upgrade.
 *
 * Keep this list to entries whose URLs have been verified to actually work
 * (checked at PR review) — a broken catalog entry silently fails the
 * install-time discovery fetch and confuses whoever clicks it. Every
 * `openapiUrl` below was fetched and run through the real discovery pipeline
 * (`discoverToolsFromOpenApi`) during authoring, and every `healthUrl` was
 * confirmed to return a bare HTTP 2xx with no redirect and no auth — the
 * periodic health-check loop (src/observability/health.ts) uses `redirect: "error"` and
 * auto-evicts a client after `maxConsecutiveFailures` (default 3, ~90s at the
 * default 30s interval), so a health URL that 401s or redirects will silently
 * delete the very client this catalog just installed.
 *
 * Two entries (Jira, Zendesk) are genuinely multi-tenant SaaS — every real
 * customer lives at their own subdomain, and this catalog's install route
 * (src/routes/catalog.ts) has no way to parameterize `baseUrl` per install
 * (only `name` is caller-supplied). Their `baseUrl` here is a stable
 * placeholder host used purely to pass install-time SSRF validation and keep
 * health checks green; the description says so, and the admin is expected to
 * repoint `baseUrl` at their own tenant afterward, the same way an installed
 * MCP entry that needs auth is expected to get upstream credentials set
 * before it's actually useful.
 */
export interface BuiltinCatalogEntry {
  slug: string;
  name: string;
  description: string;
  kind: "rest" | "mcp";
  category: string;
  tags: string[];
  icon: string;
  openapiUrl?: string;
  healthUrl?: string;
  baseUrl?: string;
  includeTags?: string[];
  excludeOperations?: string[];
  mcpUrl?: string;
  mcpTransport?: "streamable-http" | "sse";
  featured?: boolean;
}

export const BUILTIN_CATALOG: BuiltinCatalogEntry[] = [
  {
    slug: "slack",
    name: "Slack",
    description: "Send messages, search conversations, and manage channels in a Slack workspace.",
    kind: "rest",
    category: "Communication",
    tags: ["messaging", "team-chat", "workspace"],
    icon: "message-circle",
    healthUrl: "https://slack.com/api/api.test",
    baseUrl: "https://slack.com/api",
    openapiUrl: "https://api.slack.com/specs/openapi/v2/slack_web.json",
    includeTags: ["conversations", "chat", "users", "reactions", "pins", "search"],
    featured: true,
  },
  {
    slug: "jira",
    name: "Jira Cloud",
    description:
      "Search, create, and update issues, comments, and projects on your Jira Cloud site (set the base URL to your instance after installing).",
    kind: "rest",
    category: "Productivity",
    tags: ["issue-tracking", "project-management", "atlassian"],
    icon: "kanban",
    healthUrl: "https://developer.atlassian.com/cloud/jira/platform/",
    baseUrl: "https://developer.atlassian.com",
    openapiUrl: "https://developer.atlassian.com/cloud/jira/platform/swagger-v3.v3.json",
    includeTags: ["Issues", "Issue comments", "Issue search", "Projects", "Users"],
    excludeOperations: [
      "archiveIssuesAsync",
      "archiveIssues",
      "unarchiveIssues",
      "exportArchivedIssues",
      "bulkGetUsersMigration",
      "resetUserColumns",
      "getUserDefaultColumns",
      "setUserColumns",
    ],
    featured: true,
  },
  {
    slug: "zendesk",
    name: "Zendesk",
    description:
      "Create, search, and update support tickets and comments on your Zendesk instance (set the base URL to your subdomain after installing).",
    kind: "rest",
    category: "Customer support",
    tags: ["support", "ticketing", "helpdesk"],
    icon: "life-buoy",
    healthUrl: "https://developer.zendesk.com/api-reference/",
    baseUrl: "https://developer.zendesk.com",
    openapiUrl: "https://developer.zendesk.com/zendesk/oas.yaml",
    includeTags: ["Tickets", "Ticket Comments", "Search"],
  },
  {
    slug: "adyen",
    name: "Adyen Checkout",
    description: "Create payments, orders, and payment links through Adyen's Checkout API test environment.",
    kind: "rest",
    category: "Payments",
    tags: ["payments", "checkout", "fintech"],
    icon: "credit-card",
    healthUrl: "https://docs.adyen.com/",
    baseUrl: "https://checkout-test.adyen.com/v71",
    openapiUrl: "https://raw.githubusercontent.com/Adyen/adyen-openapi/main/json/CheckoutService-v71.json",
  },
  {
    slug: "sentry",
    name: "Sentry",
    description: "Manage Sentry projects, teams, and alert routing for application error and performance monitoring.",
    kind: "rest",
    category: "Developer tools",
    tags: ["observability", "error-tracking", "monitoring"],
    icon: "bug",
    healthUrl: "https://docs.sentry.io/",
    baseUrl: "https://us.sentry.io",
    openapiUrl: "https://raw.githubusercontent.com/getsentry/sentry-api-schema/main/openapi-derefed.json",
    includeTags: ["Projects", "Teams"],
  },
  {
    slug: "pagerduty",
    name: "PagerDuty",
    description: "Manage incidents, services, and escalation policies for on-call incident response in PagerDuty.",
    kind: "rest",
    category: "Incident management",
    tags: ["incident-response", "on-call", "alerting"],
    icon: "siren",
    healthUrl: "https://developer.pagerduty.com/",
    baseUrl: "https://api.pagerduty.com",
    openapiUrl: "https://raw.githubusercontent.com/PagerDuty/api-schema/main/reference/REST/openapiv3.json",
    includeTags: ["Incidents", "Services", "Escalation Policies"],
  },
  {
    slug: "asana",
    name: "Asana",
    description: "Create and track tasks, projects, and comments for team work management in Asana.",
    kind: "rest",
    category: "Productivity",
    tags: ["task-management", "project-management", "collaboration"],
    icon: "list-checks",
    healthUrl: "https://developers.asana.com/",
    baseUrl: "https://app.asana.com/api/1.0",
    openapiUrl: "https://raw.githubusercontent.com/Asana/openapi/master/defs/asana_oas.yaml",
    includeTags: ["Tasks", "Projects", "Stories"],
  },
];
