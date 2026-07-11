import { Router, type Request, type Response } from "express";
import { getClientOAuth, setClientOAuth, type OAuthError } from "../../backend-auth/oauth.js";
import { ensureClientAccess, requireOperator } from "../../middleware/authz.js";
import { sendError, validationError, bodyOf } from "../http-errors.js";
import { mutationErrorToStatus } from "../validation.js";
import { actorFromRequest, recordAudit } from "../../admin/audit/audit.js";

/**
 * Outbound OAuth2 client-credentials config, per upstream client.
 * When configured, the bridge mints a short-lived access token from the
 * upstream's token endpoint and injects it as `Authorization: Bearer …`
 * on every call to that backend — the calling MCP client never sees the
 * upstream's client secret.
 *
 * Per-client storage is encrypted through the configured secrets
 * provider (local AES-GCM or HashiCorp Vault). Storing clientSecret
 * plaintext is impossible by construction.
 */

/** SECRETS_PROVIDER_ERROR → 502 (external KMS/secrets-manager dependency failure), not a client input error. */
const OAUTH_ERROR_STATUS: Record<OAuthError, number> = {
  CLIENT_NOT_FOUND: 404,
  SECRETS_PROVIDER_ERROR: 502,
  SECRET_BOX_UNCONFIGURED: 400,
  INVALID_URL: 400,
};

export const oauthRoutes = Router();

oauthRoutes.get("/clients/:name/oauth", (req: Request<{ name: string }>, res: Response) => {
  if (!ensureClientAccess(req, res, req.params.name)) return;
  res.status(200).json({ oauth: getClientOAuth(req.params.name) });
});

oauthRoutes.put("/clients/:name/oauth", requireOperator, async (req: Request<{ name: string }>, res: Response) => {
  const { name } = req.params;
  if (!ensureClientAccess(req, res, name)) return;
  const body = bodyOf(req);
  let input: { tokenUrl: string; clientId: string; clientSecret: string; scope?: string } | null;
  if (body.oauth === null) {
    input = null;
  } else {
    const tokenUrl = typeof body.tokenUrl === "string" ? body.tokenUrl : "";
    const clientId = typeof body.clientId === "string" ? body.clientId : "";
    const clientSecret = typeof body.clientSecret === "string" ? body.clientSecret : "";
    if (!tokenUrl || !clientId || !clientSecret) {
      validationError(res, "tokenUrl, clientId, and clientSecret are required (or send { oauth: null } to clear)");
      return;
    }
    input = { tokenUrl, clientId, clientSecret, scope: typeof body.scope === "string" ? body.scope : undefined };
  }
  const result = await setClientOAuth(name, input);
  if (!result.ok) {
    sendError(
      res,
      mutationErrorToStatus(result.error, OAUTH_ERROR_STATUS),
      result.error,
      result.reason ?? result.error,
    );
    return;
  }
  recordAudit(actorFromRequest(req), input ? "client.oauth.set" : "client.oauth.clear", name);
  res.status(200).json({ status: "updated", name });
});
