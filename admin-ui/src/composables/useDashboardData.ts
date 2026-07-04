// Shared data layer for the Overview dashboard.
//
// Many widgets read the same source (e.g. several stat tiles all come from
// `/admin-api/overview`), so instead of each widget fetching for itself this
// fetches each DISTINCT needed source exactly once per refresh and stores the
// result by id. Widgets read from `stores` synchronously via the pure catalog
// mappers. Niche sources are only fetched when a widget on the board needs them
// (`neededSources`), and the four windowed usage sources refetch when the global
// time window changes.
//
// Note: the demo mock ignores `from=` (see demo.ts) — the time window is honored
// by the real backend but is inert in the public demo, exactly like UsagePage.

import { reactive, ref, watch, type Ref } from "vue";
import { api } from "@/composables/useApi";
import { toErrorMessage } from "@/utils/errors";
import {
  emptyStores,
  WINDOWED_SOURCES,
  type DashboardSourceId,
  type DashboardStores,
} from "@/components/overview/widgetCatalog";
import type {
  OverviewStats,
  UsageSummary,
  UsageTimeseries,
  TopToolRow,
  UsageByKeyRow,
  ClientSummary,
  MonitorRecord,
  ApprovalRecord,
  TrafficRecord,
  AuditLogEntry,
  ConsumerWithUsage,
  WsProxyTarget,
} from "@/types/api";

const items = async <T>(path: string): Promise<T[]> => (await api.get<{ items: T[] }>(path)).items;

export function useDashboardData(sources: Ref<DashboardSourceId[]>, windowMs: Ref<number>) {
  const stores = reactive<DashboardStores>(emptyStores());
  const errors = reactive<Partial<Record<DashboardSourceId, string>>>({});
  const loading = ref(false);
  const loaded = new Set<DashboardSourceId>();

  // Each loader assigns straight into the reactive `stores`. `from` is the epoch
  // lower bound for the windowed usage endpoints; the rest ignore it.
  const LOADERS: Record<DashboardSourceId, (from: number) => Promise<void>> = {
    overview: async () => {
      stores.overview = await api.get<OverviewStats>("/admin-api/overview");
    },
    usageSummary: async (from) => {
      stores.usageSummary = await api.get<UsageSummary>(`/admin-api/usage/summary?from=${from}`);
    },
    usageTimeseries: async (from) => {
      stores.usageTimeseries = await api.get<UsageTimeseries>(`/admin-api/usage/timeseries?from=${from}`);
    },
    topTools: async (from) => {
      stores.topTools = await items<TopToolRow>(`/admin-api/usage/top-tools?from=${from}&limit=8`);
    },
    byKey: async (from) => {
      stores.byKey = await items<UsageByKeyRow>(`/admin-api/usage/by-key?from=${from}&limit=8`);
    },
    clients: async () => {
      stores.clients = await items<ClientSummary>("/admin-api/clients");
    },
    monitors: async () => {
      stores.monitors = await items<MonitorRecord>("/admin-api/monitors");
    },
    approvals: async () => {
      stores.approvals = await items<ApprovalRecord>("/admin-api/approvals");
    },
    traffic: async () => {
      stores.traffic = await items<TrafficRecord>("/admin-api/traffic");
    },
    auditLog: async () => {
      stores.auditLog = await items<AuditLogEntry>("/admin-api/audit-log");
    },
    consumers: async () => {
      stores.consumers = await items<ConsumerWithUsage>("/admin-api/consumers");
    },
    wsProxyTargets: async () => {
      stores.wsProxyTargets = await items<WsProxyTarget>("/admin-api/ws-proxy-targets");
    },
  };

  async function loadSource(id: DashboardSourceId, from: number): Promise<void> {
    try {
      await LOADERS[id](from);
      delete errors[id];
      loaded.add(id);
    } catch (err) {
      errors[id] = toErrorMessage(err, "Failed to load.");
    }
  }

  function windowFrom(): number {
    return Date.now() - windowMs.value;
  }

  /** Refetch every source the board currently needs. */
  async function refresh(): Promise<void> {
    const from = windowFrom();
    loading.value = true;
    try {
      await Promise.all(sources.value.map((id) => loadSource(id, from)));
    } finally {
      loading.value = false;
    }
  }

  // A newly-added widget may introduce a source we haven't fetched yet — fetch
  // just those, so adding a widget populates immediately without a full refresh.
  watch(sources, async (ids) => {
    const missing = ids.filter((id) => !loaded.has(id));
    if (missing.length === 0) return;
    const from = windowFrom();
    await Promise.all(missing.map((id) => loadSource(id, from)));
  });

  // The window only affects the windowed usage sources — refetch those (if any
  // are currently on the board) when it changes.
  watch(windowMs, async () => {
    const affected = sources.value.filter((id) => WINDOWED_SOURCES.has(id));
    if (affected.length === 0) return;
    const from = windowFrom();
    loading.value = true;
    try {
      await Promise.all(affected.map((id) => loadSource(id, from)));
    } finally {
      loading.value = false;
    }
  });

  return { stores, errors, loading, refresh };
}
