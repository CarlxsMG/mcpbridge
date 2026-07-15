/**
 * One-click MCP client connection config generator — per-client template
 * registry, shared by the `gateway connect` CLI command
 * (src/cli/commands/connect.ts) and mirrored (admin-ui has zero shared deps
 * with the backend, see admin-ui/DESIGN_SYSTEM.md / repo conventions) at
 * admin-ui/src/utils/connectTemplates.ts for the "Connect client"
 * admin-UI dialog. Keep the two files in sync by hand — there is no build
 * step that shares code across the two packages.
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
 * /mcp-custom/:bundleName data endpoints, and the /mcp system control plane —
 * is Streamable HTTP only (see src/mcp/transports.ts's route mounts: none of
 * them have a per-scope SSE alternative; the legacy /sse+/messages pair was
 * removed entirely alongside the old "aggregated" data mode). So `transport`
 * below is always "streamable-http" in practice today; the field stays part
 * of the shared shape (rather than being dropped) because Continue's template
 * needs an explicit discriminator.
 */

export type ConnectTransport = "streamable-http" | "sse";

/** "system" points at the /mcp control plane (sys_* tools) — NOT a flattened view of every backend's tools; use "bundle" for that. */
export type ConnectScope = "client" | "bundle" | "system";

export const CONNECT_CLIENT_IDS = ["claude-desktop", "cursor", "windsurf", "continue", "generic-json"] as const;

export type ConnectClientId = (typeof CONNECT_CLIENT_IDS)[number];

export interface ConnectTemplateInput {
  /** mcpServers key / display name for this connection — the client or bundle name (or "gateway" for the system scope). */
  name: string;
  /** Fully-resolved gateway URL for the chosen scope, e.g. https://gw.example.com/mcp/acme-crm */
  url: string;
  transport: ConnectTransport;
  /** Always a placeholder like "<YOUR_MCP_API_KEY>" — callers must never pass a real key here. */
  apiKeyPlaceholder: string;
  /** Drives the wording of the generated apiKeyHint — a "system" key needs an adminRole, a plain data-plane key is rejected by /mcp (src/security/system-role.ts). */
  scope: ConnectScope;
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

/**
 * A "system" (scope="system") connection targets the fail-closed /mcp control
 * plane (src/security/system-role.ts's resolveSystemRole), which rejects a
 * plain data-plane key outright — it needs a managed key with `adminRole` set
 * (or the env admin Bearer). Every other scope just needs any active key, so
 * this branches on scope to avoid pointing a "system" caller at instructions
 * that produce a key /mcp will reject.
 */
function apiKeyHint(apiKeyPlaceholder: string, scope: ConnectScope): string {
  if (scope === "system") {
    return `Replace ${apiKeyPlaceholder} with an MCP API key that has a system role (admin/operator/auditor/viewer) — mint one under "API keys" in the admin UI and set its "System role" field, or use the gateway's env admin Bearer key instead. A plain data-plane key has no system role and is rejected by /mcp.`;
  }
  return `Replace ${apiKeyPlaceholder} with a real MCP API key — create one first under "API keys" in the admin UI if you don't have one yet.`;
}

const claudeDesktop: ConnectTemplate = {
  id: "claude-desktop",
  label: "Claude Desktop",
  generate({ name, url, apiKeyPlaceholder, scope }) {
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
        apiKeyHint(apiKeyPlaceholder, scope),
        "Completely quit and restart Claude Desktop (not just close the window) for the new server to load.",
      ],
    };
  },
};

const cursor: ConnectTemplate = {
  id: "cursor",
  label: "Cursor",
  generate({ name, url, apiKeyPlaceholder, scope }) {
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
        apiKeyHint(apiKeyPlaceholder, scope),
        "Cursor picks up mcp.json changes automatically — reopen the MCP settings panel to confirm it connected.",
      ],
    };
  },
};

const windsurf: ConnectTemplate = {
  id: "windsurf",
  label: "Windsurf",
  generate({ name, url, apiKeyPlaceholder, scope }) {
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
        apiKeyHint(apiKeyPlaceholder, scope),
        "Click the refresh icon in Cascade's MCP panel (or restart Windsurf) to load the new server.",
      ],
    };
  },
};

const continueDev: ConnectTemplate = {
  id: "continue",
  label: "Continue",
  generate({ name, url, transport, apiKeyPlaceholder, scope }) {
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
        apiKeyHint(apiKeyPlaceholder, scope),
        "Continue reloads config.yaml automatically — check the MCP Servers panel to confirm it connected.",
      ],
    };
  },
};

const genericJson: ConnectTemplate = {
  id: "generic-json",
  label: "Generic (url + headers)",
  generate({ name, url, transport, apiKeyPlaceholder, scope }) {
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
        'This is a reference shape (the "url" + "headers" convention several clients share), not a guaranteed exact match for every client — check your specific client\'s MCP docs for its precise field names.',
        apiKeyHint(apiKeyPlaceholder, scope),
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
 * require `name` (the registered client name or bundle name); "system"
 * ignores it and always resolves to the /mcp control plane.
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
