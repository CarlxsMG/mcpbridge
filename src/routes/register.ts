import type { Request, Response, Express } from "express";
import { registry } from "../registry.js";
import { notifyToolsChanged } from "../mcp-server.js";

export function registerRoutes(app: Express): void {
  app.post("/register", (req: Request, res: Response) => {
    const { name, tools, health_url } = req.body;

    // Validate required fields
    if (!name || !Array.isArray(tools) || !health_url) {
      res.status(400).json({ error: "Missing required fields: name, tools, health_url" });
      return;
    }

    // Extract IP from request
    const ip = req.ip || req.socket?.remoteAddress || "127.0.0.1";

    // Resolve health_url — if it starts with http, use as-is; otherwise prepend http://ip
    const resolvedHealthUrl = health_url.startsWith("http")
      ? health_url
      : `http://${ip}${health_url.startsWith("/") ? "" : "/"}${health_url}`;

    try {
      registry.register(name, tools, resolvedHealthUrl, ip);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(400).json({ error: message });
      return;
    }

    // Notify all connected MCP clients that tools changed
    notifyToolsChanged();

    res.status(200).json({
      status: "registered",
      name,
      tools_count: tools.length,
    });
  });
}
