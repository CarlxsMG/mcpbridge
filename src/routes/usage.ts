import { Router } from "express";
import type { Request, Response, Express } from "express";
import { adminAuth } from "../middleware/auth.js";
import { getUsageSummary, getUsageTimeseries, getTopTools, getUsageByKey } from "../observability/usage.js";

function num(v: unknown): number | undefined {
  if (typeof v !== "string") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/** Read-only usage analytics endpoints (viewers may read). */
export function usageRoutes(app: Express): void {
  // One shared admin-auth gate for every route in this file (mounted under
  // /admin-api below), instead of repeating adminAuth on each handler.
  const r = Router();
  r.use(adminAuth);

  r.get("/usage/summary", (req: Request, res: Response) => {
    res.status(200).json(
      getUsageSummary({
        from: num(req.query.from),
        to: num(req.query.to),
        clientName: typeof req.query.client === "string" ? req.query.client : undefined,
      }),
    );
  });

  r.get("/usage/timeseries", (req: Request, res: Response) => {
    res.status(200).json(
      getUsageTimeseries({
        from: num(req.query.from),
        to: num(req.query.to),
        bucketMs: num(req.query.bucketMs),
        clientName: typeof req.query.client === "string" ? req.query.client : undefined,
      }),
    );
  });

  r.get("/usage/top-tools", (req: Request, res: Response) => {
    res.status(200).json({ items: getTopTools({ from: num(req.query.from), limit: num(req.query.limit) }) });
  });

  r.get("/usage/by-key", (req: Request, res: Response) => {
    res.status(200).json({ items: getUsageByKey({ from: num(req.query.from), limit: num(req.query.limit) }) });
  });

  app.use("/admin-api", r);
}
