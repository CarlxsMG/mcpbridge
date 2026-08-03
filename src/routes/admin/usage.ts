import { Router } from "express";
import type { Request, Response } from "express";
import { getUsageSummary, getUsageTimeseries, getTopTools, getUsageByKey } from "../../observability/usage.js";
import { callerTeamId, ensureClientAccess } from "../../middleware/authz.js";

function num(v: unknown): number | undefined {
  if (typeof v !== "string") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Read-only usage analytics endpoints (viewers may read) — but every query is
 * scoped to the caller's own team (mirrors clients.ts/traffic.ts's `teamId`
 * pattern): an explicit `?client=` is checked via `ensureClientAccess` so a
 * team-scoped caller can't probe another tenant's client by name, and the
 * aggregate/by-key views are restricted to the caller's team's clients.
 */
export const usageRoutes = Router();

usageRoutes.get("/usage/summary", (req: Request, res: Response) => {
  const clientName = typeof req.query.client === "string" ? req.query.client : undefined;
  if (clientName && !ensureClientAccess(req, res, clientName)) return;
  const teamId = callerTeamId(req);
  res.status(200).json(
    getUsageSummary({
      from: num(req.query.from),
      to: num(req.query.to),
      clientName,
      teamId: typeof teamId === "number" ? teamId : undefined,
    }),
  );
});

usageRoutes.get("/usage/timeseries", (req: Request, res: Response) => {
  const clientName = typeof req.query.client === "string" ? req.query.client : undefined;
  if (clientName && !ensureClientAccess(req, res, clientName)) return;
  const teamId = callerTeamId(req);
  res.status(200).json(
    getUsageTimeseries({
      from: num(req.query.from),
      to: num(req.query.to),
      bucketMs: num(req.query.bucketMs),
      clientName,
      teamId: typeof teamId === "number" ? teamId : undefined,
    }),
  );
});

usageRoutes.get("/usage/top-tools", (req: Request, res: Response) => {
  const teamId = callerTeamId(req);
  res.status(200).json({
    items: getTopTools({
      from: num(req.query.from),
      limit: num(req.query.limit),
      teamId: typeof teamId === "number" ? teamId : undefined,
    }),
  });
});

usageRoutes.get("/usage/by-key", (req: Request, res: Response) => {
  const teamId = callerTeamId(req);
  res.status(200).json({
    items: getUsageByKey({
      from: num(req.query.from),
      limit: num(req.query.limit),
      teamId: typeof teamId === "number" ? teamId : undefined,
    }),
  });
});
