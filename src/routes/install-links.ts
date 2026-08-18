import type { Request, Response, Express } from "express";
import { config } from "../config.js";
import { getDb } from "../db/connection.js";
import { rateLimitInstallLink } from "../middleware/rate-limiter.js";
import { resolveInstallLinkToken } from "../admin/tool-composition/bundle-install-links.js";
import type { BundleToolRef } from "../admin/tool-composition/bundles.js";
import { generateConnectSnippet, resolveGatewayEndpoint } from "../cli/connect-templates.js";
import { sendError } from "./http-errors.js";

/** Resolves the base gateway URL a generated snippet should point at, mirroring ConnectClientDialog's fallback order. */
function resolveGatewayBaseUrl(req: Request): string {
  if (config.gatewayPublicUrl) return config.gatewayPublicUrl;
  const host = req.get("host");
  return host ? `${req.protocol}://${host}` : `${req.protocol}://localhost`;
}

/** One `{client, tool, description}` triple per tool the bundle names, in the bundle's own order. */
interface InstallLinkTool {
  client: string;
  tool: string;
  description: string;
}

/**
 * Describes exactly the tools a bundle names — nothing else in the catalog.
 *
 * Deliberately NOT `registry.listAllTools()`, which this replaced: that read
 * model reads every row of `tools` plus every tool tag in the deployment in
 * order to describe a handful of them. This route is public and has no
 * `adminAuth`, so the work it does per request must not scale with the size of
 * the catalog. `tools` is keyed `PRIMARY KEY (client_name, name)`, so one
 * lookup per bundle entry is an index seek and the cost is proportional to the
 * bundle.
 *
 * Reading `tools.description` from SQLite rather than from the in-memory
 * registry is what keeps the answer identical to the broad read model: a
 * bundle may legitimately name a tool whose client is not currently live
 * (bundles.ts validates membership by existence, not by liveness), and the
 * live client map holds no entry for such a client.
 *
 * Not memoised, on purpose. A cache would need a per-team key and an
 * invalidation signal on description edits that `notifyToolsChanged` does not
 * emit — a stale tenancy-scoped read is a far worse failure than an index
 * seek per bundle entry.
 */
function describeBundleTools(tools: BundleToolRef[]): InstallLinkTool[] {
  const lookup = getDb().query(`SELECT description FROM tools WHERE client_name = ? AND name = ?`);
  return tools.map((t) => {
    const row = lookup.get(t.client, t.tool) as { description: string } | null;
    // The `""` fallback is unreachable for a real bundle entry — mcp_bundle_tools
    // FK-references tools(client_name, name) ON DELETE CASCADE with foreign keys
    // ON — and is kept so a future schema change degrades to a blank description
    // instead of throwing on a public route.
    return { client: t.client, tool: t.tool, description: row?.description ?? "" };
  });
}

/**
 * Public (no adminAuth), rate-limited "install this bundle" page — the whole
 * point is that a teammate can open this link and get a working connection
 * config without ever touching the admin UI's login flow.
 */
export function installLinkRoutes(app: Express): void {
  app.get(
    "/install/:token",
    rateLimitInstallLink(config.rateLimitInstallLink),
    async (req: Request<{ token: string }>, res: Response) => {
      const resolved = await resolveInstallLinkToken(req.params.token);
      if (!resolved) {
        // Deliberately identical for "unknown token", "revoked", and "expired" —
        // never let a caller distinguish those states (see resolveInstallLinkToken's contract).
        sendError(res, 404, "INSTALL_LINK_NOT_FOUND", "This install link is invalid or no longer available");
        return;
      }

      const { bundle, mcpApiKey } = resolved;
      const gatewayBase = resolveGatewayBaseUrl(req);
      const url = resolveGatewayEndpoint(gatewayBase, "bundle", bundle.name);
      // Intentional, sole exception to connect-templates.ts's "apiKeyPlaceholder is
      // always a placeholder, never a real key" contract: this route's whole reason
      // to exist is a copy-paste-ready snippet with no manual substitution step, and
      // `mcpApiKey` here is never a human admin's personal key — it's a fresh key
      // minted at install-link-creation time, scoped ONLY to this bundle's tools,
      // and revoked the moment this link is revoked (see bundle-install-links.ts).
      const connect = generateConnectSnippet("generic-json", {
        name: bundle.name,
        url,
        transport: "streamable-http",
        apiKeyPlaceholder: mcpApiKey,
        scope: "bundle",
      });

      res.status(200).json({
        bundle: {
          name: bundle.name,
          description: bundle.description,
          tools: describeBundleTools(bundle.tools),
        },
        connect,
      });
    },
  );
}
