// useFocusTrap is a plain composable (no template), so it's exercised with a
// straightforward jsdom fixture rather than mounting a component: a real
// <div> container with real focusable children appended to document.body
// (jsdom only tracks document.activeElement for elements attached to the
// document), driving focus with real .focus() calls and feeding real
// KeyboardEvent objects straight into onKeydown() — no dispatch/listener
// plumbing needed since onKeydown is just a function.
import { afterEach, describe, expect, it } from "vitest";
import { ref } from "vue";
import { useFocusTrap, focusFirst } from "../useFocusTrap";

function makeButton(label: string): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.textContent = label;
  return btn;
}

function tabEvent(shiftKey: boolean): KeyboardEvent {
  return new KeyboardEvent("keydown", { key: "Tab", shiftKey, cancelable: true });
}

describe("useFocusTrap", () => {
  let container: HTMLDivElement | null = null;

  afterEach(() => {
    container?.remove();
    container = null;
  });

  function mount(children: HTMLElement[]) {
    container = document.createElement("div");
    for (const child of children) container.appendChild(child);
    document.body.appendChild(container);
    return container;
  }

  it("wraps Tab from the last focusable element to the first, preventing default", () => {
    const [first, middle, last] = [makeButton("first"), makeButton("middle"), makeButton("last")];
    const el = mount([first, middle, last]);
    const { onKeydown } = useFocusTrap(ref(el));

    last.focus();
    expect(document.activeElement).toBe(last);

    const event = tabEvent(false);
    onKeydown(event);

    expect(event.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(first);
  });

  it("wraps Shift+Tab from the first focusable element to the last, preventing default", () => {
    const [first, middle, last] = [makeButton("first"), makeButton("middle"), makeButton("last")];
    const el = mount([first, middle, last]);
    const { onKeydown } = useFocusTrap(ref(el));

    first.focus();
    expect(document.activeElement).toBe(first);

    const event = tabEvent(true);
    onKeydown(event);

    expect(event.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(last);
  });

  it("does nothing on Tab from a middle element", () => {
    const [first, middle, last] = [makeButton("first"), makeButton("middle"), makeButton("last")];
    const el = mount([first, middle, last]);
    const { onKeydown } = useFocusTrap(ref(el));

    middle.focus();
    const event = tabEvent(false);
    onKeydown(event);

    expect(event.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(middle);
  });

  it("does nothing on Shift+Tab from a middle element", () => {
    const [first, middle, last] = [makeButton("first"), makeButton("middle"), makeButton("last")];
    const el = mount([first, middle, last]);
    const { onKeydown } = useFocusTrap(ref(el));

    middle.focus();
    const event = tabEvent(true);
    onKeydown(event);

    expect(event.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(middle);
  });

  it("ignores non-Tab keys", () => {
    const [first, last] = [makeButton("first"), makeButton("last")];
    const el = mount([first, last]);
    const { onKeydown } = useFocusTrap(ref(el));

    last.focus();
    const event = new KeyboardEvent("keydown", { key: "Enter", cancelable: true });
    onKeydown(event);

    expect(event.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(last);
  });

  it("does nothing without throwing when the container has zero focusable elements", () => {
    const el = mount([]);
    const { onKeydown } = useFocusTrap(ref(el));

    const event = tabEvent(false);
    expect(() => onKeydown(event)).not.toThrow();
    expect(event.defaultPrevented).toBe(false);
  });

  it("does nothing without throwing when the container ref is null", () => {
    const { onKeydown } = useFocusTrap(ref(null));

    const event = tabEvent(false);
    expect(() => onKeydown(event)).not.toThrow();
    expect(event.defaultPrevented).toBe(false);
  });
});

// focusFirst is the "land focus on open" half of the shared overlay pattern —
// promoted out of ModalShell/TheSidebar's duplicated querySelector calls.
describe("focusFirst", () => {
  let container: HTMLDivElement | null = null;

  afterEach(() => {
    container?.remove();
    container = null;
  });

  function mount(children: HTMLElement[]) {
    container = document.createElement("div");
    for (const child of children) container.appendChild(child);
    document.body.appendChild(container);
    return container;
  }

  it("focuses the first focusable element in the container", () => {
    const [first, last] = [makeButton("first"), makeButton("last")];
    const el = mount([first, last]);

    focusFirst(el);

    expect(document.activeElement).toBe(first);
  });

  it("skips a disabled leading element and focuses the first enabled one", () => {
    const disabled = makeButton("disabled");
    disabled.disabled = true;
    const enabled = makeButton("enabled");
    const el = mount([disabled, enabled]);

    focusFirst(el);

    expect(document.activeElement).toBe(enabled);
  });

  it("is a no-op without throwing when the container is null", () => {
    expect(() => focusFirst(null)).not.toThrow();
  });

  it("is a no-op without throwing when the container has no focusable elements", () => {
    const el = mount([]);

    expect(() => focusFirst(el)).not.toThrow();
  });
});
