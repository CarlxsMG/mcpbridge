<script setup lang="ts">
import { computed, type Component } from "vue";
import { GripVertical, ChevronUp, ChevronDown, Settings2, X } from "lucide-vue-next";
import StatWidget from "./StatWidget.vue";
import TimeSeriesWidget from "./TimeSeriesWidget.vue";
import DonutWidget from "./DonutWidget.vue";
import BarsWidget from "./BarsWidget.vue";
import ListWidget from "./ListWidget.vue";
import NoteWidget from "./NoteWidget.vue";
import type { DashboardStores, WidgetInstance, WidgetViz } from "./widgetCatalog";

const props = defineProps<{
  widget: WidgetInstance;
  stores: DashboardStores;
  editing: boolean;
  isFirst: boolean;
  isLast: boolean;
  dragging: boolean;
}>();

const emit = defineEmits<{
  configure: [];
  remove: [];
  move: [dir: -1 | 1];
  "pointerdown-drag": [e: PointerEvent];
  "pointerdown-resize": [e: PointerEvent];
}>();

const RENDERERS: Record<WidgetViz, Component> = {
  stat: StatWidget,
  timeseries: TimeSeriesWidget,
  donut: DonutWidget,
  bars: BarsWidget,
  list: ListWidget,
  note: NoteWidget,
};

const renderer = computed(() => RENDERERS[props.widget.type]);
// NoteWidget doesn't take `stores`; only pass it to data-bound renderers so it
// doesn't fall through as a stray DOM attribute.
const rendererProps = computed(() =>
  props.widget.type === "note" ? { widget: props.widget } : { widget: props.widget, stores: props.stores },
);
</script>

<template>
  <div
    class="w-frame"
    :class="{ editing, dragging }"
    :data-widget-id="widget.id"
    :style="{ gridColumn: `span ${widget.w}`, gridRow: `span ${widget.h}` }"
  >
    <div class="w-frame-inner">
      <component :is="renderer" v-bind="rendererProps" />
    </div>

    <div v-if="editing" class="w-controls">
      <button
        type="button"
        class="w-btn w-grip"
        title="Drag to move"
        aria-label="Drag to move"
        @pointerdown="emit('pointerdown-drag', $event)"
      >
        <GripVertical :size="14" stroke-width="2" aria-hidden="true" />
      </button>
      <button
        type="button"
        class="w-btn"
        title="Move earlier"
        aria-label="Move earlier"
        :disabled="isFirst"
        @click="emit('move', -1)"
      >
        <ChevronUp :size="14" stroke-width="2" aria-hidden="true" />
      </button>
      <button
        type="button"
        class="w-btn"
        title="Move later"
        aria-label="Move later"
        :disabled="isLast"
        @click="emit('move', 1)"
      >
        <ChevronDown :size="14" stroke-width="2" aria-hidden="true" />
      </button>
      <button type="button" class="w-btn" title="Configure" aria-label="Configure widget" @click="emit('configure')">
        <Settings2 :size="14" stroke-width="2" aria-hidden="true" />
      </button>
      <button type="button" class="w-btn w-remove" title="Remove" aria-label="Remove widget" @click="emit('remove')">
        <X :size="14" stroke-width="2" aria-hidden="true" />
      </button>
    </div>

    <button
      v-if="editing"
      type="button"
      class="w-resize"
      title="Drag to resize"
      aria-label="Resize widget (use Configure for keyboard sizing)"
      @pointerdown="emit('pointerdown-resize', $event)"
    />
  </div>
</template>

<style scoped>
.w-frame {
  position: relative;
  min-height: 0;
  min-width: 0;
}
.w-frame-inner {
  height: 100%;
  min-height: 0;
}
.w-frame.editing {
  outline: 1px dashed var(--border-strong);
  outline-offset: 2px;
  border-radius: var(--radius-md);
}
.w-frame.editing .w-frame-inner {
  /* keep the underlying chart from stealing the drag/hover while arranging */
  pointer-events: none;
}
.w-frame.dragging {
  opacity: 0.55;
  z-index: 2;
}
.w-controls {
  position: absolute;
  top: var(--space-2);
  right: var(--space-2);
  display: flex;
  align-items: center;
  gap: var(--space-1);
  padding: var(--space-1);
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  box-shadow: var(--shadow-sm);
  z-index: 3;
}
.w-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 1.5rem;
  height: 1.5rem;
  padding: 0;
  background: none;
  border: none;
  border-radius: var(--radius-sm);
  color: var(--text-muted);
  cursor: pointer;
}
.w-btn:hover:not(:disabled) {
  background: var(--signal-soft);
  color: var(--signal-strong);
}
.w-btn:disabled {
  opacity: 0.35;
  cursor: not-allowed;
}
.w-grip {
  cursor: grab;
  touch-action: none;
}
.w-remove:hover:not(:disabled) {
  background: var(--breach-soft);
  color: var(--breach);
}
.w-resize {
  position: absolute;
  right: 0;
  bottom: 0;
  width: 1.25rem;
  height: 1.25rem;
  padding: 0;
  background: none;
  border: none;
  cursor: nwse-resize;
  touch-action: none;
  z-index: 3;
}
/* a small corner grip drawn with two token-colored lines */
.w-resize::after {
  content: "";
  position: absolute;
  right: 4px;
  bottom: 4px;
  width: 0.55rem;
  height: 0.55rem;
  border-right: 2px solid var(--border-strong);
  border-bottom: 2px solid var(--border-strong);
  border-bottom-right-radius: 3px;
}
.w-resize:hover::after {
  border-color: var(--signal);
}
</style>
