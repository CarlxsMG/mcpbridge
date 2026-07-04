import type {
  OverviewStats,
  TopToolRow,
  UsageByKeyRow,
  UsageSummary,
  UsageTimeseries,
  UsageTimeseriesPoint,
} from "../../types/api";
import { days, NOW } from "./time";

export const topTools: TopToolRow[] = [
  { client: "github", tool: "search_issues", calls: 4210, errors: 12, errorRate: 0.0028, avgMs: 118, maxMs: 940 },
  { client: "stripe", tool: "get_customer", calls: 3320, errors: 8, errorRate: 0.0024, avgMs: 96, maxMs: 610 },
  { client: "slack", tool: "post_message", calls: 2870, errors: 31, errorRate: 0.0108, avgMs: 142, maxMs: 1200 },
  { client: "internal-crm", tool: "find_account", calls: 1980, errors: 54, errorRate: 0.0273, avgMs: 260, maxMs: 2210 },
  { client: "stripe", tool: "create_refund", calls: 640, errors: 3, errorRate: 0.0047, avgMs: 180, maxMs: 880 },
  { client: "weather", tool: "forecast", calls: 5203, errors: 2, errorRate: 0.0004, avgMs: 72, maxMs: 410 },
];

export const byKey: UsageByKeyRow[] = [
  { keyId: 1, label: "Claude Desktop", calls: 8120, errors: 44 },
  { keyId: 3, label: "CI pipeline (elevated)", calls: 6010, errors: 61 },
  { keyId: 2, label: "Cursor IDE", calls: 3140, errors: 22 },
  { keyId: null, label: "(no key)", calls: 1153, errors: 10 },
];

export const usageSummary: UsageSummary = {
  from: days(7),
  calls: 18423,
  errors: 137,
  errorRate: 0.0074,
  avgMs: 142,
  maxMs: 2210,
  tools: 39,
  keys: 6,
};

export const overview: OverviewStats = {
  clients: { live: 5, disabled: 1, healthy: 4, degraded: 1, unreachable: 1 },
  tools: { total: 42, disabled: 3 },
  circuit_breakers: { open: 0, half_open: 1, closed: 4 },
  admin_users: 3,
};

function timeseriesPoints(bucketMs: number, count: number): UsageTimeseriesPoint[] {
  const end = Math.floor(NOW / bucketMs) * bucketMs;
  const points: UsageTimeseriesPoint[] = [];
  for (let i = count - 1; i >= 0; i--) {
    const wave = Math.sin((count - i) / 3) * 0.5 + 0.5;
    const calls = Math.round(80 + wave * 220 + ((i * 37) % 23));
    const errors = Math.round(calls * (0.005 + ((i * 13) % 7) / 400));
    points.push({ t: end - i * bucketMs, calls, errors, avgMs: 90 + ((i * 17) % 60) });
  }
  return points;
}

export const usageTimeseries: UsageTimeseries = { bucketMs: 60 * 60_000, points: timeseriesPoints(60 * 60_000, 24) };
