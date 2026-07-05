import { registry } from "../mcp/registry.js";
import type { ClientStatus } from "../mcp/types.js";
import { config } from "../config.js";
import { log } from "../logger.js";
import { notifyToolsChanged } from "../mcp/mcp-server.js";
import { isLeader } from "../db/leader-lease.js";
import { mcpUpstream } from "../mcp/mcp-upstream.js";
import { getUpstreamAuthHeaders } from "../backend-auth/upstream-auth.js";
import { healthCheckDuration, healthCheckRunsTotal, healthLoopErrorsTotal, healthEvictionsTotal } from "./metrics.js";

async function checkBatch(clients: ReturnType<typeof registry.listClients>): Promise<void> {
  for (let i = 0; i < clients.length; i += config.healthCheckMaxConcurrent) {
    const batch = clients.slice(i, i + config.healthCheckMaxConcurrent);
    await Promise.allSettled(
      batch.map(async (client) => {
        const previousStatus = client.status;
        const hcStart = Date.now();
        try {
          let ok: boolean;
          if (client.kind === "mcp") {
            // MCP upstreams are probed with a JSON-RPC ping over the pooled
            // connection instead of an HTTP GET against health_url.
            ok = await mcpUpstream.ping(
              {
                name: client.name,
                url: client.mcpUrl ?? client.base_url,
                transport: client.mcpTransport ?? "streamable-http",
                resolvedIp: client.resolved_ip,
                authHeaders: getUpstreamAuthHeaders(client.name) ?? undefined,
              },
              config.healthCheckTimeoutMs,
            );
          } else {
            // Use pinned IP to prevent DNS rebinding
            const healthParsed = new URL(client.health_url);
            const originalHealthHost = healthParsed.host;
            healthParsed.hostname = client.resolved_ip;
            const pinnedHealthUrl = healthParsed.toString();

            const res = await fetch(pinnedHealthUrl, {
              headers: { Host: originalHealthHost },
              redirect: "error" as RequestRedirect,
              signal: AbortSignal.timeout(config.healthCheckTimeoutMs),
            });
            ok = res.ok;
          }
          if (ok) {
            healthCheckDuration.observe({ client: client.name, outcome: "success" }, (Date.now() - hcStart) / 1000);
            healthCheckRunsTotal.inc({ outcome: "success" });
            registry.resetConsecutiveFailures(client.name);
            registry.markClientStatus(client.name, "healthy");
            if (previousStatus !== "healthy") {
              notifyToolsChanged();
            }
          } else {
            healthCheckDuration.observe({ client: client.name, outcome: "failure" }, (Date.now() - hcStart) / 1000);
            healthCheckRunsTotal.inc({ outcome: "failure" });
            await handleFailure(client.name, previousStatus);
          }
        } catch (error) {
          healthCheckDuration.observe({ client: client.name, outcome: "failure" }, (Date.now() - hcStart) / 1000);
          healthCheckRunsTotal.inc({ outcome: "failure" });
          log("warn", "Health check failed", {
            client: client.name,
            error: error instanceof Error ? error.message : String(error),
          });
          await handleFailure(client.name, previousStatus);
        }
      }),
    );
  }
}

async function handleFailure(name: string, previousStatus: ClientStatus): Promise<void> {
  const failures = registry.incrementConsecutiveFailures(name);

  // If incrementConsecutiveFailures returned 0 the client was already removed
  if (failures === 0) {
    return;
  }

  if (failures >= config.maxConsecutiveFailures) {
    // First mark as unreachable so status is correct before eviction
    registry.markClientStatus(name, "unreachable");
    if (previousStatus !== "unreachable") {
      notifyToolsChanged();
    }

    log("warn", `Auto-evicting client after ${failures} consecutive health failures`, {
      client: name,
    });

    healthEvictionsTotal.inc({ client: name });

    // unregister() handles abort of in-flight requests, circuit-breaker cleanup,
    // toolIndex cleanup, and notifyToolsChanged — no duplication needed here.
    await registry.unregister(name);
  } else {
    registry.markClientStatus(name, "unreachable");
    if (previousStatus !== "unreachable") {
      notifyToolsChanged();
    }
  }
}

export function startHealthCheckLoop(): () => void {
  const check = async () => {
    try {
      // Only the elected leader actually probes backends — running this
      // loop on every horizontally-scaled instance would multiply real
      // network load against the same backends N-fold. Circuit-breaker and
      // rate-limiter cleanup loops are NOT gated this way since they only
      // ever touch this process's own local, uncoordinated in-memory state.
      if (!isLeader()) return;
      const clients = registry.listClients();
      await checkBatch(clients);
    } catch (err) {
      healthLoopErrorsTotal.inc({});
      log("error", "Health check loop encountered an unhandled error", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };

  // Run immediately on start, then at interval
  check();

  const timer = setInterval(check, config.healthCheckIntervalMs);
  return () => clearInterval(timer);
}
