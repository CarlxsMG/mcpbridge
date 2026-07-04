// Persisted, self-healing layout state for the Overview dashboard.
//
// Modeled on OverviewPage's original `readStoredCards`/`persist`/`watch(...,
// {deep:true})` pattern (the app's canonical localStorage-JSON-blob approach —
// see also useTheme.ts/useDensity.ts for the key convention), generalized from
// "4 fixed cards" to "an arbitrary list of widget instances".
//
// A corrupt/partial blob self-heals: each widget is validated and coerced, and
// an unreadable blob falls back to the seeded default layout. An empty-but-valid
// blob (the user removed every widget) is preserved as-is — "Reset to default"
// is the explicit way back, not a silent re-seed.

import { ref, watch, type Ref } from "vue";
import {
  defaultLayout,
  GRID_COLUMNS,
  MAX_H,
  type WidgetInstance,
  type WidgetOptions,
  type WidgetPreset,
  type WidgetViz,
} from "@/components/overview/widgetCatalog";

const STORAGE_KEY = "mcpbridge:overview:dashboard";
const SCHEMA_VERSION = 1;
const VALID_VIZ: WidgetViz[] = ["stat", "timeseries", "donut", "bars", "list", "note"];

function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  const n = typeof v === "number" && Number.isFinite(v) ? Math.round(v) : fallback;
  return Math.min(Math.max(n, min), max);
}

/** Coerce one raw entry into a well-formed WidgetInstance, or drop it (null). */
function validateWidget(raw: unknown): WidgetInstance | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "string" || !VALID_VIZ.includes(r.type as WidgetViz)) return null;
  const rawOptions = (r.options && typeof r.options === "object" ? r.options : {}) as unknown as WidgetOptions;
  const options: WidgetOptions = {
    ...rawOptions,
    title: typeof rawOptions.title === "string" ? rawOptions.title : "Widget",
  };
  return {
    id: r.id,
    type: r.type as WidgetViz,
    w: clampInt(r.w, 1, GRID_COLUMNS, 3),
    h: clampInt(r.h, 1, MAX_H, 1),
    options,
  };
}

function readStored(): WidgetInstance[] {
  let raw: string | null;
  try {
    raw = localStorage.getItem(STORAGE_KEY);
  } catch {
    return defaultLayout();
  }
  if (!raw) return defaultLayout();
  try {
    const parsed = JSON.parse(raw) as { widgets?: unknown };
    if (!Array.isArray(parsed.widgets)) return defaultLayout();
    // A valid-but-empty board is a legitimate user choice; keep it.
    return parsed.widgets.map(validateWidget).filter((w): w is WidgetInstance => w !== null);
  } catch {
    return defaultLayout();
  }
}

export function useDashboardLayout() {
  const widgets = ref<WidgetInstance[]>(readStored()) as Ref<WidgetInstance[]>;

  function persist(): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: SCHEMA_VERSION, widgets: widgets.value }));
    } catch {
      // Storage full / disabled (private mode) — layout still works in-memory.
    }
  }
  watch(widgets, persist, { deep: true });

  function indexOf(id: string): number {
    return widgets.value.findIndex((w) => w.id === id);
  }

  /** Append a preset's fresh instance; returns the new widget's id. */
  function addPreset(preset: WidgetPreset): string {
    const inst = preset.create();
    widgets.value = [...widgets.value, inst];
    return inst.id;
  }

  function remove(id: string): void {
    widgets.value = widgets.value.filter((w) => w.id !== id);
  }

  /** Swap with the adjacent widget (keyboard/button reorder). */
  function move(id: string, direction: -1 | 1): void {
    const idx = indexOf(id);
    const swap = idx + direction;
    if (idx < 0 || swap < 0 || swap >= widgets.value.length) return;
    const next = [...widgets.value];
    [next[idx], next[swap]] = [next[swap], next[idx]];
    widgets.value = next;
  }

  /** Move `draggedId` to occupy `targetId`'s slot (pointer drag reorder). */
  function reorder(draggedId: string, targetId: string): void {
    if (draggedId === targetId) return;
    const from = indexOf(draggedId);
    const to = indexOf(targetId);
    if (from < 0 || to < 0) return;
    const next = [...widgets.value];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    widgets.value = next;
  }

  function resize(id: string, w: number, h: number): void {
    const idx = indexOf(id);
    if (idx < 0) return;
    const next = [...widgets.value];
    next[idx] = { ...next[idx], w: clampInt(w, 1, GRID_COLUMNS, next[idx].w), h: clampInt(h, 1, MAX_H, next[idx].h) };
    widgets.value = next;
  }

  function setW(id: string, delta: number): void {
    const w = widgets.value[indexOf(id)];
    if (w) resize(id, w.w + delta, w.h);
  }
  function setH(id: string, delta: number): void {
    const w = widgets.value[indexOf(id)];
    if (w) resize(id, w.w, w.h + delta);
  }

  function configure(id: string, options: WidgetOptions): void {
    const idx = indexOf(id);
    if (idx < 0) return;
    const next = [...widgets.value];
    next[idx] = { ...next[idx], options: { ...options } };
    widgets.value = next;
  }

  function resetToDefault(): void {
    widgets.value = defaultLayout();
  }

  function exportJson(): string {
    return JSON.stringify({ version: SCHEMA_VERSION, widgets: widgets.value }, null, 2);
  }

  /** Replace the board from an exported blob. Throws on unusable input. */
  function importJson(text: string): void {
    const parsed = JSON.parse(text) as { widgets?: unknown };
    if (!Array.isArray(parsed.widgets)) throw new Error("Expected a { widgets: [...] } object.");
    const valid = parsed.widgets.map(validateWidget).filter((w): w is WidgetInstance => w !== null);
    if (valid.length === 0) throw new Error("No valid widgets found in the imported layout.");
    widgets.value = valid;
  }

  return {
    widgets,
    addPreset,
    remove,
    move,
    reorder,
    resize,
    setW,
    setH,
    configure,
    resetToDefault,
    exportJson,
    importJson,
  };
}
