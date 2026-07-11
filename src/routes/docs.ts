import swaggerUi from "swagger-ui-express";
import type { Express, Request, Response, NextFunction } from "express";
import { adminAuth } from "../middleware/auth.js";
// Bun parses YAML modules at bundle time (native loader, same as JSON) — this
// works identically under `bun src/index.ts` and under `bun build --compile`.
// The previous `readFileSync(resolve(import.meta.dirname, ...))` approach
// broke in standalone-executable mode: `import.meta.dirname` resolves to a
// synthetic $bunfs path there, not a real on-disk directory, so the read
// always threw ENOENT and crashed startup before the server could listen.
import spec from "../openapi.yaml";

export function docsRoutes(app: Express): void {
  // /docs (Swagger UI + the full OpenAPI spec) is admin-authenticated by
  // default. Set EXPOSE_DOCS_UNAUTHENTICATED=true to serve it publicly — an
  // explicit opt-in, so a staging/shared deploy that happens to inherit
  // NODE_ENV=development can't silently expose the whole API surface.
  const docsGuard =
    process.env.EXPOSE_DOCS_UNAUTHENTICATED === "true"
      ? (_req: Request, _res: Response, next: NextFunction) => next()
      : adminAuth;

  app.use("/docs", docsGuard, swaggerUi.serve, swaggerUi.setup(spec));
}
