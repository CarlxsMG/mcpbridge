import type { Request, Response, NextFunction } from "express";
import { createHash, timingSafeEqual } from "node:crypto";
import { config } from "../config.js";

function safeCompare(a: string, b: string): boolean {
  try {
    const ha = createHash("sha256").update(a, "utf8").digest();
    const hb = createHash("sha256").update(b, "utf8").digest();
    return timingSafeEqual(ha, hb);
  } catch {
    return false;
  }
}

function extractBearerToken(req: Request): string | null {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) return null;
  return header.slice(7).trim();
}

export function adminAuth(req: Request, res: Response, next: NextFunction): void {
  if (config.authDisabled) { next(); return; }
  const token = extractBearerToken(req);
  if (!token) {
    res.status(401).json({ error: { code: "UNAUTHORIZED", message: "Missing Authorization header" } });
    return;
  }
  if (!config.adminApiKeys.some(key => safeCompare(key, token))) {
    res.status(403).json({ error: { code: "FORBIDDEN", message: "Invalid API key" } });
    return;
  }
  next();
}

export function mcpAuth(req: Request, res: Response, next: NextFunction): void {
  if (config.authDisabled) { next(); return; }
  // If no MCP API keys configured, allow all (backward compat)
  if (config.mcpApiKeys.length === 0) { next(); return; }
  const token = extractBearerToken(req);
  if (!token) {
    res.status(401).json({ error: { code: "UNAUTHORIZED", message: "Missing Authorization header" } });
    return;
  }
  if (!config.mcpApiKeys.some(key => safeCompare(key, token))) {
    res.status(403).json({ error: { code: "FORBIDDEN", message: "Invalid API key" } });
    return;
  }
  next();
}
