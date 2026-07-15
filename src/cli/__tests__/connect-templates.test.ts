/**
 * One-click MCP client connection config generator — pure template-generation
 * functions (src/cli/connect-templates.ts). Exact-shape assertions per client,
 * mirroring the format each client's own docs specify (see the source
 * comments in connect-templates.ts for what was verified where/when).
 */
import { describe, test, expect } from "bun:test";
import {
  CONNECT_TEMPLATES,
  isConnectClientId,
  generateConnectSnippet,
  resolveGatewayEndpoint,
} from "../../cli/connect-templates.js";

const PLACEHOLDER = "<YOUR_MCP_API_KEY>";
const URL = "https://gw.example.com/mcp/acme-crm";

describe("isConnectClientId", () => {
  test("accepts every registered client id", () => {
    for (const id of Object.keys(CONNECT_TEMPLATES)) {
      expect(isConnectClientId(id)).toBe(true);
    }
  });

  test("rejects an unknown id", () => {
    expect(isConnectClientId("vscode-copilot")).toBe(false);
    expect(isConnectClientId("")).toBe(false);
  });
});

describe("claude-desktop template", () => {
  test("generates an mcp-remote stdio-bridge entry with the header in env, not inline", () => {
    const out = generateConnectSnippet("claude-desktop", {
      name: "acme-crm",
      url: URL,
      transport: "streamable-http",
      apiKeyPlaceholder: PLACEHOLDER,
      scope: "client",
    });
    expect(out.filename).toBe("claude_desktop_config.json");
    expect(JSON.parse(out.snippet)).toEqual({
      mcpServers: {
        "acme-crm": {
          command: "npx",
          args: ["-y", "mcp-remote", URL, "--header", "Authorization:${AUTH_HEADER}"],
          env: { AUTH_HEADER: `Bearer ${PLACEHOLDER}` },
        },
      },
    });
    expect(out.instructions.some((i) => i.includes("claude_desktop_config.json"))).toBe(true);
    expect(out.instructions.some((i) => i.includes(PLACEHOLDER))).toBe(true);
  });
});

describe("cursor template", () => {
  test("generates a direct url+headers mcpServers entry", () => {
    const out = generateConnectSnippet("cursor", {
      name: "acme-crm",
      url: URL,
      transport: "streamable-http",
      apiKeyPlaceholder: PLACEHOLDER,
      scope: "client",
    });
    expect(out.filename).toBe("mcp.json");
    expect(JSON.parse(out.snippet)).toEqual({
      mcpServers: {
        "acme-crm": {
          url: URL,
          headers: { Authorization: `Bearer ${PLACEHOLDER}` },
        },
      },
    });
    expect(out.instructions.join(" ")).toContain(".cursor/mcp.json");
  });
});

describe("windsurf template", () => {
  test("uses serverUrl (not url) for the remote endpoint", () => {
    const out = generateConnectSnippet("windsurf", {
      name: "acme-crm",
      url: URL,
      transport: "streamable-http",
      apiKeyPlaceholder: PLACEHOLDER,
      scope: "client",
    });
    expect(out.filename).toBe("mcp_config.json");
    expect(JSON.parse(out.snippet)).toEqual({
      mcpServers: {
        "acme-crm": {
          serverUrl: URL,
          headers: { Authorization: `Bearer ${PLACEHOLDER}` },
        },
      },
    });
    expect(out.instructions.join(" ")).toContain("mcp_config.json");
  });
});

describe("continue template", () => {
  test("emits a YAML mcpServers ARRAY entry with type + requestOptions.headers", () => {
    const out = generateConnectSnippet("continue", {
      name: "acme-crm",
      url: URL,
      transport: "streamable-http",
      apiKeyPlaceholder: PLACEHOLDER,
      scope: "client",
    });
    expect(out.filename).toBe("config.yaml");
    expect(out.snippet).toBe(
      [
        "mcpServers:",
        "  - name: acme-crm",
        "    type: streamable-http",
        `    url: ${URL}`,
        "    requestOptions:",
        "      headers:",
        `        Authorization: "Bearer ${PLACEHOLDER}"`,
      ].join("\n"),
    );
  });

  test("reflects the sse transport in the type field when passed", () => {
    const out = generateConnectSnippet("continue", {
      name: "acme-crm",
      url: URL,
      transport: "sse",
      apiKeyPlaceholder: PLACEHOLDER,
      scope: "client",
    });
    expect(out.snippet).toContain("type: sse");
  });
});

describe("generic-json template", () => {
  test("includes an explicit transport field alongside url + headers", () => {
    const out = generateConnectSnippet("generic-json", {
      name: "acme-crm",
      url: URL,
      transport: "streamable-http",
      apiKeyPlaceholder: PLACEHOLDER,
      scope: "client",
    });
    expect(JSON.parse(out.snippet)).toEqual({
      mcpServers: {
        "acme-crm": {
          url: URL,
          transport: "streamable-http",
          headers: { Authorization: `Bearer ${PLACEHOLDER}` },
        },
      },
    });
  });
});

describe("every template", () => {
  test("never embeds a real-looking key — only the placeholder string appears", () => {
    for (const id of Object.keys(CONNECT_TEMPLATES) as (keyof typeof CONNECT_TEMPLATES)[]) {
      const out = generateConnectSnippet(id, {
        name: "acme-crm",
        url: URL,
        transport: "streamable-http",
        apiKeyPlaceholder: PLACEHOLDER,
        scope: "client",
      });
      expect(out.snippet).toContain(PLACEHOLDER);
    }
  });
});

describe("resolveGatewayEndpoint", () => {
  test("builds the sharded per-client endpoint", () => {
    expect(resolveGatewayEndpoint("https://gw.example.com", "client", "acme-crm")).toBe(
      "https://gw.example.com/mcp/acme-crm",
    );
  });

  test("builds the sharded per-bundle endpoint", () => {
    expect(resolveGatewayEndpoint("https://gw.example.com", "bundle", "support-tools")).toBe(
      "https://gw.example.com/mcp-custom/support-tools",
    );
  });

  test("builds the system control-plane endpoint, ignoring name", () => {
    expect(resolveGatewayEndpoint("https://gw.example.com", "system", undefined)).toBe("https://gw.example.com/mcp");
  });

  test("strips a trailing slash on the base URL", () => {
    expect(resolveGatewayEndpoint("https://gw.example.com/", "client", "acme-crm")).toBe(
      "https://gw.example.com/mcp/acme-crm",
    );
  });

  test("percent-encodes a name with special characters", () => {
    expect(resolveGatewayEndpoint("https://gw.example.com", "client", "acme/crm 2")).toBe(
      "https://gw.example.com/mcp/acme%2Fcrm%202",
    );
  });

  test("throws for scope 'client' with no name", () => {
    expect(() => resolveGatewayEndpoint("https://gw.example.com", "client", undefined)).toThrow();
  });

  test("throws for scope 'bundle' with no name", () => {
    expect(() => resolveGatewayEndpoint("https://gw.example.com", "bundle", undefined)).toThrow();
  });
});
