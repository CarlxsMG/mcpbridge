import { readFileSync } from "fs";
import { resolve } from "path";
import { parse } from "yaml";
import swaggerUi from "swagger-ui-express";
import type { Express } from "express";

export function docsRoutes(app: Express): void {
  const specPath = resolve(import.meta.dirname, "../openapi.yaml");
  const spec = parse(readFileSync(specPath, "utf-8"));
  app.use("/docs", swaggerUi.serve, swaggerUi.setup(spec));
}
