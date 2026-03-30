import type { Request, Response, Express } from "express";
import { registry } from "../registry.js";
import { adminAuth } from "../middleware/auth.js";
import { notifyToolsChanged } from "../mcp-server.js";
import { removeCircuitBreaker } from "../circuit-breaker.js";
import { abortClientRequests } from "../proxy.js";
import { log } from "../logger.js";

export function introspectionRoutes(app: Express): void {
  // List all registered clients
  app.get("/clients", adminAuth, (_req: Request, res: Response) => {
    const clients = registry.getAllClients().map((c) => ({
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
      res.status(404).json({ error: { code: "CLIENT_NOT_FOUND", message: "Client not found" } });
      return;
    }
    res.json({ tools });
  });

  // Unregister a client
  app.delete("/clients/:name", adminAuth, (req: Request<{ name: string }>, res: Response) => {
    const removed = registry.unregister(req.params.name);
    if (!removed) {
      res.status(404).json({ error: { code: "CLIENT_NOT_FOUND", message: "Client not found" } });
      return;
    }
    abortClientRequests(req.params.name);
    removeCircuitBreaker(req.params.name);
    notifyToolsChanged();
    log("info", "Client unregistered", { name: req.params.name });
    res.json({ status: "unregistered", name: req.params.name });
  });
}
