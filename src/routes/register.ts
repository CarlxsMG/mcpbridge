import type { Request, Response, Express } from "express";
import { config } from "../config.js";
import { adminAuth } from "../middleware/auth.js";
import { requireOperator } from "../middleware/authz.js";
import { rateLimitRegister } from "../middleware/rate-limiter.js";
import { validationError, bodyOf, sendError, requestId as getRequestId } from "./http-errors.js";
import {
  performRestRegistration,
  performMcpRegistration,
  performGraphqlRegistration,
  resolvedRegistrationSchema,
  type RegisterOutcome,
} from "../mcp/registration.js";

export function registerRoutes(app: Express): void {
  app.post(
    "/register",
    adminAuth,
    requireOperator,
    rateLimitRegister(config.rateLimitRegister),
    async (req: Request, res: Response) => {
      const requestId = getRequestId(res);

      // Change A — guard against non-object bodies ([], "string", null, etc.)
      if (req.body === null || typeof req.body !== "object" || Array.isArray(req.body)) {
        return validationError(res, "Request body must be a JSON object");
      }
      const b = bodyOf(req);

      // Change B — cap tools[] length before any other processing
      if (Array.isArray(b.tools) && (b.tools as unknown[]).length > config.maxToolsPerClient) {
        return validationError(res, `tools[] exceeds maximum of ${config.maxToolsPerClient}`);
      }

      const peerIp = req.socket?.remoteAddress;

      // MCP-upstream and GraphQL registration each take a distinct shape from
      // plain REST/OpenAPI; same adminAuth + SSRF posture as REST in all cases.
      let outcome: RegisterOutcome;
      if (b.kind === "mcp" || typeof b.mcp_url === "string") {
        outcome = await performMcpRegistration(b, peerIp, requestId);
      } else if (b.kind === "graphql" || typeof b.graphql_url === "string") {
        outcome = await performGraphqlRegistration(b, peerIp, requestId);
      } else {
        outcome = await performRestRegistration(b, peerIp, requestId);
      }

      res.status(outcome.status).json(outcome.body);
    },
  );

  app.get("/register/schema", adminAuth, (_req: Request, res: Response) => {
    if (!resolvedRegistrationSchema) {
      sendError(res, 503, "SCHEMA_UNAVAILABLE", "Schema could not be loaded");
      return;
    }
    res.setHeader("Content-Type", "application/schema+json");
    res.json(resolvedRegistrationSchema);
  });
}
