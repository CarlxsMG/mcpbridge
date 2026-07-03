import type { Request, Response, Express } from "express";
import { config } from "../config.js";
import { rateLimitInstallLink } from "../middleware/rate-limiter.js";
import { resolveInstallLinkToken } from "../bundle-install-links.js";
import { registry } from "../registry.js";
import { generateConnectSnippet, resolveGatewayEndpoint } from "../cli/connect-templates.js";
import { sendError } from "./http-errors.js";

/** Resolves the base gateway URL a generated snippet should point at, mirroring ConnectClientDialog's fallback order. */
function resolveGatewayBaseUrl(req: Request): string {
  if (config.gatewayPublicUrl) return config.gatewayPublicUrl;
  const host = req.get("host");
  return host ? `${req.protocol}://${host}` : `${req.protocol}://localhost`;
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
      const descriptions = new Map(registry.listAllTools().map((t) => [`${t.client}__${t.tool}`, t.description]));

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
      });

      res.status(200).json({
        bundle: {
          name: bundle.name,
          description: bundle.description,
          tools: bundle.tools.map((t) => ({
            client: t.client,
            tool: t.tool,
            description: descriptions.get(`${t.client}__${t.tool}`) ?? "",
          })),
        },
        connect,
      });
    },
  );
}
