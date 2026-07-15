// useConfirmAction resolves its error fallback through the real global i18n
// instance (see the composable's own doc comment) rather than an injected
// scope, so it needs no router/mount host — just import it directly.
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "@/composables/useApi";
import { useConfirmAction } from "../useConfirmAction";

describe("useConfirmAction", () => {
  it("request() sets pending to the given item and clears a stale error", () => {
    const action = useConfirmAction<{ id: number }>();
    action.errorMessage.value = "stale error";

    action.request({ id: 1 });

    expect(action.pending.value).toEqual({ id: 1 });
    expect(action.errorMessage.value).toBe("");
  });

  it("cancel() clears pending without running anything", async () => {
    const action = useConfirmAction<{ id: number }>();
    action.request({ id: 1 });

    action.cancel();

    expect(action.pending.value).toBeNull();
  });

  it("confirm() is a no-op when nothing is pending", async () => {
    const action = useConfirmAction<{ id: number }>();
    const run = vi.fn();

    await action.confirm(run);

    expect(run).not.toHaveBeenCalled();
  });

  it("confirm() clears pending, runs the action with the pending item, and toggles busy around it", async () => {
    const action = useConfirmAction<{ id: number }>();
    action.request({ id: 7 });
    let resolveRun: () => void = () => {};
    const run = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveRun = resolve;
        }),
    );

    const pendingConfirm = action.confirm(run);
    expect(action.pending.value).toBeNull();
    expect(action.busy.value).toBe(true);

    resolveRun();
    await pendingConfirm;

    expect(run).toHaveBeenCalledWith({ id: 7 });
    expect(action.busy.value).toBe(false);
  });

  it("confirm() sets errorMessage to the ApiError's own message when the action throws", async () => {
    const action = useConfirmAction<{ id: number }>();
    action.request({ id: 7 });

    await action.confirm(async () => {
      throw new ApiError(409, "conflict", "Already decided.");
    });

    expect(action.errorMessage.value).toBe("Already decided.");
    expect(action.busy.value).toBe(false);
  });

  it("confirm() falls back to a generic message for a non-ApiError throw", async () => {
    const action = useConfirmAction<{ id: number }>();
    action.request({ id: 7 });

    await action.confirm(async () => {
      throw new Error("network down");
    });

    expect(action.errorMessage.value).toBe("Action failed.");
  });
});
