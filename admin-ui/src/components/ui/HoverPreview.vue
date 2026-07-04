<script setup lang="ts">
import { ref, computed, nextTick, onMounted, onBeforeUnmount, useSlots } from "vue";
import { Copy, Check } from "lucide-vue-next";
import { useClipboard } from "@/composables/useClipboard";

const props = defineProps<{
  /** Plain-text panel content. Ignored when the `content` slot is provided. */
  text?: string;
  /** Monospace font for the panel — use for URLs, JSON, or other code-ish values. */
  mono?: boolean;
  /** Show the panel on hover even when the trigger itself isn't visually truncated —
   * for a short summary (e.g. "2 client(s), 1 tool(s)") that always hides more detail behind it. */
  alwaysShow?: boolean;
  /** Skip making the trigger span itself a tab stop — use when the default slot already
   * contains its own focusable element (e.g. a button), so there isn't a redundant second
   * stop for the same control. The panel still opens on focus/blur of that descendant,
   * since focus is tracked via the bubbling focusin/focusout events. */
  noTabindex?: boolean;
}>();

const slots = useSlots();
const { copied, copy: copyToClipboard, reset: resetCopied } = useClipboard();

const triggerEl = ref<HTMLElement | null>(null);
const panelEl = ref<HTMLElement | null>(null);
const contentEl = ref<HTMLElement | null>(null);
const visible = ref(false);
const hasOverflow = ref(false);
const panelStyle = ref<Record<string, string>>({});
const uid = Math.random().toString(36).slice(2, 9);
const panelId = `hover-preview-${uid}`;

const shouldPreview = computed(() => props.alwaysShow || hasOverflow.value);
const hasContent = computed(() => !!slots.content || !!props.text);

const MARGIN = 8;
const SHOW_DELAY = 120;
// The trigger and panel are disjoint in the DOM (Teleport moves the panel to
// <body>), so moving the mouse from one to the other crosses a gap that
// belongs to neither — a plain mouseleave-closes-immediately handler would
// dismiss the panel before the cursor ever reaches it. Closing on a short
// delay instead, cancelled by re-entering either element, gives the cursor
// room to cross that gap (this is what makes the copy button reachable).
// 150ms measured too tight in practice — the copy button can sit a fair
// distance from a small trigger (e.g. AuditLogPage's "View"), and a real
// mouse crossing that gap (plus the reaction time to notice the panel and
// aim for the button) routinely takes longer than that, closing the panel
// out from under the cursor before the click lands.
const HIDE_DELAY = 350;
let showTimer: ReturnType<typeof setTimeout> | undefined;
let hideTimer: ReturnType<typeof setTimeout> | undefined;

function checkOverflow() {
  const el = triggerEl.value;
  hasOverflow.value = !!el && el.scrollWidth > el.clientWidth;
}

let resizeObserver: ResizeObserver | undefined;
onMounted(() => {
  checkOverflow();
  resizeObserver = new ResizeObserver(checkOverflow);
  if (triggerEl.value) resizeObserver.observe(triggerEl.value);
});

const GAP = 6;

function baseStyle(left: number): Record<string, string> {
  return {
    position: "fixed",
    left: `${left}px`,
    maxWidth: `min(24rem, calc(100vw - ${MARGIN * 2}px))`,
    maxHeight: "16rem",
  };
}

// Two-pass, mirroring SelectMenu.vue: render below the trigger first purely
// to measure the real height (max-height: 16rem is a cap, not the actual
// height — short content renders far smaller, so guessing a side up front
// from available space alone isn't reliable), then decide the real side from
// that measurement and re-render. Vertically: use below whenever it fits
// (the natural default), flip above when below doesn't fit but above does,
// or clamp fully on-screen (may then overlap the trigger) if neither side
// has room for the real height. Horizontally: slide `left` back if it ran
// past the right edge — mirrors SelectMenu.vue's own clamp.
async function updatePosition() {
  const rect = triggerEl.value?.getBoundingClientRect();
  if (!rect) return;

  panelStyle.value = { ...baseStyle(rect.left), top: `${rect.bottom + GAP}px` };
  await nextTick();

  const panelRect = panelEl.value?.getBoundingClientRect();
  if (!panelRect) return;

  const fitsBelow = rect.bottom + GAP + panelRect.height <= window.innerHeight - MARGIN;
  const fitsAbove = rect.top - GAP - panelRect.height >= MARGIN;

  let verticalStyle: Record<string, string>;
  if (fitsBelow || !fitsAbove) {
    // Prefer below when it fits; when neither side fits, clamp below's top
    // so the bottom edge stays on-screen instead of running past it.
    const top = fitsBelow ? rect.bottom + GAP : Math.max(MARGIN, window.innerHeight - MARGIN - panelRect.height);
    verticalStyle = { top: `${top}px` };
  } else {
    verticalStyle = { bottom: `${window.innerHeight - rect.top + GAP}px` };
  }

  const left =
    panelRect.right > window.innerWidth - MARGIN
      ? Math.max(MARGIN, window.innerWidth - MARGIN - panelRect.width)
      : rect.left;

  panelStyle.value = { ...baseStyle(left), ...verticalStyle };
}

function onScrollOrResize(e: Event) {
  // Ignore the panel's own internal scrolling (long content, overflow-y: auto)
  // — only close for the page moving out from under the trigger.
  if (e.type === "scroll" && e.target instanceof Node && panelEl.value?.contains(e.target)) return;
  close();
}

function cancelHide() {
  clearTimeout(hideTimer);
}

function scheduleShow() {
  cancelHide();
  if (!shouldPreview.value || !hasContent.value) return;
  clearTimeout(showTimer);
  showTimer = setTimeout(async () => {
    visible.value = true;
    await nextTick();
    await updatePosition();
    window.addEventListener("scroll", onScrollOrResize, true);
    window.addEventListener("resize", onScrollOrResize);
  }, SHOW_DELAY);
}

