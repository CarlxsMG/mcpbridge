import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount, type VueWrapper } from "@vue/test-utils";
import HoverPreview from "../HoverPreview.vue";

const SHOW_DELAY = 120;
const HIDE_DELAY = 350;

let activeWrapper: VueWrapper | null = null;
let writeText: ReturnType<typeof vi.fn>;

function mountPreview(
  props: Record<string, unknown> = {},
  slots: Record<string, string> = { default: "Summary text" },
) {
  activeWrapper = mount(HoverPreview, {
    props,
    slots,
    attachTo: document.body,
  });
  return activeWrapper;
}

function panel() {
  return document.body.querySelector(".hover-preview-panel");
}

function copyButton() {
  return document.body.querySelector<HTMLButtonElement>(".hover-preview-copy");
}

beforeEach(() => {
  vi.useFakeTimers();
  writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText },
    configurable: true,
  });
});

afterEach(() => {
  activeWrapper?.unmount();
  activeWrapper = null;
  vi.useRealTimers();
});

describe("HoverPreview", () => {
  it("renders the default slot as the trigger content", () => {
    const wrapper = mountPreview({}, { default: "Truncated value" });

    expect(wrapper.find(".hover-preview-trigger").text()).toBe("Truncated value");
  });

  it("shows the teleported panel on mouseenter after the show delay when alwaysShow + text are set, and hides it (after the hide delay) on mouseleave", async () => {
    const wrapper = mountPreview({ alwaysShow: true, text: "Full detail text" }, { default: "Summary" });

    expect(panel()).toBeNull();

    await wrapper.find(".hover-preview-trigger").trigger("mouseenter");
    expect(panel()).toBeNull(); // delay hasn't elapsed yet

    await vi.advanceTimersByTimeAsync(SHOW_DELAY);
    const p = panel();
    expect(p).not.toBeNull();
    expect(p?.textContent).toBe("Full detail text");

    await wrapper.find(".hover-preview-trigger").trigger("mouseleave");
    expect(panel()).not.toBeNull(); // grace period — still visible immediately after leaving
    await vi.advanceTimersByTimeAsync(HIDE_DELAY);
    expect(panel()).toBeNull();
  });

  it("stays open when the cursor moves from the trigger onto the panel itself, closing only once it leaves the panel too", async () => {
    const wrapper = mountPreview({ alwaysShow: true, text: "Full detail text" }, { default: "Summary" });

    await wrapper.find(".hover-preview-trigger").trigger("mouseenter");
    await vi.advanceTimersByTimeAsync(SHOW_DELAY);
    expect(panel()).not.toBeNull();

    await wrapper.find(".hover-preview-trigger").trigger("mouseleave");
    panel()?.dispatchEvent(new Event("mouseenter"));
    await vi.advanceTimersByTimeAsync(HIDE_DELAY);
    expect(panel()).not.toBeNull(); // the panel's own mouseenter cancelled the pending close

    panel()?.dispatchEvent(new Event("mouseleave"));
    await vi.advanceTimersByTimeAsync(HIDE_DELAY);
    expect(panel()).toBeNull();
  });

  it("shows the teleported panel on mouseenter after the show delay when alwaysShow + a content slot are set", async () => {
    const wrapper = mountPreview(
      { alwaysShow: true },
      { default: "Summary", content: '<div class="rich">Rich <b>detail</b></div>' },
    );

    await wrapper.find(".hover-preview-trigger").trigger("mouseenter");
    await vi.advanceTimersByTimeAsync(SHOW_DELAY);

    const p = panel();
    expect(p).not.toBeNull();
    expect(p?.querySelector(".rich")).not.toBeNull();
  });

  it("does not show the panel on hover without alwaysShow, since jsdom reports no real overflow (scrollWidth === clientWidth === 0)", async () => {
    const wrapper = mountPreview({ text: "Full detail text" }, { default: "Summary" });

    await wrapper.find(".hover-preview-trigger").trigger("mouseenter");
    await vi.advanceTimersByTimeAsync(SHOW_DELAY);

    expect(panel()).toBeNull();
  });

  it("prefers the content slot over the text prop when both are given", async () => {
    const wrapper = mountPreview(
      { alwaysShow: true, text: "Plain text fallback" },
      { default: "Summary", content: '<div class="rich">Rich content</div>' },
    );

    await wrapper.find(".hover-preview-trigger").trigger("mouseenter");
    await vi.advanceTimersByTimeAsync(SHOW_DELAY);

    const p = panel();
    expect(p?.textContent).toBe("Rich content");
    expect(p?.querySelector(".rich")).not.toBeNull();
  });

  it("shows the panel on focusin and hides it (after the hide delay) on focusout (keyboard/accessibility path)", async () => {
    const wrapper = mountPreview({ alwaysShow: true, text: "Full detail" }, { default: "Summary" });

    // focusin/focusout (not focus/blur) — bubbling variants, so a wrapped
    // focusable descendant (noTabindex usage) also triggers these on the
    // trigger span, not just the span's own native focus.
    await wrapper.find(".hover-preview-trigger").trigger("focusin");
    await vi.advanceTimersByTimeAsync(SHOW_DELAY);
    expect(panel()).not.toBeNull();

    await wrapper.find(".hover-preview-trigger").trigger("focusout");
    await vi.advanceTimersByTimeAsync(HIDE_DELAY);
    expect(panel()).toBeNull();
  });

  it("does not close when focus moves from the trigger onto the panel's own copy button", async () => {
    const wrapper = mountPreview({ alwaysShow: true, text: "Full detail" }, { default: "Summary" });

    await wrapper.find(".hover-preview-trigger").trigger("focusin");
    await vi.advanceTimersByTimeAsync(SHOW_DELAY);
    const btn = copyButton();
    expect(btn).not.toBeNull();

    // Dispatched directly (rather than via wrapper.trigger, which doesn't
    // reliably forward relatedTarget) so the component's real FocusEvent
    // handler sees relatedTarget pointing at the panel's own button.
    wrapper.find(".hover-preview-trigger").element.dispatchEvent(new FocusEvent("focusout", { relatedTarget: btn }));
    await vi.advanceTimersByTimeAsync(HIDE_DELAY);
    expect(panel()).not.toBeNull();
  });

  it("never schedules a panel when there is no content at all, even with alwaysShow", async () => {
    const wrapper = mountPreview({ alwaysShow: true }, { default: "Summary" });

    await wrapper.find(".hover-preview-trigger").trigger("mouseenter");
    await vi.advanceTimersByTimeAsync(SHOW_DELAY);

    expect(panel()).toBeNull();
  });

  it("copies the text prop to the clipboard and shows the Copied state", async () => {
    const wrapper = mountPreview({ alwaysShow: true, text: "Full detail text" }, { default: "Summary" });

    await wrapper.find(".hover-preview-trigger").trigger("mouseenter");
    await vi.advanceTimersByTimeAsync(SHOW_DELAY);

    const btn = copyButton()!;
    expect(btn.getAttribute("aria-label")).toBe("Copy");
    btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith("Full detail text"));
    await vi.advanceTimersByTimeAsync(0);
    expect(copyButton()!.getAttribute("aria-label")).toBe("Copied");
  });

  it("copies the rendered content slot's text when using rich content instead of the text prop", async () => {
    const wrapper = mountPreview(
      { alwaysShow: true },
      { default: "Summary", content: '<div class="rich">Clients: github, slack</div>' },
    );

    await wrapper.find(".hover-preview-trigger").trigger("mouseenter");
    await vi.advanceTimersByTimeAsync(SHOW_DELAY);

    copyButton()!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith("Clients: github, slack"));
  });

  it("with noTabindex, skips the trigger's own tabindex/aria-describedby/has-preview styling, but still opens when a wrapped descendant gains focus and closes once focus leaves to something outside", async () => {
    const wrapper = mountPreview(
      { alwaysShow: true, noTabindex: true, text: "Full detail" },
      { default: '<button class="inner-btn">Short</button>' },
    );

    const trigger = wrapper.find(".hover-preview-trigger").element;
    expect(trigger.getAttribute("tabindex")).toBeNull();
    expect(trigger.classList.contains("has-preview")).toBe(false);

    const innerBtn = wrapper.find(".inner-btn").element;
    innerBtn.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    await vi.advanceTimersByTimeAsync(SHOW_DELAY);
    expect(panel()).not.toBeNull();
    expect(trigger.getAttribute("aria-describedby")).toBeNull();

    innerBtn.dispatchEvent(new FocusEvent("focusout", { bubbles: true, relatedTarget: document.body }));
    await vi.advanceTimersByTimeAsync(HIDE_DELAY);
    expect(panel()).toBeNull();
  });

  it("exposes panelId and visible through the default slot's scope, in sync with the actual rendered panel", async () => {
    activeWrapper = mount(HoverPreview, {
      props: { alwaysShow: true, text: "Full detail" },
      slots: {
        default: `<template #default="{ panelId, visible }"><button class="inner-btn" :data-panel-id="panelId" :data-visible="visible">Short</button></template>`,
      },
      attachTo: document.body,
    });
    const wrapper = activeWrapper;

    expect(wrapper.find(".inner-btn").attributes("data-visible")).toBe("false");

    await wrapper.find(".hover-preview-trigger").trigger("mouseenter");
    await vi.advanceTimersByTimeAsync(SHOW_DELAY);

    const btn = wrapper.find(".inner-btn");
    expect(btn.attributes("data-visible")).toBe("true");
    expect(panel()?.id).toBe(btn.attributes("data-panel-id"));
  });

  it("cleans up window scroll/resize listeners and the ResizeObserver on unmount without throwing, even while the panel is visible", async () => {
    const wrapper = mountPreview({ alwaysShow: true, text: "Full detail" }, { default: "Summary" });

    await wrapper.find(".hover-preview-trigger").trigger("mouseenter");
    await vi.advanceTimersByTimeAsync(SHOW_DELAY);
    expect(panel()).not.toBeNull();

    const removeSpy = vi.spyOn(window, "removeEventListener");

    expect(() => wrapper.unmount()).not.toThrow();
    activeWrapper = null;

    expect(removeSpy).toHaveBeenCalledWith("scroll", expect.any(Function), true);
    expect(removeSpy).toHaveBeenCalledWith("resize", expect.any(Function));
    expect(panel()).toBeNull();

    removeSpy.mockRestore();
  });
});

