import { describe, expect, it, beforeEach } from "vitest";
import { nextTick } from "vue";
import { useDashboardLayout } from "../useDashboardLayout";
import { CATALOG_PRESETS, defaultLayout } from "@/components/overview/widgetCatalog";

const STORAGE_KEY = "mcpbridge:overview:dashboard";
const notePreset = CATALOG_PRESETS.find((p) => p.key === "note")!;

beforeEach(() => localStorage.clear());

describe("useDashboardLayout — defaults & mutations", () => {
  it("seeds the default layout when storage is empty", () => {
    const { widgets } = useDashboardLayout();
    expect(widgets.value).toHaveLength(defaultLayout().length);
  });

  it("adds a preset and returns its new id", () => {
    const { widgets, addPreset } = useDashboardLayout();
    const before = widgets.value.length;
    const id = addPreset(notePreset);
    expect(widgets.value).toHaveLength(before + 1);
    expect(widgets.value.some((w) => w.id === id)).toBe(true);
  });

  it("removes a widget by id", () => {
    const { widgets, remove } = useDashboardLayout();
    const id = widgets.value[0].id;
    remove(id);
    expect(widgets.value.some((w) => w.id === id)).toBe(false);
  });

  it("moves a widget up/down by swapping neighbors", () => {
    const { widgets, move } = useDashboardLayout();
    const [a, b] = [widgets.value[0].id, widgets.value[1].id];
    move(a, 1);
    expect(widgets.value[0].id).toBe(b);
    expect(widgets.value[1].id).toBe(a);
  });

  it("reorders a dragged widget into a target slot", () => {
    const { widgets, reorder } = useDashboardLayout();
    const first = widgets.value[0].id;
    const third = widgets.value[2].id;
    reorder(first, third);
    expect(widgets.value.findIndex((w) => w.id === first)).toBe(2);
  });

  it("clamps resize to the grid bounds", () => {
    const { widgets, resize } = useDashboardLayout();
    const id = widgets.value[0].id;
    resize(id, 99, 0);
    const w = widgets.value.find((x) => x.id === id)!;
    expect(w.w).toBe(12);
    expect(w.h).toBe(1);
  });

  it("configure replaces a widget's options", () => {
    const { widgets, configure } = useDashboardLayout();
    const id = widgets.value[0].id;
    configure(id, { title: "Renamed", metric: "tools.total" });
    expect(widgets.value.find((x) => x.id === id)!.options.title).toBe("Renamed");
  });

  it("resetToDefault restores the seeded layout", () => {
    const { widgets, remove, resetToDefault } = useDashboardLayout();
    widgets.value.slice().forEach((w) => remove(w.id));
    expect(widgets.value).toHaveLength(0);
    resetToDefault();
    expect(widgets.value).toHaveLength(defaultLayout().length);
  });
});

describe("useDashboardLayout — persistence & self-healing", () => {
  it("persists changes and reloads them in a fresh instance", async () => {
    const first = useDashboardLayout();
    const id = first.addPreset(notePreset);
    await nextTick(); // let the deep watcher flush to localStorage
    const second = useDashboardLayout();
    expect(second.widgets.value.some((w) => w.id === id)).toBe(true);
  });

  it("preserves a valid-but-empty board (no silent re-seed)", () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, widgets: [] }));
    expect(useDashboardLayout().widgets.value).toHaveLength(0);
  });

  it("falls back to the default layout on a corrupt blob", () => {
    localStorage.setItem(STORAGE_KEY, "{ not json");
    expect(useDashboardLayout().widgets.value).toHaveLength(defaultLayout().length);
  });

  it("drops invalid widget entries but keeps valid ones", () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        version: 1,
        widgets: [
          { id: "ok", type: "stat", w: 3, h: 1, options: { title: "Good", metric: "clients.live" } },
          { id: "bad", type: "not-a-viz", w: 3, h: 1, options: {} },
          { nope: true },
        ],
      }),
    );
    const { widgets } = useDashboardLayout();
    expect(widgets.value).toHaveLength(1);
    expect(widgets.value[0].id).toBe("ok");
  });

  it("coerces out-of-range spans and a missing title on load", () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ version: 1, widgets: [{ id: "x", type: "stat", w: 99, h: -3, options: {} }] }),
    );
    const w = useDashboardLayout().widgets.value[0];
    expect(w.w).toBe(12);
    expect(w.h).toBe(1);
    expect(w.options.title).toBe("Widget");
  });
});

describe("useDashboardLayout — export/import", () => {
  it("round-trips through export/import JSON", () => {
    const a = useDashboardLayout();
    a.remove(a.widgets.value[0].id);
    const json = a.exportJson();

    const b = useDashboardLayout(); // fresh (default) board
    b.importJson(json);
    expect(b.widgets.value).toHaveLength(defaultLayout().length - 1);
  });

  it("throws on structurally-invalid import", () => {
    const { importJson } = useDashboardLayout();
    expect(() => importJson("[]")).toThrow();
    expect(() => importJson(JSON.stringify({ widgets: [{ bogus: 1 }] }))).toThrow();
  });
});
