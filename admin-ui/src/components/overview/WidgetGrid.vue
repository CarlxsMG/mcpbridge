<script setup lang="ts">
// The 12-column dashboard grid. Owns the hand-rolled pointer gestures
// (drag-to-reorder, corner-resize) because they need the grid's geometry and
// the sibling frames; it emits SEMANTIC events (reorder/resize/move/…) and the
// page wires them to `useDashboardLayout`. Keyboard-accessible reorder/resize
// lives in WidgetFrame's buttons + the config dialog, so the pointer paths here
// are an enhancement, not the only way.
import { ref, onBeforeUnmount } from "vue";
import WidgetFrame from "./WidgetFrame.vue";
import { GRID_COLUMNS, type DashboardStores, type WidgetInstance } from "./widgetCatalog";

const props = defineProps<{ widgets: WidgetInstance[]; stores: DashboardStores; editing: boolean }>();
const emit = defineEmits<{
  configure: [id: string];
  remove: [id: string];
  move: [id: string, dir: -1 | 1];
  reorder: [draggedId: string, targetId: string];
  resize: [id: string, w: number, h: number];
}>();

const gridEl = ref<HTMLElement | null>(null);
const draggingId = ref<string | null>(null);

// Keep these in sync with the CSS below (grid-auto-rows min / gap). Read as rem
// so the large-screen root font-size ramp is accounted for when converting to px.
const ROW_REM = 6;
const GAP_REM = 1;
function remToPx(rem: number): number {
  const fs = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
  return rem * fs;
}

/* ---- drag to reorder ---- */
function onDragStart(e: PointerEvent, id: string): void {
  if (!props.editing) return;
  e.preventDefault();
  draggingId.value = id;
  window.addEventListener("pointermove", onDragMove);
  window.addEventListener("pointerup", onDragEnd, { once: true });
}
function onDragMove(e: PointerEvent): void {
  const id = draggingId.value;
  if (!id) return;
  const el = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null;
  const frame = el?.closest("[data-widget-id]") as HTMLElement | null;
  const targetId = frame?.dataset.widgetId;
  if (targetId && targetId !== id) emit("reorder", id, targetId);
}
function onDragEnd(): void {
  draggingId.value = null;
  window.removeEventListener("pointermove", onDragMove);
}

/* ---- drag corner to resize (snaps to grid cells) ---- */
let resizeState: { id: string; startX: number; startY: number; startW: number; startH: number } | null = null;
function onResizeStart(e: PointerEvent, w: WidgetInstance): void {
  if (!props.editing) return;
  e.preventDefault();
  resizeState = { id: w.id, startX: e.clientX, startY: e.clientY, startW: w.w, startH: w.h };
  window.addEventListener("pointermove", onResizeMove);
  window.addEventListener("pointerup", onResizeEnd, { once: true });
}
function onResizeMove(e: PointerEvent): void {
  if (!resizeState || !gridEl.value) return;
  const gapPx = remToPx(GAP_REM);
  const colUnit = (gridEl.value.clientWidth - (GRID_COLUMNS - 1) * gapPx) / GRID_COLUMNS + gapPx;
  const rowUnit = remToPx(ROW_REM) + gapPx;
  const dW = Math.round((e.clientX - resizeState.startX) / colUnit);
  const dH = Math.round((e.clientY - resizeState.startY) / rowUnit);
  emit("resize", resizeState.id, resizeState.startW + dW, resizeState.startH + dH);
}
function onResizeEnd(): void {
  resizeState = null;
  window.removeEventListener("pointermove", onResizeMove);
}

onBeforeUnmount(() => {
  window.removeEventListener("pointermove", onDragMove);
  window.removeEventListener("pointermove", onResizeMove);
});
</script>

<template>
  <div ref="gridEl" class="w-grid" :class="{ editing }">
    <WidgetFrame
      v-for="(w, i) in widgets"
      :key="w.id"
      :widget="w"
      :stores="stores"
      :editing="editing"
      :is-first="i === 0"
      :is-last="i === widgets.length - 1"
      :dragging="draggingId === w.id"
      @configure="emit('configure', w.id)"
      @remove="emit('remove', w.id)"
      @move="(dir) => emit('move', w.id, dir)"
      @pointerdown-drag="(e) => onDragStart(e, w.id)"
      @pointerdown-resize="(e) => onResizeStart(e, w)"
    />
  </div>
</template>

<style scoped>
.w-grid {
  display: grid;
  grid-template-columns: repeat(12, minmax(0, 1fr));
  /* `h` sets a MINIMUM row height; tracks grow to fit taller content so a widget
     never clips or shows a scrollbar. Min keep in sync with ROW_REM above. */
  grid-auto-rows: minmax(6rem, auto);
  grid-auto-flow: row dense;
  gap: 1rem; /* keep in sync with GAP_REM above */
}

/* Tablet range: drop to 6 columns so stats sit two-per-row and wide widgets
   (span 8/12) clamp to full width, instead of the 12-col grid getting cramped. */
@media (max-width: 64rem) {
  .w-grid {
    grid-template-columns: repeat(6, minmax(0, 1fr));
  }
}

/* Stack into a single content-height column on small screens. `!important`
   overrides the per-frame inline `grid-column/grid-row: span N`. */
@media (max-width: 40rem) {
  .w-grid {
    grid-template-columns: 1fr;
    grid-auto-rows: auto;
  }
  .w-grid > * {
    grid-column: 1 / -1 !important;
    grid-row: auto !important;
  }
}
</style>
