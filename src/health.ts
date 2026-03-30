import { registry } from "./registry.js";
import { config } from "./config.js";
import { log } from "./logger.js";

export function startHealthCheckLoop(): () => void {
  const check = async () => {
    const clients = registry.getAllClients();
    await Promise.allSettled(
      clients.map(async (client) => {
        try {
          const res = await fetch(client.health_url, {
            redirect: "error" as RequestRedirect,
            signal: AbortSignal.timeout(config.healthCheckTimeoutMs),
          });
          registry.markStatus(client.name, res.ok ? "healthy" : "unreachable");
        } catch {
          registry.markStatus(client.name, "unreachable");
          log("warn", "Health check failed", { client: client.name });
        }
      })
    );
  };

  const timer = setInterval(check, config.healthCheckIntervalMs);
  return () => clearInterval(timer);
}
