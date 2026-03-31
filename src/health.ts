import { registry } from "./registry.js";
import { config } from "./config.js";
import { log } from "./logger.js";
import { notifyToolsChanged } from "./mcp-server.js";

const MAX_CONCURRENT_CHECKS = 20;
const FAILURE_THRESHOLD = 3;

async function checkBatch(clients: ReturnType<typeof registry.getAllClients>): Promise<void> {
  for (let i = 0; i < clients.length; i += MAX_CONCURRENT_CHECKS) {
    const batch = clients.slice(i, i + MAX_CONCURRENT_CHECKS);
    await Promise.allSettled(
      batch.map(async (client) => {
        const previousStatus = client.status;
        try {
          // Use pinned IP to prevent DNS rebinding
          const healthParsed = new URL(client.health_url);
          const originalHealthHost = healthParsed.host;
          healthParsed.hostname = client.resolved_ip;
          const pinnedHealthUrl = healthParsed.toString();

          const res = await fetch(pinnedHealthUrl, {
            headers: { "Host": originalHealthHost },
            redirect: "error" as RequestRedirect,
            signal: AbortSignal.timeout(config.healthCheckTimeoutMs),
          });
          if (res.ok) {
            client.consecutive_failures = 0;
            registry.markStatus(client.name, "healthy");
            if (previousStatus !== "healthy") {
              notifyToolsChanged();
            }
          } else {
            handleFailure(client.name, previousStatus);
          }
        } catch (error) {
          log("warn", "Health check failed", {
            client: client.name,
            error: error instanceof Error ? error.message : String(error),
          });
          handleFailure(client.name, previousStatus);
        }
      })
    );
  }
}

function handleFailure(name: string, previousStatus: "healthy" | "unreachable"): void {
  const client = registry.clients.get(name);
  if (!client) {
    return;
  }

  client.consecutive_failures += 1;

  if (client.consecutive_failures >= FAILURE_THRESHOLD) {
    registry.markStatus(name, "unreachable");
    if (previousStatus !== "unreachable") {
      notifyToolsChanged();
    }

    if (client.consecutive_failures >= config.maxConsecutiveFailures) {
      log("warn", `Auto-evicting client after ${client.consecutive_failures} consecutive health failures`, {
        client: name,
      });
      registry.unregister(name);
      notifyToolsChanged();
    }
  }
}

export function startHealthCheckLoop(): () => void {
  const check = async () => {
    const clients = registry.getAllClients();
    await checkBatch(clients);
  };

  // Run immediately on start, then at interval
  check();

  const timer = setInterval(check, config.healthCheckIntervalMs);
  return () => clearInterval(timer);
}
