import { describe, expect, it, vi } from "vitest";
import { ApiError } from "@/composables/useApi";
import { useEntityForm } from "../useEntityForm";

interface Widget {
  id: number;
  name: string;
}

describe("useEntityForm", () => {
  it("starts closed with no entity being edited", () => {
    const reset = vi.fn();
    const form = useEntityForm<Widget>({ reset });

    expect(form.open.value).toBe(false);
    expect(form.editing.value).toBeNull();
    expect(form.busy.value).toBe(false);
    expect(form.error.value).toBe("");
    expect(reset).not.toHaveBeenCalled();
  });

  it("openCreate resets state, clears editing/error, and opens the form", () => {
    const reset = vi.fn();
    const form = useEntityForm<Widget>({ reset });
    form.error.value = "stale error";
    form.editing.value = { id: 1, name: "old" };

    form.openCreate();

    expect(reset).toHaveBeenCalledTimes(1);
    expect(form.editing.value).toBeNull();
    expect(form.error.value).toBe("");
    expect(form.open.value).toBe(true);
  });

  it("openEdit resets, populates via fill, and opens the form", () => {
    const reset = vi.fn();
    const fill = vi.fn();
    const form = useEntityForm<Widget>({ reset, fill });
    const widget: Widget = { id: 7, name: "gizmo" };
    form.error.value = "stale error";

    form.openEdit(widget);

    expect(reset).toHaveBeenCalledTimes(1);
    expect(fill).toHaveBeenCalledWith(widget);
    // Not .toBe: `editing` is a Vue ref over an object, so its value is a
    // reactive Proxy wrapping `widget` rather than `widget` itself.
    expect(form.editing.value).toEqual(widget);
    expect(form.error.value).toBe("");
    expect(form.open.value).toBe(true);
  });

  it("openEdit works without a fill option", () => {
    const reset = vi.fn();
    const form = useEntityForm<Widget>({ reset });
    const widget: Widget = { id: 2, name: "thing" };

    expect(() => form.openEdit(widget)).not.toThrow();
    expect(form.editing.value).toEqual(widget);
    expect(form.open.value).toBe(true);
  });

  it("close resets state, clears editing/error, and closes the form", () => {
    const reset = vi.fn();
    const form = useEntityForm<Widget>({ reset });
    form.openEdit({ id: 3, name: "thing" });
    reset.mockClear();
    form.error.value = "some error";

    form.close();

    expect(reset).toHaveBeenCalledTimes(1);
    expect(form.open.value).toBe(false);
    expect(form.editing.value).toBeNull();
    expect(form.error.value).toBe("");
  });

  it("submit success path closes the form and resolves true", async () => {
    const reset = vi.fn();
    const form = useEntityForm<Widget>({ reset });
    form.openCreate();
    const action = vi.fn().mockResolvedValue(undefined);

    const ok = await form.submit(action, "Failed to create widget.");

    expect(ok).toBe(true);
    expect(action).toHaveBeenCalledWith(null);
    expect(form.open.value).toBe(false);
    expect(form.busy.value).toBe(false);
    expect(form.error.value).toBe("");
  });

  it("submit passes the current editing entity through to the action", async () => {
    const reset = vi.fn();
    const form = useEntityForm<Widget>({ reset });
    const widget: Widget = { id: 9, name: "widget" };
    form.openEdit(widget);
    const action = vi.fn().mockResolvedValue(undefined);

    await form.submit(action, "Failed to update widget.");

    expect(action).toHaveBeenCalledWith(widget);
  });

  it("submit failure path sets the error, resolves false, and leaves the form open", async () => {
    const reset = vi.fn();
    const form = useEntityForm<Widget>({ reset });
    form.openCreate();
    const action = vi.fn().mockRejectedValue(new Error("network down"));

    const ok = await form.submit(action, "Failed to create widget.");

    expect(ok).toBe(false);
    expect(form.error.value).toBe("Failed to create widget.");
    expect(form.open.value).toBe(true);
    expect(form.busy.value).toBe(false);
  });

  it("submit uses the ApiError's own message when thrown", async () => {
    const reset = vi.fn();
    const form = useEntityForm<Widget>({ reset });
    form.openCreate();
    const action = vi.fn().mockRejectedValue(new ApiError(409, "conflict", "Name already exists."));

    const ok = await form.submit(action, "Failed to create widget.");

    expect(ok).toBe(false);
    expect(form.error.value).toBe("Name already exists.");
  });

  it("submit falls back to the given message for a non-ApiError throw", async () => {
    const reset = vi.fn();
    const form = useEntityForm<Widget>({ reset });
    form.openCreate();
    const action = vi.fn().mockRejectedValue("some string was thrown");

    const ok = await form.submit(action, "Failed to create widget.");

    expect(ok).toBe(false);
    expect(form.error.value).toBe("Failed to create widget.");
  });

  it("sets busy while the submit action is in flight", async () => {
    const reset = vi.fn();
    const form = useEntityForm<Widget>({ reset });
    form.openCreate();
    let resolveAction: () => void = () => {};
    const action = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveAction = resolve;
        }),
    );

    const pending = form.submit(action, "Failed to create widget.");
    expect(form.busy.value).toBe(true);

    resolveAction();
    await pending;
    expect(form.busy.value).toBe(false);
  });
});
