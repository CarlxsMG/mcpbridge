/**
 * One-click MCP client connection config generator — per-client template
 * registry. MIRROR of src/cli/connect-templates.ts (the backend/CLI copy
 * used by `gateway connect`) — admin-ui has zero shared deps with the
 * backend package (own package.json, own build), so this file is hand-kept
 * in sync rather than imported. Keep the two in sync by hand whenever either
 * changes; there is no build step that shares code across the two packages.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * Hand-writing claude_desktop_config.json / .cursor/mcp.json / Windsurf's
 * mcp_config.json / Continue's config.yaml is real adoption friction, and the
 * expected shape differs per client AND has been actively moving since the
 * November 2025 MCP spec revision replaced HTTP+SSE with Streamable HTTP as
 * the default remote transport. Each template below was verified against
 * that client's own current docs (not training-data assumptions) via
 * WebSearch/WebFetch on 2026-07-03:
 *
 *   - Cursor:          https://cursor.com/docs/mcp
 *                       mcp.json, top-level "mcpServers" map keyed by name,
 *                       remote entries take a direct { url, headers } shape
 *                       (no local bridge process needed). File lives at
 *                       .cursor/mcp.json (project) or ~/.cursor/mcp.json
 *                       (global).
 *   - Windsurf:        https://docs.windsurf.com/windsurf/cascade/mcp
 *                       mcp_config.json, same "mcpServers" map shape, but the
 *                       docs' own examples use "serverUrl" (not "url") for
 *                       the remote endpoint + a "headers" map. Always at
 *                       ~/.codeium/windsurf/mcp_config.json.
 *   - Continue:        https://docs.continue.dev/customize/deep-dives/mcp and
 *                       https://docs.continue.dev/reference
 *                       config.yaml — "mcpServers" is a YAML *array* (not a
 *                       name-keyed map like the others), each entry has a
 *                       "type" discriminator (streamable-http | sse) and a
 *                       "url"; auth headers go under a nested
 *                       requestOptions.headers map. Lives at .continue/config.yaml
 *                       (workspace) or ~/.continue/config.yaml (global).
 *   - Claude Desktop:  https://modelcontextprotocol.io/docs/develop/connect-remote-servers,
 *                       https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp,
 *                       https://github.com/geelen/mcp-remote
 *                       Claude Desktop's built-in remote-MCP UI ("Custom
 *                       Connectors", Settings > Connectors) takes a URL plus,
 *                       at most, an OAuth client id/secret — there is no
 *                       field for a static bearer/API-key header. Since this
 *                       project authenticates MCP calls with a static bearer
 *                       key (not OAuth), the only way to inject that header
 *                       is the community-standard `mcp-remote` stdio bridge
 *                       run from claude_desktop_config.json's "mcpServers".
 *                       mcp-remote's documented default probe order is
 *                       "http-first" (try Streamable HTTP, fall back to SSE
 *                       on a 404), so no extra flag is needed against this
 *                       gateway's Streamable HTTP endpoints.
 *
 * ── This gateway's own transport, for context ───────────────────────────────
 * Every endpoint this generator points at — the sharded /mcp/:clientName and
 * /mcp-custom/:bundleName endpoints, and the legacy aggregated /mcp — is
 * Streamable HTTP only (see src/transports.ts's route mounts: none of them
 * have a per-scope SSE alternative; only the separate, deliberately-legacy
 * aggregated /sse+/messages pair uses the old SSE transport, and nothing in
 * this generator points at it). So `transport` below is always
 * "streamable-http" in practice today; the field stays part of the shared
 * shape (rather than being dropped) because Continue's template needs an
 * explicit discriminator and a future SSE-fallback endpoint on this gateway
 * would only require changing the one call site that resolves it, not this
 * registry.
 */

export type ConnectTransport = "streamable-http" | "sse";

export type ConnectScope = "client" | "bundle" | "aggregated";

export const CONNECT_CLIENT_IDS = ["claude-desktop", "cursor", "windsurf", "continue", "generic-json"] as const;

export type ConnectClientId = (typeof CONNECT_CLIENT_IDS)[number];

export interface ConnectTemplateInput {
  /** mcpServers key / display name for this connection — the client or bundle name (or "gateway" for the aggregated scope). */
  name: string;
  /** Fully-resolved gateway URL for the chosen scope, e.g. https://gw.example.com/mcp/acme-crm */
  url: string;
  transport: ConnectTransport;
  /** Always a placeholder like "<YOUR_MCP_API_KEY>" — callers must never pass a real key here. */
  apiKeyPlaceholder: string;
}

export interface ConnectTemplateOutput {
  /** Suggested filename for the snippet — see `instructions` for the actual save path (which varies per OS/scope for some clients). */
  filename: string;
  /** Ready-to-paste config text (JSON or YAML, depending on the client). */
  snippet: string;
  /** Short, ordered setup steps in plain English. */
  instructions: string[];
}

export interface ConnectTemplate {
  id: ConnectClientId;
  label: string;
  generate(input: ConnectTemplateInput): ConnectTemplateOutput;
}

function jsonBlock(obj: unknown): string {
  return JSON.stringify(obj, null, 2);
}

function apiKeyHint(apiKeyPlaceholder: string): string {
  return `Replace ${apiKeyPlaceholder} with a real MCP API key — create one first under "API keys" in the admin UI if you don't have one yet.`;
}

