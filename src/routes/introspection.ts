import type { Request, Response, Express } from "express";
import { registry } from "../mcp/registry.js";
import { adminAuth } from "../middleware/auth.js";
import { requireOperator, ensureClientAccess, canCallerAccessClient } from "../middleware/authz.js";
import { log } from "../logger.js";
import { notFound } from "./http-errors.js";

export function introspectionRoutes(app: Express): void {
  // List all registered clients — team-scoped, like GET /admin-api/clients: a
  // team-bound session only sees its own clients (a super-admin/bearer sees all),
  // so another tenant's backends (name, internal IP, health_url) don't leak.
  app.get("/clients", adminAuth, (req: Request, res: Response) => {
    const clients = registry
      .listClients()
      .filter((c) => canCallerAccessClient(req, c.name))
      .map((c) => ({
        name: c.name,
        ip: c.ip,
        status: c.status,
        tools_count: c.tools.length,
        health_url: c.health_url,
      }));
    res.json({ clients });
  });

  // List tools for a specific client — scoped the same way the sibling DELETE is,
  // so a scoped caller can't dump another tenant's tool schemas (or probe existence).
  app.get("/clients/:name/tools", adminAuth, (req: Request<{ name: string }>, res: Response) => {
    if (!ensureClientAccess(req, res, req.params.name)) return;
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
