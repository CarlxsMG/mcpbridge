import { Router, type Request, type Response } from "express";
import { registry } from "../../mcp/registry.js";
import { getAllCircuitStates } from "../../middleware/circuit-breaker.js";
import { listUsers } from "../../security/user-store.js";
import { cacheSize } from "../../tool-policies/response-cache.js";
import { wsProxyActiveConnectionCount } from "../../ws-proxy.js";

/**
 * GET /overview — top-of-dashboard counters for the admin UI. Aggregates
 * across the live (in-memory) registry: client health, tool counts, circuit
 * breaker states, admin-user count, response-cache size, and live ws-proxy
 * connection count. Does not read SQLite — every figure is either already
 * in memory or fetched from the auth store.
 */
export const overviewRoutes = Router();

overviewRoutes.get("/overview", (_req: Request, res: Response) => {
  const liveClients = registry.listClients();
  const statusCounts = { healthy: 0, degraded: 0, unreachable: 0 };
  let disabledClients = 0;
  let disabledTools = 0;
  let totalTools = 0;
  for (const c of liveClients) {
    statusCounts[c.status]++;
    if (!c.enabled) disabledClients++;
    for (const t of c.tools) {
      totalTools++;
      if (!t.enabled) disabledTools++;
    }
  }
  const breakerStates = Object.values(getAllCircuitStates());
  const openBreakers = breakerStates.filter((s) => s === "open").length;
  const halfOpenBreakers = breakerStates.filter((s) => s === "half_open").length;
  const closedBreakers = breakerStates.length - openBreakers - halfOpenBreakers;

  res.status(200).json({
    clients: { live: liveClients.length, disabled: disabledClients, ...statusCounts },
    tools: { total: totalTools, disabled: disabledTools },
    circuit_breakers: { open: openBreakers, half_open: halfOpenBreakers, closed: closedBreakers },
    admin_users: listUsers().length,
    response_cache: { entries: cacheSize() },
    ws_proxy: { active_connections: wsProxyActiveConnectionCount() },
  });
});
