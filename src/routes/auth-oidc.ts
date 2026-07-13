/**
 * SSO login for the admin UI: OIDC Authorization Code + PKCE.
 *
 * Three PUBLIC, pre-session endpoints (no adminAuth — a browser hitting these
 * has no session cookie yet by definition) plus a superadmin-gated settings
 * pair, matching the same requireSuperAdmin convention as teams/config
 * routes. All OIDC-specific logic (discovery, PKCE, token exchange, ID-token
 * verification, state store, auto-provisioning) lives in
 * src/security/oidc.ts — this file is just the HTTP wiring.
 */
import type { Request, Response, Express } from "express";
import { adminAuth } from "../middleware/auth.js";
import { requireSuperAdmin } from "../middleware/authz.js";
import { setSessionCookies } from "./auth.js";
import { createSession } from "../security/session-store.js";
import { touchLastLogin } from "../security/user-store.js";
import { getSecretsProvider } from "../secrets/index.js";
import { recordAudit, actorFromRequest } from "../admin/audit/audit.js";
import { log } from "../logger.js";
import { sendError, validationError, requestId, bodyOf } from "./http-errors.js";
import {
  getOidcPublicConfig,
  getOidcSettings,
  getOidcConfigInternal,
  setOidcConfig,
  generatePkcePair,
  discoverOidcIssuer,
  createOidcAuthState,
  consumeOidcAuthState,
  exchangeAuthorizationCode,
  verifyIdToken,
  findOrProvisionSsoUser,
} from "../security/oidc.js";
import { errorMessage } from "../lib/error-message.js";

/** Redirects the browser back to the SPA's login page with a machine-readable (never sensitive) error hint. */
function redirectToLoginWithError(res: Response, reason: string): void {
  res.redirect(302, `/admin/login?sso_error=${encodeURIComponent(reason)}`);
}

