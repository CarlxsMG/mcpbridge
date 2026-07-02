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
 * install-time discovery fetch and confuses whoever clicks it.
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
    slug: "petstore",
    name: "Swagger Petstore",
    description: "The canonical OpenAPI sample API — pets, orders, and inventory. Good for a first end-to-end test of REST discovery.",
    kind: "rest",
    category: "Examples",
    tags: ["demo", "no-auth", "openapi-sample"],
    icon: "paw-print",
    healthUrl: "https://petstore3.swagger.io/",
    openapiUrl: "https://petstore3.swagger.io/api/v3/openapi.json",
    featured: true,
  },
];