const claudeDesktop: ConnectTemplate = {
  id: "claude-desktop",
  label: "Claude Desktop",
  generate({ name, url, apiKeyPlaceholder }) {
    const snippet = jsonBlock({
      mcpServers: {
        [name]: {
          command: "npx",
          args: ["-y", "mcp-remote", url, "--header", "Authorization:${AUTH_HEADER}"],
          env: {
            // No spaces around ":" in the --header arg above — Cursor and
            // Claude Desktop on Windows both have a known bug mangling
            // spaces inside args passed to npx, so the actual token (with
            // its "Bearer " prefix, which does have a space) lives in this
            // env var instead and gets substituted in by mcp-remote.
            AUTH_HEADER: `Bearer ${apiKeyPlaceholder}`,
          },
        },
      },
    });
    return {
      filename: "claude_desktop_config.json",
      snippet,
      instructions: [
        "Open (or create) claude_desktop_config.json — macOS: ~/Library/Application Support/Claude/claude_desktop_config.json · Windows: %APPDATA%\\Claude\\claude_desktop_config.json",
        `Merge the snippet below into its top-level "mcpServers" object (add that key if the file is new/empty).`,
        apiKeyHint(apiKeyPlaceholder),
        "Completely quit and restart Claude Desktop (not just close the window) for the new server to load.",
      ],
    };
  },
};

const cursor: ConnectTemplate = {
  id: "cursor",
  label: "Cursor",
  generate({ name, url, apiKeyPlaceholder }) {
    const snippet = jsonBlock({
      mcpServers: {
        [name]: {
          url,
          headers: {
            Authorization: `Bearer ${apiKeyPlaceholder}`,
          },
        },
      },
    });
    return {
      filename: "mcp.json",
      snippet,
      instructions: [
        "Save as .cursor/mcp.json in this project, or ~/.cursor/mcp.json to make it available in every project.",
        apiKeyHint(apiKeyPlaceholder),
        "Cursor picks up mcp.json changes automatically — reopen the MCP settings panel to confirm it connected.",
      ],
    };
  },
};

const windsurf: ConnectTemplate = {
  id: "windsurf",
  label: "Windsurf",
  generate({ name, url, apiKeyPlaceholder }) {
    const snippet = jsonBlock({
      mcpServers: {
        [name]: {
          serverUrl: url,
          headers: {
            Authorization: `Bearer ${apiKeyPlaceholder}`,
          },
        },
      },
    });
    return {
      filename: "mcp_config.json",
      snippet,
      instructions: [
        "Save as ~/.codeium/windsurf/mcp_config.json (Cascade's MCP panel > Configure also opens this file for you).",
        apiKeyHint(apiKeyPlaceholder),
        "Click the refresh icon in Cascade's MCP panel (or restart Windsurf) to load the new server.",
      ],
    };
  },
};

const continueDev: ConnectTemplate = {
  id: "continue",
  label: "Continue",
  generate({ name, url, transport, apiKeyPlaceholder }) {
    // Continue's mcpServers is a YAML array, not a name-keyed map — see the
    // file-level comment above.
    const snippet = [
      "mcpServers:",
      `  - name: ${name}`,
      `    type: ${transport}`,
      `    url: ${url}`,
      "    requestOptions:",
      "      headers:",
      `        Authorization: "Bearer ${apiKeyPlaceholder}"`,
    ].join("\n");
    return {
      filename: "config.yaml",
      snippet,
      instructions: [
        "Save under .continue/config.yaml in this workspace, or ~/.continue/config.yaml to make it available everywhere.",
        "If the file already has a top-level mcpServers: list, append this entry to it rather than duplicating the key.",
        apiKeyHint(apiKeyPlaceholder),
        "Continue reloads config.yaml automatically — check the MCP Servers panel to confirm it connected.",
      ],
    };
  },
};

const genericJson: ConnectTemplate = {
  id: "generic-json",
  label: "Generic (url + headers)",
  generate({ name, url, transport, apiKeyPlaceholder }) {
    const snippet = jsonBlock({
      mcpServers: {
        [name]: {
          url,
          transport,
          headers: {
            Authorization: `Bearer ${apiKeyPlaceholder}`,
          },
        },
      },
    });
    return {
      filename: "mcp.json",
      snippet,
      instructions: [
        "This is a reference shape (the \"url\" + \"headers\" convention several clients share), not a guaranteed exact match for every client — check your specific client's MCP docs for its precise field names.",
        apiKeyHint(apiKeyPlaceholder),
      ],
    };
  },
};

export const CONNECT_TEMPLATES: Record<ConnectClientId, ConnectTemplate> = {
  "claude-desktop": claudeDesktop,
  cursor,
  windsurf,
  continue: continueDev,
  "generic-json": genericJson,
};

export function isConnectClientId(value: string): value is ConnectClientId {
  return (CONNECT_CLIENT_IDS as readonly string[]).includes(value);
}

export function generateConnectSnippet(clientId: ConnectClientId, input: ConnectTemplateInput): ConnectTemplateOutput {
  return CONNECT_TEMPLATES[clientId].generate(input);
}

/**
 * Resolves the gateway URL a generated config should point at, given a base
 * gateway URL and the chosen connection target. Scope "client"/"bundle"
 * require `name` (the registered client name or bundle name); "aggregated"
 * ignores it.
 */
export function resolveGatewayEndpoint(baseUrl: string, scope: ConnectScope, name: string | undefined): string {
  const base = baseUrl.replace(/\/+$/, "");
  if (scope === "client") {
    if (!name) throw new Error("scope 'client' requires a client name");
    return `${base}/mcp/${encodeURIComponent(name)}`;
  }
  if (scope === "bundle") {
    if (!name) throw new Error("scope 'bundle' requires a bundle name");
    return `${base}/mcp-custom/${encodeURIComponent(name)}`;
  }
  return `${base}/mcp`;
}
