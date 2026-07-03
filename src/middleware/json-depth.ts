import type { Request, Response, NextFunction } from "express";
import { config } from "../config.js";

/**
 * Iterative BFS depth checker for a parsed JSON value.
 * Returns true when the maximum nesting depth exceeds `maxDepth`.
 * Uses a queue (not recursion) so a deeply-nested payload cannot exhaust the call stack.
 */
function exceedsDepth(root: unknown, maxDepth: number): boolean {
  if (root === null || typeof root !== "object") return false;

  const queue: Array<{ node: object; depth: number }> = [{ node: root as object, depth: 0 }];

  while (queue.length > 0) {
    const { node, depth } = queue.shift()!;
    if (depth > maxDepth) return true;

    const values = Array.isArray(node) ? (node as unknown[]) : Object.values(node as Record<string, unknown>);

    for (const child of values) {
      if (child !== null && typeof child === "object") {
        queue.push({ node: child as object, depth: depth + 1 });
      }
    }
  }

  return false;
}

/**
 * Express middleware that rejects requests whose parsed JSON body exceeds `maxDepth`
 * levels of nesting.  Must be mounted AFTER `express.json()` so `req.body` is populated.
 *
 * @param maxDepth - Maximum allowed nesting depth (defaults to `config.maxJsonDepth`).
 */
export function enforceJsonDepth(maxDepth: number = config.maxJsonDepth) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (req.body !== undefined && exceedsDepth(req.body, maxDepth)) {
      res.status(400).json({
        error: {
          code: "JSON_TOO_DEEP",
          message: "Request body exceeds maximum nesting depth",
        },
      });
      return;
    }
    next();
  };
}
