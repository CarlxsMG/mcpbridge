import { Router, type Request, type Response } from "express";
import { config } from "../../config.js";

/**
 * GET /connect/gateway-url — read-only helper that prefills the admin UI's
 * "Connect client" dialog (and `gateway connect` CLI) with the operator-
 * declared public gateway URL. Both surfaces still let the caller override
 * the suggestion — multi-host / dev setups where the admin UI's own origin
 * isn't the gateway's externally-reachable URL.
 */
export const connectRoutes = Router();

connectRoutes.get("/connect/gateway-url", (_req: Request, res: Response) => {
  res.status(200).json({ publicUrl: config.gatewayPublicUrl ?? null });
});
