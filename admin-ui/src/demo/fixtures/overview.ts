import type { OverviewStats } from "@/types/api";

export const overview: OverviewStats = {
  clients: { live: 5, disabled: 1, healthy: 4, degraded: 1, unreachable: 1 },
  tools: { total: 42, disabled: 3 },
  circuit_breakers: { open: 0, half_open: 1, closed: 4 },
  admin_users: 3,
};
