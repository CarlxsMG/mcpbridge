import { describe, expect, it } from "vitest";
import {
  emptyStores,
  STAT_METRICS,
  DONUT_BREAKDOWNS,
  BARS_RANKINGS,
  LIST_FEEDS,
  TIMESERIES_SERIES,
  STAT_BY_ID,
  DONUT_BY_ID,
  BARS_BY_ID,
  LIST_BY_ID,
  SERIES_BY_ID,
  CATALOG_PRESETS,
  WINDOWED_SOURCES,
  defaultLayout,
  sourceForWidget,
  neededSources,
  noteInstance,
  type DashboardStores,
  type WidgetViz,
} from "../widgetCatalog";
import { pct } from "@/utils/format";

// Every source id is one the demo mock serves; a new registry entry pointing at
// a non-demo-backed source would fail these tests (INVARIANT in widgetCatalog.ts).
const DEMO_SOURCES = new Set(Object.keys(emptyStores()));
const VIZ: WidgetViz[] = ["stat", "timeseries", "donut", "bars", "list", "note"];

function richStores(): DashboardStores {
  const s = emptyStores();
  s.overview = {
    clients: { live: 5, disabled: 1, healthy: 4, degraded: 1, unreachable: 1 },
    tools: { total: 42, disabled: 3 },
    circuit_breakers: { open: 2, half_open: 1, closed: 4 },
    admin_users: 3,
  };
  s.usageSummary = { from: 0, calls: 1234, errors: 5, errorRate: 0.05, avgMs: 120, maxMs: 900, tools: 10, keys: 3 };
  s.usageTimeseries = {
    bucketMs: 3_600_000,
    points: [
      { t: 1, calls: 10, errors: 1, avgMs: 100 },
      { t: 2, calls: 20, errors: 0, avgMs: 110 },
    ],
  };
  s.topTools = [{ client: "a", tool: "x", calls: 50, errors: 6, errorRate: 0.12, avgMs: 100, maxMs: 200 }];
  s.byKey = [{ keyId: 1, label: "key-1", calls: 30, errors: 0 }];
  s.clients = [
    {
      name: "a",
      enabled: true,
      live: true,
      status: "healthy",
      toolsCount: 2,
      healthUrl: "",
      baseUrl: "",
      kind: "rest",
      teamId: null,
    },
    {
      name: "b",
      enabled: true,
      live: false,
      status: "unreachable",
      toolsCount: 0,
      healthUrl: "",
      baseUrl: "",
      kind: "rest",
      teamId: null,
    },
  ];
  s.monitors = [
    {
      clientName: "a",
      toolName: "x",
      exampleId: 1,
      intervalMinutes: 5,
      enabled: true,
      driftDetected: true,
      lastStatus: "ok",
      lastError: null,
      lastCheckedAt: 1,
    },
  ];
  s.approvals = [
    {
      id: 1,
      clientName: "a",
      toolName: "x",
      argsHash: "h",
      argsJson: "{}",
      status: "pending",
      createdAt: Date.now() - 60_000,
      decidedAt: null,
      decidedBy: null,
      note: null,
      consumedAt: null,
      requestedBy: null,
      requiredLevels: 1,
      decisions: [],
    },
    {
      id: 2,
      clientName: "a",
      toolName: "y",
      argsHash: "h",
      argsJson: "{}",
      status: "approved",
      createdAt: Date.now(),
      decidedAt: Date.now(),
      decidedBy: "me",
      note: null,
      consumedAt: null,
      requestedBy: null,
      requiredLevels: 1,
      decisions: [],
    },
  ];
  s.traffic = [
    {
      id: 1,
      mcpToolName: "a__x",
      clientName: "a",
      toolName: "x",
      keyId: null,
      argsJson: "{}",
      preview: "",
      isError: true,
      durationMs: 50,
      createdAt: Date.now() - 60_000,
    },
  ];
  s.auditLog = [
    {
      id: 1,
      actor: "me",
      action: "client.update",
      target: "a",
      detail: null,
      createdAt: Date.now() - 3_600_000,
      hash: null,
    },
  ];
  s.consumers = [
    {
      id: 1,
      name: "acme",
      monthlyQuota: 100,
      endUserRateLimitPerMin: null,
      usedThisMonth: 120,
      createdAt: 0,
      updatedAt: 0,
      createdBy: null,
    },
  ];
  s.wsProxyTargets = [
    {
      name: "w",
      backendWsUrl: "",
      resolvedIp: "",
      maxConnections: 10,
      maxMessageBytes: 1,
      idleTimeoutMs: 1,
      enabled: true,
      activeConnections: 3,
      createdAt: 0,
      updatedAt: 0,
    },
  ];
  return s;
}

describe("registry invariants", () => {
  it("every registry entry targets a demo-backed source", () => {
    const all = [...STAT_METRICS, ...DONUT_BREAKDOWNS, ...BARS_RANKINGS, ...LIST_FEEDS, ...TIMESERIES_SERIES];
    for (const def of all) expect(DEMO_SOURCES.has(def.source), `${def.id} -> ${def.source}`).toBe(true);
  });

  it("windowed sources are all real source ids", () => {
    for (const src of WINDOWED_SOURCES) expect(DEMO_SOURCES.has(src)).toBe(true);
  });

  it("catalog presets create instances whose type matches the preset viz and bind a demo source", () => {
    for (const p of CATALOG_PRESETS) {
      expect(VIZ).toContain(p.viz);
      const inst = p.create();
      expect(inst.type).toBe(p.viz);
      const src = sourceForWidget(inst);
      if (p.viz === "note") expect(src).toBeNull();
      else expect(src && DEMO_SOURCES.has(src)).toBe(true);
    }
  });
});

