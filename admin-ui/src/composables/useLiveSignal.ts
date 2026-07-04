import { readonly, ref } from "vue";
import { api } from "./useApi";
import type { UsageSummary } from "@/types/api";

/** Lookback window for the "any traffic recently?" check — matches the poll cadence loosely so a
 *  missed tick still overlaps the previous window. */
const WINDOW_MS = 60_000;
const POLL_MS = 20_000;

// Module-level singleton state (mirrors the pattern in useAuth.ts) so every consumer of
// useLiveSignal() — e.g. multiple sidebar instances — shares one poll loop and one flag.
const isLive = ref(false);
// Raw call count over WINDOW_MS (60s), i.e. calls/minute — exposed so the sidebar dot's
// pulse speed can reflect real traffic volume instead of a flat on/off blink.
const callsPerMinute = ref(0);
let intervalId: ReturnType<typeof setInterval> | null = null;

/** Never fabricated: reflects only UsageSummary.calls from the real /admin-api/usage/summary
 *  endpoint. Errors are swallowed here so a failed poll just marks the signal as not-live. */
async function poll(): Promise<void> {
  try {
    const from = Date.now() - WINDOW_MS;
    const summary = await api.get<UsageSummary>(`/admin-api/usage/summary?from=${from}`);
    callsPerMinute.value = summary.calls;
    isLive.value = summary.calls > 0;
  } catch {
    callsPerMinute.value = 0;
    isLive.value = false;
  }
}

export function useLiveSignal() {
  function start(): void {
    if (intervalId !== null) return;
    void poll();
    intervalId = setInterval(() => {
      void poll();
    }, POLL_MS);
  }

  function stop(): void {
    if (intervalId !== null) {
      clearInterval(intervalId);
      intervalId = null;
    }
  }

  return { isLive: readonly(isLive), callsPerMinute: readonly(callsPerMinute), start, stop };
}
