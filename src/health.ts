import { registry } from "./registry.js";

export function startHealthCheckLoop(intervalMs = 30_000): () => void {
  const check = async () => {
    const clients = registry.getAllClients();
    await Promise.allSettled(
      clients.map(async (client) => {
        try {
          const res = await fetch(client.health_url, {
            signal: AbortSignal.timeout(5_000),
          });
          registry.markStatus(client.name, res.ok ? "healthy" : "unreachable");
        } catch {
          registry.markStatus(client.name, "unreachable");
        }
      })
    );
  };

  const timer = setInterval(check, intervalMs);
  return () => clearInterval(timer);
}
