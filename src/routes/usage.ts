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
  app.get("/admin-api/usage/summary", adminAuth, (req: Request, res: Response) => {
    res.status(200).json(
      getUsageSummary({
        from: num(req.query.from),
        to: num(req.query.to),
        clientName: typeof req.query.client === "string" ? req.query.client : undefined,
      }),
    );
  });

  app.get("/admin-api/usage/timeseries", adminAuth, (req: Request, res: Response) => {
    res.status(200).json(
      getUsageTimeseries({
        from: num(req.query.from),
        to: num(req.query.to),
        bucketMs: num(req.query.bucketMs),
        clientName: typeof req.query.client === "string" ? req.query.client : undefined,
      }),
    );
  });

  app.get("/admin-api/usage/top-tools", adminAuth, (req: Request, res: Response) => {
    res.status(200).json({ items: getTopTools({ from: num(req.query.from), limit: num(req.query.limit) }) });
  });

  app.get("/admin-api/usage/by-key", adminAuth, (req: Request, res: Response) => {
    res.status(200).json({ items: getUsageByKey({ from: num(req.query.from), limit: num(req.query.limit) }) });
  });
}
