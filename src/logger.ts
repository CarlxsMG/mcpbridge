import { config } from "./config.js";

type LogLevel = "info" | "warn" | "error";

export function log(level: LogLevel, message: string, meta?: Record<string, unknown>): void {
  if (config.logFormat === "json") {
    const entry = { timestamp: new Date().toISOString(), level, message, ...meta };
    console[level === "error" ? "error" : "log"](JSON.stringify(entry));
  } else {
    const prefix = `[${new Date().toISOString()}] [${level.toUpperCase()}]`;
    const metaStr = meta ? " " + JSON.stringify(meta) : "";
    console[level === "error" ? "error" : "log"](`${prefix} ${message}${metaStr}`);
  }
}
