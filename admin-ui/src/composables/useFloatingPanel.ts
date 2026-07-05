import { ref, nextTick, type Ref } from "vue";

// Kept clear of the viewport edge on all sides. Exported so a caller's own
// `placement` callback can reason about the same edges (e.g. to check
// whether the panel's real height still fits above/below).
export const FLOATING_PANEL_MARGIN = 8;

export type VerticalPlacement = { top: number } | { bottom: number };

export interface FloatingPanelOptions {
  /** Match the panel's min-width to the trigger's width (e.g. a select). */
  matchTriggerWidth?: boolean;
  /**
   * Decides top/bottom placement in px. Called once before the panel has
   * rendered (`panelRect` is null) to produce an initial guess, then again
   * once it has rendered at that guess so the placement can be refined
   * against its real height. Return the same result regardless of
   * `panelRect` to decide purely from `rect` up front (SelectMenu's
   * spaceBelow heuristic); read `panelRect` to flip based on the measured
   * height instead (HoverPreview).
   */
  placement: (rect: DOMRect, panelRect: DOMRect | null) => VerticalPlacement;
}

// Shared anchor-a-teleported-panel-to-a-trigger engine for SelectMenu and
// HoverPreview: fixed-position the panel off the trigger's own rect, cap its
// size so it can never overflow the viewport, then measure what it actually
// rendered at and slide it back on-screen if it grew past an edge.
export function useFloatingPanel(
  triggerRef: Ref<HTMLElement | null>,
  panelRef: Ref<HTMLElement | null>,
  options: FloatingPanelOptions,
) {
  const isOpen = ref(false);
  const style = ref<Record<string, string>>({});

  function baseStyle(rect: DOMRect): Record<string, string> {
    return {
      position: "fixed",
      left: `${rect.left}px`,
      maxWidth: `min(24rem, calc(100vw - ${FLOATING_PANEL_MARGIN * 2}px))`,
      maxHeight: "16rem",
      ...(options.matchTriggerWidth ? { minWidth: `${rect.width}px` } : {}),
    };
  }

  function verticalStyle(placement: VerticalPlacement): Record<string, string> {
    return "top" in placement ? { top: `${placement.top}px` } : { bottom: `${placement.bottom}px` };
  }

  // Two-pass: place the panel off the trigger alone first (a guess, for
  // placements that need the panel's real height to decide), then measure
  // what it actually rendered at, refine the placement from that, and slide
  // `left` back if it grew past the right edge of the viewport.
  async function reposition() {
    const rect = triggerRef.value?.getBoundingClientRect();
    if (!rect) return;
    style.value = { ...baseStyle(rect), ...verticalStyle(options.placement(rect, null)) };
    await nextTick();

    const panelRect = panelRef.value?.getBoundingClientRect();
    if (!panelRect) return;
    style.value = { ...baseStyle(rect), ...verticalStyle(options.placement(rect, panelRect)) };
    if (panelRect.right > window.innerWidth - FLOATING_PANEL_MARGIN) {
      style.value = {
        ...style.value,
        left: `${Math.max(FLOATING_PANEL_MARGIN, window.innerWidth - FLOATING_PANEL_MARGIN - panelRect.width)}px`,
      };
    }
  }

  function onScrollOrResize(e: Event) {
    // Scroll events don't bubble, but a capture-phase listener on window
    // still sees them — including the panel's own internal scrolling (it may
    // have overflow-y: auto). That's normal interaction, not the page moving
    // out from under the trigger, so don't close for it. Repositioning a
    // teleported panel mid-scroll of an *ancestor* is fiddly to get
    // pixel-perfect; closing (like a native select effectively does when the
    // anchor moves) is simpler and avoids a panel that drifts from its trigger.
    if (e.type === "scroll" && e.target instanceof Node && panelRef.value?.contains(e.target)) return;
    close();
  }

  async function open() {
    isOpen.value = true;
    await nextTick();
    await reposition();
    window.addEventListener("scroll", onScrollOrResize, true);
    window.addEventListener("resize", onScrollOrResize);
  }

  function close() {
    if (!isOpen.value) return;
    isOpen.value = false;
    window.removeEventListener("scroll", onScrollOrResize, true);
    window.removeEventListener("resize", onScrollOrResize);
  }

  return { isOpen, style, open, close, reposition };
}
