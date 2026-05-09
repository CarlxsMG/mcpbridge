import { readFileSync } from "fs";
import { resolve } from "path";
import { parse } from "yaml";
import swaggerUi from "swagger-ui-express";
import type { Express, Request, Response, NextFunction } from "express";
import { adminAuth } from "../middleware/auth.js";

export function docsRoutes(app: Express): void {
  const specPath = resolve(import.meta.dirname, "../openapi.yaml");
  const spec = parse(readFileSync(specPath, "utf-8"));

  const docsGuard = process.env.NODE_ENV === "development"
    ? (_req: Request, _res: Response, next: NextFunction) => next()
    : adminAuth;

  app.use("/docs", docsGuard, swaggerUi.serve, swaggerUi.setup(spec));
}
