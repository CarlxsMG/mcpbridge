/**
 * Health / liveness / readiness endpoints.
 *
 * Three distinct concerns, three distinct endpoints — k8s probes and
 * load-balancer health checks need them separately:
 *
 *   - `/livez`  Liveness. "Is this process alive and able to answer HTTP?"
 *               Always 200. A liveness probe failure means restart the
 *               container; nothing in this codebase can flip it to a
 *               non-200 by itself, which is exactly the point.
 *
 *   - `/readyz` Readiness. "Is this instance ready to serve traffic?"
 *               200 only when both (a) the leader lease is held and
 *               (b) the SQLite handle answers `SELECT 1`. A readiness
 *               failure means take this instance out of the LB pool —
 *               it will be flipped back when the underlying condition
 *               clears. Background loops (alert evaluation, schedule
 *               evaluator, registry reconciliation) are leader-only by
 *               design, so a non-leader follower is *deliberately* not
 *               ready for the data-plane: another instance owns those
 *               jobs already.
 *
 *   - `/health` Legacy generic health. Returns uptime too, kept for
 *               backward compatibility with existing ops dashboards /
 *               uptime probes. New probes should prefer /readyz.
 *
 * Pure check helper `checkReadiness` is exported so tests can exercise
 * the readiness logic without having to acquire a leader lease first.
 */
import type { Express, Request, Response } from "express";
import { isLeader } from "../db/leader-lease.js";
import { getDb } from "../db/connection.js";

const startedAt = Date.now();

export interface ReadinessReport {
  ready: boolean;
  reasons: string[];
}

function dbUp(): boolean {
  try {
    // `SELECT 1` is the canonical "is the connection alive" probe: it
    // round-trips through SQLite without touching any user table, so it
    // survives schema migrations and an empty database.
    getDb().query("SELECT 1").get();
    return true;
  } catch {
    return false;
  }
}

/**
 * Pure readiness check. Returns a structured report so callers can pick
 * the response code (200/503) and so tests can assert on the reasons
 * without parsing a status line.
 */
export function checkReadiness(): ReadinessReport {
  const reasons: string[] = [];
  if (!isLeader()) reasons.push("not_leader");
  if (!dbUp()) reasons.push("db_unavailable");
  return { ready: reasons.length === 0, reasons };
}

export function healthRoutes(app: Express): void {
  // Liveness — always 200 if the process is responding.
  app.get("/livez", (_req: Request, res: Response) => {
    res.status(200).json({ status: "alive" });
  });

  // Readiness — 200 only when this instance can do its leader-only work.
  app.get("/readyz", (_req: Request, res: Response) => {
    const report = checkReadiness();
    res.status(report.ready ? 200 : 503).json({
      status: report.ready ? "ready" : "not_ready",
      reasons: report.reasons,
    });
  });

  // Legacy generic /health — uptime for ops dashboards.
  app.get("/health", (_req: Request, res: Response) => {
    res.status(200).json({
      status: "ok",
      uptime_seconds: Math.floor((Date.now() - startedAt) / 1000),
    });
  });
}
