import { config } from "../config.js";
import { getUsageSummary } from "./usage.js";

/**
 * Usage-spike anomaly detection: compares the call rate in a recent window
 * against the rate over the immediately-preceding baseline window. A spike is a
 * recent rate that is `factor`x the baseline (or any burst of >= minCalls when
 * the baseline was silent — genuinely new activity). Feeds the existing alert
 * machinery as the "usage_spike" event type; no new persistence.
 */
export interface SpikeResult {
  spike: boolean;
  recentCalls: number;
  recentRate: number; // calls per minute
  baselineRate: number; // calls per minute
  factor: number;
}

export function detectUsageSpike(
  opts: { factor?: number; minCalls?: number; now?: number; clientName?: string } = {},
): SpikeResult {
  const factor = opts.factor ?? 3;
  const minCalls = opts.minCalls ?? 20;
  const now = opts.now ?? Date.now();

  const recentWindow = config.anomalyRecentWindowMs;
  const baselineWindow = config.anomalyBaselineWindowMs;

  const recentFrom = now - recentWindow;
  const baselineFrom = recentFrom - baselineWindow;

  const recent = getUsageSummary({ from: recentFrom, to: now, clientName: opts.clientName });
  const baseline = getUsageSummary({ from: baselineFrom, to: recentFrom, clientName: opts.clientName });

  const recentRate = recent.calls / (recentWindow / 60_000);
  const baselineRate = baseline.calls / (baselineWindow / 60_000);

  let spike = false;
  if (recent.calls >= minCalls) {
    // A silent baseline followed by a burst is a spike; otherwise require the
    // recent rate to clear the factor multiple of the baseline rate.
    spike = baselineRate === 0 ? true : recentRate >= baselineRate * factor;
  }

  return { spike, recentCalls: recent.calls, recentRate, baselineRate, factor };
}