describe("HoverPreview positioning", () => {
  const INNER_WIDTH = 1000;
  const INNER_HEIGHT = 400;

  // getBoundingClientRect() is unimplemented in jsdom (always zeros), so real
  // layout-dependent flip/clamp behavior can't be exercised through actual
  // rendering — mock it per-element (trigger vs. panel) to drive the exact
  // scenarios the component's positioning math needs to handle correctly.
  function mockRects(triggerRect: Partial<DOMRect>, panelRect: Partial<DOMRect>) {
    const empty = { x: 0, y: 0, width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0, toJSON: () => ({}) };
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
      if (this.classList.contains("hover-preview-trigger")) return { ...empty, ...triggerRect } as DOMRect;
      if (this.classList.contains("hover-preview-panel")) return { ...empty, ...panelRect } as DOMRect;
      return empty as DOMRect;
    });
  }

  beforeEach(() => {
    Object.defineProperty(window, "innerWidth", { value: INNER_WIDTH, configurable: true });
    Object.defineProperty(window, "innerHeight", { value: INNER_HEIGHT, configurable: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("opens below by default when the real panel height fits there", async () => {
    mockRects({ top: 100, bottom: 120, left: 20, right: 100 }, { left: 20, right: 220, width: 200, height: 80 });
    const wrapper = mountPreview({ alwaysShow: true, text: "Detail" }, { default: "Summary" });

    await wrapper.find(".hover-preview-trigger").trigger("mouseenter");
    await vi.advanceTimersByTimeAsync(SHOW_DELAY);

    const style = (panel() as HTMLElement).style;
    expect(style.top).toBe("126px"); // rect.bottom(120) + GAP(6)
    expect(style.bottom).toBe("");
  });

  it("flips to open above when the real panel height doesn't fit below but does fit above", async () => {
    // Trigger near the bottom: only 80px below it, 300px above. A 150px-tall
    // panel overflows below (120 + 6 + 150 > 400 - 8) but fits above.
    mockRects({ top: 300, bottom: 320, left: 20, right: 100 }, { left: 20, right: 220, width: 200, height: 150 });
    const wrapper = mountPreview({ alwaysShow: true, text: "Detail" }, { default: "Summary" });

    await wrapper.find(".hover-preview-trigger").trigger("mouseenter");
    await vi.advanceTimersByTimeAsync(SHOW_DELAY);

    const style = (panel() as HTMLElement).style;
    expect(style.top).toBe("");
    expect(style.bottom).toBe("106px"); // innerHeight(400) - rect.top(300) + GAP(6)
  });

  it("clamps fully on-screen (never running off the bottom) when the panel is too tall to fit above or below", async () => {
    // Trigger roughly mid-viewport (190px above it, 190px below), but the
    // panel is 300px tall — taller than either side alone.
    mockRects({ top: 190, bottom: 210, left: 20, right: 100 }, { left: 20, right: 220, width: 200, height: 300 });
    const wrapper = mountPreview({ alwaysShow: true, text: "Very long detail" }, { default: "Summary" });

    await wrapper.find(".hover-preview-trigger").trigger("mouseenter");
    await vi.advanceTimersByTimeAsync(SHOW_DELAY);

    const style = (panel() as HTMLElement).style;
    // top = innerHeight(400) - MARGIN(8) - height(300) = 92, so the panel's
    // bottom edge lands exactly at the 8px margin instead of past it.
    expect(style.top).toBe("92px");
    expect(Number.parseFloat(style.top) + 300).toBeLessThanOrEqual(INNER_HEIGHT - 8);
  });

  it("slides left back when the real panel width would otherwise overflow the right edge of the viewport", async () => {
    mockRects({ top: 100, bottom: 120, left: 900, right: 950 }, { left: 900, right: 1100, width: 200, height: 80 });
    const wrapper = mountPreview({ alwaysShow: true, text: "Detail" }, { default: "Summary" });

    await wrapper.find(".hover-preview-trigger").trigger("mouseenter");
    await vi.advanceTimersByTimeAsync(SHOW_DELAY);

    const style = (panel() as HTMLElement).style;
    // left = innerWidth(1000) - MARGIN(8) - width(200) = 792, instead of the
    // trigger's own left(900), which would have pushed the panel off-screen.
    expect(style.left).toBe("792px");
  });
});