export function authOidcRoutes(app: Express): void {
  // PUBLIC — the login page needs to know whether to render an SSO button
  // before any session exists. Deliberately returns nothing beyond `enabled`.
  app.get("/admin-api/auth/oidc/config", (_req: Request, res: Response) => {
    res.status(200).json(getOidcPublicConfig());
  });

  // PUBLIC — a browser navigates here directly (full-page, not fetch/XHR).
  app.get("/admin-api/auth/oidc/start", async (_req: Request, res: Response) => {
    const cfg = getOidcConfigInternal();
    if (!cfg || !cfg.enabled) {
      sendError(res, 404, "SSO_NOT_CONFIGURED", "SSO is not enabled");
      return;
    }

    let discovery;
    try {
      discovery = await discoverOidcIssuer(cfg.issuer);
    } catch (err) {
      log("warn", "OIDC discovery failed", { error: errorMessage(err) });
      sendError(res, 502, "SSO_DISCOVERY_FAILED", "Could not reach the identity provider");
      return;
    }

    const { codeVerifier, codeChallenge } = await generatePkcePair();
    const state = createOidcAuthState(codeVerifier);

    const url = new URL(discovery.authorization_endpoint);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", cfg.clientId);
    url.searchParams.set("redirect_uri", cfg.redirectUri);
    url.searchParams.set("scope", cfg.scopes);
    url.searchParams.set("state", state);
    url.searchParams.set("code_challenge", codeChallenge);
    url.searchParams.set("code_challenge_method", "S256");
    res.redirect(302, url.toString());
  });

  // PUBLIC — the IdP redirects the browser here after the user authenticates.
  app.get("/admin-api/auth/oidc/callback", async (req: Request, res: Response) => {
    const query = req.query as Record<string, unknown>;
    const idpError = typeof query.error === "string" ? query.error : null;
    const state = typeof query.state === "string" ? query.state : null;
    const code = typeof query.code === "string" ? query.code : null;

    if (idpError) {
      redirectToLoginWithError(res, "idp_denied");
      return;
    }
    if (!state || !code) {
      redirectToLoginWithError(res, "missing_parameters");
      return;
    }

    // Single-use, TTL'd, server-side lookup — never trust an unsigned cookie
    // for this. Missing/expired/already-consumed all fail identically.
    const codeVerifier = consumeOidcAuthState(state);
    if (!codeVerifier) {
      redirectToLoginWithError(res, "invalid_state");
      return;
    }

    const cfg = getOidcConfigInternal();
    if (!cfg || !cfg.enabled) {
      redirectToLoginWithError(res, "not_configured");
      return;
    }

    let discovery;
    try {
      discovery = await discoverOidcIssuer(cfg.issuer);
    } catch (err) {
      log("warn", "OIDC discovery failed during callback", { error: errorMessage(err) });
      redirectToLoginWithError(res, "discovery_failed");
      return;
    }

    let clientSecret: string;
    try {
      clientSecret = await getSecretsProvider().decryptSecret(cfg.clientSecretRef);
    } catch (err) {
      log("error", "OIDC client secret decryption failed", { error: errorMessage(err) });
      redirectToLoginWithError(res, "server_error");
      return;
    }

    let tokens;
    try {
      tokens = await exchangeAuthorizationCode(discovery.token_endpoint, {
        code,
        redirectUri: cfg.redirectUri,
        clientId: cfg.clientId,
        clientSecret,
        codeVerifier,
      });
    } catch (err) {
      log("warn", "OIDC token exchange failed", { error: errorMessage(err) });
      redirectToLoginWithError(res, "token_exchange_failed");
      return;
    }

    if (!tokens.id_token) {
      redirectToLoginWithError(res, "missing_id_token");
      return;
    }

    const verdict = await verifyIdToken(tokens.id_token, {
      issuer: cfg.issuer,
      audience: cfg.clientId,
      jwksUri: discovery.jwks_uri,
    });
    if (!verdict.valid) {
      log("warn", "OIDC id_token verification failed", { reason: verdict.reason });
      redirectToLoginWithError(res, "invalid_token");
      return;
    }

    const subject = typeof verdict.claims.sub === "string" ? verdict.claims.sub : null;
    if (!subject) {
      redirectToLoginWithError(res, "missing_subject");
      return;
    }

    const user = await findOrProvisionSsoUser("oidc", subject, verdict.claims);
    if (!user.isActive) {
      redirectToLoginWithError(res, "account_disabled");
      return;
    }

    const session = createSession(user.id, req.socket?.remoteAddress, req.headers["user-agent"]);
    touchLastLogin(user.id);
    setSessionCookies(res, session.token, session.csrfToken, session.expiresAt);

    log("info", "SSO login succeeded", { username: user.username });
    res.redirect(302, "/admin/servers");
  });

  // Superadmin-only settings — same gating convention as /admin-api/teams.
  app.get("/admin-api/auth/oidc/settings", adminAuth, requireSuperAdmin, (_req: Request, res: Response) => {
    res.status(200).json({ settings: getOidcSettings() });
  });

  app.put("/admin-api/auth/oidc/settings", adminAuth, requireSuperAdmin, async (req: Request, res: Response) => {
    const body = bodyOf(req);
    const issuer = typeof body.issuer === "string" ? body.issuer : "";
    const clientId = typeof body.clientId === "string" ? body.clientId : "";
    const clientSecret = typeof body.clientSecret === "string" ? body.clientSecret : "";
    const redirectUri = typeof body.redirectUri === "string" ? body.redirectUri : "";
    const scopes = typeof body.scopes === "string" && body.scopes.trim() ? body.scopes : "openid profile email";
    const enabled = body.enabled === true;

    const result = await setOidcConfig({ issuer, clientId, clientSecret, redirectUri, scopes, enabled });
    if (!result.ok) {
      if (result.error === "SECRETS_PROVIDER_UNCONFIGURED") {
        sendError(
          res,
          409,
          "SECRETS_PROVIDER_UNCONFIGURED",
          "Configure a secrets provider (SECRET_ENCRYPTION_KEY or Vault) before enabling SSO",
        );
        return;
      }
      if (result.error === "SECRETS_PROVIDER_ERROR") {
        sendError(res, 502, "SECRETS_PROVIDER_ERROR", result.reason);
        return;
      }
      validationError(res, result.reason);
      return;
    }

    recordAudit(actorFromRequest(req), "oidc.config.update", "oidc:config", { issuer, clientId, enabled });
    log("info", "OIDC SSO config updated", { actor: actorFromRequest(req), enabled, request_id: requestId(res) });
    res.status(200).json({ status: "updated" });
  });
}
