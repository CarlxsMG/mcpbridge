import express from "express";
import { setupTransports } from "./transports.js";
import { registerRoutes } from "./routes/register.js";
import { introspectionRoutes } from "./routes/introspection.js";
import { docsRoutes } from "./routes/docs.js";
import { startHealthCheckLoop } from "./health.js";

const app = express();
app.use(express.json());

// MCP transports (Streamable HTTP + SSE legacy)
setupTransports(app);

// REST endpoints
registerRoutes(app);
introspectionRoutes(app);
docsRoutes(app);

// Health check loop
const stopHealthChecks = startHealthCheckLoop();

const PORT = parseInt(process.env.PORT || "3000", 10);
app.listen(PORT, () => {
  console.log(`MCP REST Bridge listening on port ${PORT}`);
  console.log(`  Streamable HTTP: POST|GET|DELETE /mcp`);
  console.log(`  Legacy SSE:      GET /sse, POST /messages`);
  console.log(`  Registration:    POST /register`);
  console.log(`  Introspection:   GET /clients, GET /clients/:name/tools`);
  console.log(`  API Docs:        GET /docs`);
});

// Graceful shutdown
process.on("SIGINT", () => {
  stopHealthChecks();
  process.exit(0);
});
