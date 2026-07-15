/**
 * Stryker mutation-testing backstop for src/cli/connect-templates.ts.
 *
 * The hand-written sibling `connect-templates.test.ts` already covers the
 * shape of every generated snippet (via JSON.parse/toEqual/toContain) and the
 * happy/throw paths of resolveGatewayEndpoint — leave that file untouched.
 * This file only gap-fills what a baseline Stryker run showed it doesn't
 * kill:
 *
 *   - Each template's own `id`/`label` string literals (never asserted on
 *     directly by the sibling file, which only exercises `generate()`).
 *   - generic-json's `filename` (every other template's filename is checked,
 *     this one wasn't).
 *   - The FULL `instructions` array for every template, verbatim. The
 *     sibling file only spot-checks individual lines via `.some(...)` /
 *     `.join(...).toContain(...)`, which can't catch a StringLiteral mutant
 *     on an untouched line, nor an ArrayDeclaration mutant that empties the
 *     whole array (a `.some()` over `[]` is vacuously false and would still
 *     fail loudly on the OTHER checks the sibling file makes, but continue's
 *     and generic-json's instructions arrays have lines nothing else in the
 *     sibling file inspects at all).
 *   - resolveGatewayEndpoint's two thrown error messages, exactly (the
 *     sibling file only asserts `.toThrow()` with no argument).
 *   - resolveGatewayEndpoint's trailing-slash regex against MULTIPLE
 *     trailing slashes, which distinguishes `/\/+$/` from a `/\/$/` or
 *     `/\/?$/` mutant (a single trailing slash can't).
 */
import { describe, test, expect } from "bun:test";
import {
  CONNECT_CLIENT_IDS,
  CONNECT_TEMPLATES,
  generateConnectSnippet,
  resolveGatewayEndpoint,
  type ConnectClientId,
} from "../connect-templates.js";

const PLACEHOLDER = "<YOUR_MCP_API_KEY>";
const URL = "https://gw.example.com/mcp/acme-crm";
const NAME = "acme-crm";

const apiKeyHintLine = `Replace ${PLACEHOLDER} with a real MCP API key — create one first under "API keys" in the admin UI if you don't have one yet.`;

function generate(id: ConnectClientId, transport: "streamable-http" | "sse" = "streamable-http") {
  return generateConnectSnippet(id, {
    name: NAME,
    url: URL,
    transport,
    apiKeyPlaceholder: PLACEHOLDER,
    scope: "client",
  });
}

describe("CONNECT_TEMPLATES — id/label literals", () => {
  const expected: Record<ConnectClientId, string> = {
    "claude-desktop": "Claude Desktop",
    cursor: "Cursor",
    windsurf: "Windsurf",
    continue: "Continue",
    "generic-json": "Generic (url + headers)",
  };

  for (const id of CONNECT_CLIENT_IDS) {
    test(`${id} template carries its own id and label verbatim`, () => {
      const tmpl = CONNECT_TEMPLATES[id];
      expect(tmpl.id).toBe(id);
      expect(tmpl.label).toBe(expected[id]);
    });
  }
});

describe("claude-desktop template — full instructions text", () => {
  test("matches every instruction line verbatim", () => {
    const out = generate("claude-desktop");
    expect(out.instructions).toEqual([
      "Open (or create) claude_desktop_config.json — macOS: ~/Library/Application Support/Claude/claude_desktop_config.json · Windows: %APPDATA%\\Claude\\claude_desktop_config.json",
      `Merge the snippet below into its top-level "mcpServers" object (add that key if the file is new/empty).`,
      apiKeyHintLine,
      "Completely quit and restart Claude Desktop (not just close the window) for the new server to load.",
    ]);
  });
});

describe("cursor template — full instructions text", () => {
  test("matches every instruction line verbatim", () => {
    const out = generate("cursor");
    expect(out.instructions).toEqual([
      "Save as .cursor/mcp.json in this project, or ~/.cursor/mcp.json to make it available in every project.",
      apiKeyHintLine,
      "Cursor picks up mcp.json changes automatically — reopen the MCP settings panel to confirm it connected.",
    ]);
  });
});

describe("windsurf template — full instructions text", () => {
  test("matches every instruction line verbatim", () => {
    const out = generate("windsurf");
    expect(out.instructions).toEqual([
      "Save as ~/.codeium/windsurf/mcp_config.json (Cascade's MCP panel > Configure also opens this file for you).",
      apiKeyHintLine,
      "Click the refresh icon in Cascade's MCP panel (or restart Windsurf) to load the new server.",
    ]);
  });
});

describe("continue template — full instructions text", () => {
  test("matches every instruction line verbatim", () => {
    const out = generate("continue");
    expect(out.instructions).toEqual([
      "Save under .continue/config.yaml in this workspace, or ~/.continue/config.yaml to make it available everywhere.",
      "If the file already has a top-level mcpServers: list, append this entry to it rather than duplicating the key.",
      apiKeyHintLine,
      "Continue reloads config.yaml automatically — check the MCP Servers panel to confirm it connected.",
    ]);
  });
});

describe("generic-json template — filename and full instructions text", () => {
  test("uses mcp.json as its suggested filename", () => {
    const out = generate("generic-json");
    expect(out.filename).toBe("mcp.json");
  });

  test("matches every instruction line verbatim", () => {
    const out = generate("generic-json");
    expect(out.instructions).toEqual([
      'This is a reference shape (the "url" + "headers" convention several clients share), not a guaranteed exact match for every client — check your specific client\'s MCP docs for its precise field names.',
      apiKeyHintLine,
    ]);
  });
});

describe("resolveGatewayEndpoint — exact error messages", () => {
  test("scope 'client' with no name throws the exact, specific message", () => {
    expect(() => resolveGatewayEndpoint("https://gw.example.com", "client", undefined)).toThrow(
      "scope 'client' requires a client name",
    );
  });

  test("scope 'bundle' with no name throws the exact, specific message", () => {
    expect(() => resolveGatewayEndpoint("https://gw.example.com", "bundle", undefined)).toThrow(
      "scope 'bundle' requires a bundle name",
    );
  });

  test("the two scopes' error messages are distinct from each other", () => {
    let clientMessage = "";
    let bundleMessage = "";
    try {
      resolveGatewayEndpoint("https://gw.example.com", "client", undefined);
    } catch (err) {
      clientMessage = (err as Error).message;
    }
    try {
      resolveGatewayEndpoint("https://gw.example.com", "bundle", undefined);
    } catch (err) {
      bundleMessage = (err as Error).message;
    }
    expect(clientMessage).not.toBe("");
    expect(bundleMessage).not.toBe("");
    expect(clientMessage).not.toBe(bundleMessage);
  });
});

describe("resolveGatewayEndpoint — trailing-slash stripping regex", () => {
  test("strips MULTIPLE consecutive trailing slashes down to none, not just one", () => {
    expect(resolveGatewayEndpoint("https://gw.example.com///", "system", undefined)).toBe("https://gw.example.com/mcp");
  });

  test("strips multiple trailing slashes for the client scope too", () => {
    expect(resolveGatewayEndpoint("https://gw.example.com//", "client", "acme-crm")).toBe(
      "https://gw.example.com/mcp/acme-crm",
    );
  });
});