function scheduleHide() {
  clearTimeout(hideTimer);
  hideTimer = setTimeout(close, HIDE_DELAY);
}

// Keyboard/a11y path: the panel is disjoint from the trigger in the DOM, so a
// Tab from the trigger into the panel's own copy button fires a genuine
// focusout — only actually schedule a close if focus didn't just land inside
// the panel. Bound to focusout (not blur) so this also fires when a
// focusable descendant of the trigger (e.g. a wrapped button, with
// noTabindex) loses focus, not just the trigger span itself.
function onTriggerFocusOut(e: FocusEvent) {
  const next = e.relatedTarget as Node | null;
  if (next && panelEl.value?.contains(next)) return;
  scheduleHide();
}

function onPanelFocusOut(e: FocusEvent) {
  const next = e.relatedTarget as Node | null;
  if (next && (panelEl.value?.contains(next) || triggerEl.value?.contains(next))) return;
  scheduleHide();
}

function close() {
  clearTimeout(showTimer);
  clearTimeout(hideTimer);
  if (!visible.value) return;
  visible.value = false;
  resetCopied();
  window.removeEventListener("scroll", onScrollOrResize, true);
  window.removeEventListener("resize", onScrollOrResize);
}

async function copyPanelText() {
  // textContent, not innerText — innerText is layout-dependent (and jsdom
  // doesn't compute layout, so it'd always read back empty in tests), and
  // this panel's content is always plain text/simple markup with nothing
  // hidden, so the two would read identically in a real browser anyway.
  const value = slots.content ? (contentEl.value?.textContent ?? "") : (props.text ?? "");
  await copyToClipboard(value);
}

onBeforeUnmount(() => {
  resizeObserver?.disconnect();
  close();
});
</script>

<template>
  <span
    ref="triggerEl"
    class="hover-preview-trigger"
    :class="{ 'has-preview': !noTabindex && shouldPreview && hasContent }"
    :tabindex="!noTabindex && shouldPreview && hasContent ? 0 : undefined"
    :aria-describedby="!noTabindex && visible ? panelId : undefined"
    @mouseenter="scheduleShow"
    @mouseleave="scheduleHide"
    @focusin="scheduleShow"
    @focusout="onTriggerFocusOut"
  >
    <!-- panelId/visible are exposed for callers wrapping their own focusable
         element (noTabindex) to wire aria-describedby onto that real control
         instead of this non-focusable span. -->
    <slot :panel-id="panelId" :visible="visible" />
    <!-- Teleport nested here (rather than as a sibling root) keeps this
         component single-root, so a parent's scoped class (e.g. desc-cell,
         cell-truncate) landing on this span via Vue's fallthrough-attrs also
         gets the parent's own scope-id attribute stamped onto it — without
         that, the parent's scoped CSS selector could never match this span
         at all, regardless of the class name being present. Teleport itself
         still renders its content into <body>, unaffected by this nesting. -->
    <Teleport to="body">
      <div
        v-if="visible"
        :id="panelId"
        ref="panelEl"
        class="hover-preview-panel"
        :class="{ mono }"
        :style="panelStyle"
        @mouseenter="cancelHide"
        @mouseleave="scheduleHide"
        @focusout="onPanelFocusOut"
      >
        <div ref="contentEl">
          <slot name="content">{{ text }}</slot>
        </div>
        <button
          type="button"
          class="hover-preview-copy"
          :aria-label="copied ? 'Copied' : 'Copy'"
          :title="copied ? 'Copied' : 'Copy'"
          @click="copyPanelText"
        >
          <Check v-if="copied" :size="13" stroke-width="2" aria-hidden="true" />
          <Copy v-else :size="13" stroke-width="2" aria-hidden="true" />
        </button>
      </div>
    </Teleport>
  </span>
</template>

<style scoped>
.hover-preview-trigger {
  /* No max-width here on purpose — it'd tie in CSS specificity with a
     caller's own scoped max-width class (both are a single scoped class
     selector) and the winner would depend on arbitrary bundle order. Callers
     supply their own max-width class (e.g. desc-cell, url-cell,
     cell-truncate), same as the old per-page truncate pattern. */
  display: inline-block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  vertical-align: middle;
}
.hover-preview-trigger.has-preview {
  cursor: help;
  text-decoration: underline dotted var(--text-muted);
  text-underline-offset: 2px;
}
.hover-preview-trigger:focus-visible {
  outline: 2px solid var(--signal);
  outline-offset: 1px;
}
</style>

<style>
/* Unscoped: the panel is teleported to <body>, outside this component's
   scoped-attribute tree, so a `scoped` block here would never match it. */
.hover-preview-panel {
  position: relative;
  z-index: var(--z-tooltip);
  /* Extra right padding reserves a gutter for the absolutely-positioned copy
     button below, so wrapped text never runs under it. */
  padding: 0.55rem 1.9rem 0.55rem 0.75rem;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  box-shadow: var(--shadow-md);
  font-size: 0.82rem;
  line-height: 1.4;
  color: var(--text-primary);
  overflow-y: auto;
  white-space: pre-wrap;
  word-break: break-word;
}
.hover-preview-panel.mono {
  font-family: var(--font-mono);
}
.hover-preview-copy {
  position: absolute;
  top: 0.4rem;
  right: 0.4rem;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 1.4rem;
  height: 1.4rem;
  padding: 0;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
}
.hover-preview-copy:hover {
  background: var(--surface-sunken);
  color: var(--text-primary);
}
.hover-preview-copy:focus-visible {
  outline: 2px solid var(--signal);
  outline-offset: 1px;
}
</style>
