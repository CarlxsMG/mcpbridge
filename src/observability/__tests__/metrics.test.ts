import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { Counter, Gauge, Histogram, MetricsRegistry } from "../../observability/metrics.js";
import express from "express";
import { createServer } from "http";
import { metricsRoutes } from "../../routes/metrics.js";
import { config } from "../../config.js";

const TEST_ADMIN_KEY = "test-admin-key-metrics";
const AUTH_HEADER = { Authorization: `Bearer ${TEST_ADMIN_KEY}` };

let originalAdminApiKeys: string[];
let originalAuthDisabled: boolean;

beforeAll(() => {
  originalAdminApiKeys = config.adminApiKeys;
  originalAuthDisabled = config.authDisabled;
  (config as Record<string, unknown>).adminApiKeys = [TEST_ADMIN_KEY];
  (config as Record<string, unknown>).authDisabled = false;
});

afterAll(() => {
  (config as Record<string, unknown>).adminApiKeys = originalAdminApiKeys;
  (config as Record<string, unknown>).authDisabled = originalAuthDisabled;
});

// ── Counter ───────────────────────────────────────────────────────────────────

describe("Counter", () => {
  it("increments and renders correctly", () => {
    const c = new Counter("test_counter_total", "A test counter");
    c.inc({ label: "a" });
    c.inc({ label: "a" });
    c.inc({ label: "b" }, 3);
    const out = c.render();
    expect(out).toContain('test_counter_total{label="a"} 2');
    expect(out).toContain('test_counter_total{label="b"} 3');
    expect(out).toContain("# TYPE test_counter_total counter");
  });

  it("increments with no labels", () => {
    const c = new Counter("bare_counter", "bare");
    c.inc();
    c.inc();
    const out = c.render();
    expect(out).toContain("bare_counter 2");
  });
});

// ── Gauge ─────────────────────────────────────────────────────────────────────

describe("Gauge", () => {
  it("sets value and renders correctly", () => {
    const g = new Gauge("test_gauge", "A test gauge");
    g.set({ status: "open" }, 2);
    g.set({ status: "closed" }, 0);
    const out = g.render();
    expect(out).toContain('test_gauge{status="open"} 2');
    expect(out).toContain('test_gauge{status="closed"} 0');
    expect(out).toContain("# TYPE test_gauge gauge");
  });

  it("overwrites previous value on set", () => {
    const g = new Gauge("overwrite_gauge", "overwrite");
    g.set({ x: "1" }, 5);
    g.set({ x: "1" }, 9);
    expect(g.render()).toContain('overwrite_gauge{x="1"} 9');
  });
});

// ── Histogram ─────────────────────────────────────────────────────────────────

describe("Histogram", () => {
  it("renders _bucket, _sum, _count lines", () => {
    const h = new Histogram("test_hist", "A test histogram", [0.1, 0.5, 1]);
    h.observe({ method: "GET" }, 0.05);
    h.observe({ method: "GET" }, 0.3);
    h.observe({ method: "GET" }, 2.0);
    const out = h.render();
    expect(out).toContain("# TYPE test_hist histogram");
    expect(out).toContain('test_hist_bucket{method="GET",le="0.1"} 1');
    expect(out).toContain('test_hist_bucket{method="GET",le="0.5"} 2');
    expect(out).toContain('test_hist_bucket{method="GET",le="1"} 2');
    expect(out).toContain('test_hist_bucket{method="GET",le="+Inf"} 3');
    expect(out).toContain('test_hist_count{method="GET"} 3');
  });

  it("sums observations correctly", () => {
    const h = new Histogram("sum_hist", "sum test", [1, 10]);
    h.observe({}, 3);
    h.observe({}, 7);
    const out = h.render();
    expect(out).toContain("sum_hist_sum 10");
  });
});

// ── MetricsRegistry ───────────────────────────────────────────────────────────

describe("MetricsRegistry", () => {
  it("renders all registered metrics", () => {
    const r = new MetricsRegistry();
    const c = r.register(new Counter("reg_counter", "help"));
    const g = r.register(new Gauge("reg_gauge", "help"));
    c.inc({}, 5);
    g.set({}, 3);
    const out = r.render();
    expect(out).toContain("reg_counter 5");
    expect(out).toContain("reg_gauge 3");
  });

  it("ends with a newline", () => {
    const r = new MetricsRegistry();
    r.register(new Counter("nl_counter", "nl"));
    expect(r.render().endsWith("\n")).toBe(true);
  });
});

// ── Endpoint integration ──────────────────────────────────────────────────────

describe("/metrics endpoint", () => {
  it("returns 200 with correct content-type when enabled", async () => {
    const app = express();
    app.use(express.json());
    metricsRoutes(app);

    const server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const port = (server.address() as { port: number }).port;

    const response = await fetch(`http://localhost:${port}/metrics`, { headers: AUTH_HEADER });
    await new Promise<void>((resolve) => server.close(() => resolve()));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/plain");
    expect(response.headers.get("content-type")).toContain("version=0.0.4");
  });

  it("returns 404 when metricsEnabled is false", async () => {
    const configMod = await import("../../config.js");
    (configMod.config as Record<string, unknown>).metricsEnabled = false;

    const app2 = express();
    app2.use(express.json());
    metricsRoutes(app2);

    const server2 = createServer(app2);
    await new Promise<void>((resolve) => server2.listen(0, resolve));
    const port2 = (server2.address() as { port: number }).port;

    const response2 = await fetch(`http://localhost:${port2}/metrics`, { headers: AUTH_HEADER });
    await new Promise<void>((resolve) => server2.close(() => resolve()));

    expect(response2.status).toBe(404);

    // Restore
    (configMod.config as Record<string, unknown>).metricsEnabled = true;
  });
});
