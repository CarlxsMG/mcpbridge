import { registry } from "./registry.js";
import { config } from "./config.js";
import { log } from "./logger.js";

const MAX_CONCURRENT_CHECKS = 20;

async function checkBatch(clients: ReturnType<typeof registry.getAllClients>): Promise<void> {
  for (let i = 0; i < clients.length; i += MAX_CONCURRENT_CHECKS) {
    const batch = clients.slice(i, i + MAX_CONCURRENT_CHECKS);
    await Promise.allSettled(
      batch.map(async (client) => {
        try {
          const res = await fetch(client.health_url, {
            redirect: "error" as RequestRedirect,
            signal: AbortSignal.timeout(config.healthCheckTimeoutMs),
          });
          registry.markStatus(client.name, res.ok ? "healthy" : "unreachable");
        } catch (error) {
          registry.markStatus(client.name, "unreachable");
          log("warn", "Health check failed", {
            client: client.name,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      })
    );
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
