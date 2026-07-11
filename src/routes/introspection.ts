import type { Request, Response, Express } from "express";
import { registry } from "../mcp/registry.js";
import { adminAuth } from "../middleware/auth.js";
import { requireOperator, ensureClientAccess } from "../middleware/authz.js";
import { log } from "../logger.js";
import { notFound } from "./http-errors.js";

export function introspectionRoutes(app: Express): void {
  // List all registered clients
  app.get("/clients", adminAuth, (_req: Request, res: Response) => {
    const clients = registry.listClients().map((c) => ({
      name: c.name,
      ip: c.ip,
      status: c.status,
      tools_count: c.tools.length,
      health_url: c.health_url,
    }));
    res.json({ clients });
  });

  // List tools for a specific client
  app.get("/clients/:name/tools", adminAuth, (req: Request<{ name: string }>, res: Response) => {
    const tools = registry.getClientTools(req.params.name);
    if (!tools) {
      notFound(res, "CLIENT_NOT_FOUND", "Client not found");
      return;
    }
    res.json({ tools });
  });

  // Unregister a client — registry.unregister() handles abort, circuit-breaker
  // cleanup, toolIndex cleanup, and notifyToolsChanged internally.
  app.delete("/clients/:name", adminAuth, requireOperator, async (req: Request<{ name: string }>, res: Response) => {
    if (!ensureClientAccess(req, res, req.params.name)) return;
    const removed = await registry.unregister(req.params.name);
    if (!removed) {
      notFound(res, "CLIENT_NOT_FOUND", "Client not found");
      return;
    }
    log("info", "Client unregistered", { name: req.params.name });
    res.json({ status: "unregistered", name: req.params.name });
  });
}