describe("stat metrics", () => {
  it("maps overview + usage fields", () => {
    const s = richStores();
    const live = STAT_BY_ID.get("clients.live")!.get(s)!;
    expect(live.value).toBe(5);
    expect(live.detail).toBe("1 disabled");
    expect(live.segments).toHaveLength(3);

    expect(STAT_BY_ID.get("breakers.open")!.get(s)!.value).toBe(2);
    expect(STAT_BY_ID.get("usage.errorRate")!.get(s)!.display).toBe(pct(0.05));
    expect(STAT_BY_ID.get("approvals.pending")!.get(s)!.value).toBe(1);
    expect(STAT_BY_ID.get("ws.connections")!.get(s)!.value).toBe(3);
  });

  it("returns null when the source is not loaded", () => {
    expect(STAT_BY_ID.get("clients.live")!.get(emptyStores())).toBeNull();
  });
});

describe("donut breakdowns", () => {
  it("builds filtered segments from real counts", () => {
    const s = richStores();
    expect(DONUT_BY_ID.get("clients.health")!.get(s)).toHaveLength(3);
    // breakers: closed/half/open all > 0
    expect(
      DONUT_BY_ID.get("breakers")!
        .get(s)
        .map((x) => x.label),
    ).toEqual(["Closed", "Half-open", "Open"]);
    // one monitor, ok + drift -> "Drift detected" bucket
    const mon = DONUT_BY_ID.get("monitors.status")!.get(s);
    expect(mon).toEqual([{ label: "Drift detected", value: 1, color: "var(--canary)" }]);
    // approvals: pending + approved present, rejected filtered out
    expect(
      DONUT_BY_ID.get("approvals.status")!
        .get(s)
        .map((x) => x.label),
    ).toEqual(["Pending", "Approved"]);
  });
});

describe("bars rankings", () => {
  it("flags high-error tools and over-quota consumers as danger", () => {
    const s = richStores();
    const top = BARS_BY_ID.get("topTools")!.get(s);
    expect(top[0]).toMatchObject({ label: "a/x", value: 50, danger: true });
    const quota = BARS_BY_ID.get("consumers.quota")!.get(s);
    expect(quota[0]).toMatchObject({ label: "acme", value: 120, danger: true });
  });
});

describe("list feeds", () => {
  it("renders recent activity + tones error/unhealthy rows", () => {
    const s = richStores();
    expect(LIST_BY_ID.get("audit.recent")!.get(s).rows).toHaveLength(1);
    const traffic = LIST_BY_ID.get("traffic.recent")!.get(s);
    expect(traffic.rows[0].cells[1]).toMatchObject({ text: "Error", tone: "bad" });
    const unhealthy = LIST_BY_ID.get("clients.unhealthy")!.get(s);
    expect(unhealthy.rows).toHaveLength(1);
    expect(unhealthy.rows[0].cells[0].text).toBe("b");
  });

  it("reports an empty message when there's nothing to show", () => {
    expect(LIST_BY_ID.get("audit.recent")!.get(emptyStores()).rows).toHaveLength(0);
  });
});

describe("timeseries series", () => {
  it("splits calls + errors and formats latency", () => {
    const s = richStores();
    const ce = SERIES_BY_ID.get("calls.errors")!.get(s)!;
    expect(ce.points).toHaveLength(2);
    expect(ce.secondaryPoints).toHaveLength(2);
    const lat = SERIES_BY_ID.get("latency")!.get(s)!;
    expect(lat.valueFormat!(120)).toBe("120ms");
  });
});

describe("sourceForWidget / neededSources", () => {
  it("dedupes the sources the board needs and ignores notes", () => {
    const widgets = [
      STAT_BY_ID.get("clients.live") && {
        id: "1",
        type: "stat" as const,
        w: 3,
        h: 1,
        options: { title: "", metric: "clients.live" },
      },
      { id: "2", type: "stat" as const, w: 3, h: 1, options: { title: "", metric: "tools.total" } }, // also overview
      { id: "3", type: "bars" as const, w: 6, h: 2, options: { title: "", ranking: "topTools" } }, // topTools
      noteInstance("4"),
    ].filter(Boolean) as Parameters<typeof neededSources>[0];
    const need = neededSources(widgets);
    expect(need).toContain("overview");
    expect(need).toContain("topTools");
    expect(need.filter((s) => s === "overview")).toHaveLength(1);
    expect(need).not.toContain(null);
  });
});

describe("defaultLayout", () => {
  it("seeds 8 widgets with unique ids, each bound to a demo source (or note)", () => {
    const layout = defaultLayout();
    expect(layout).toHaveLength(8);
    expect(new Set(layout.map((w) => w.id)).size).toBe(8);
    for (const w of layout) {
      const src = sourceForWidget(w);
      expect(src === null || DEMO_SOURCES.has(src)).toBe(true);
    }
  });
});
