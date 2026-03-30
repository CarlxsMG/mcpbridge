import type { Request, Response, NextFunction } from "express";
import { config } from "../config.js";

export function corsMiddleware(req: Request, res: Response, next: NextFunction): void {
  const origin = req.headers.origin as string | undefined;
  if (origin && config.corsOrigins.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, mcp-session-id");
  }
  if (req.method === "OPTIONS") {
    res.sendStatus(204);
    return;
  }
  next();
}
