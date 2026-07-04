// usePatchResource is the generalized save primitive usePatchTool now sits on
// top of (see usePatchTool.test.ts for the adapter's own coverage). Neither
// composable had tests before this file.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/composables/useApi";
import { usePatchResource } from "../usePatchResource";

const apiPatch = vi.fn();

vi.mock("@/composables/useApi", () => ({
  api: { patch: (path: string, body: unknown) => apiPatch(path, body) },
  ApiError: class ApiError extends Error {
    status: number;
    code: string;
    constructor(status: number, code: string, message: string) {
      super(message);
      this.status = status;
      this.code = code;
    }
  },
}));

describe("usePatchResource", () => {
  beforeEach(() => {
    apiPatch.mockReset();
  });

  it("resolves true and clears a stale error on a successful patch", async () => {
    apiPatch.mockResolvedValueOnce(undefined);
    const resource = usePatchResource(() => "/admin-api/clients/acme");
    resource.error.value = "stale error";

    const ok = await resource.patchField("label", "New label", "Failed to save.");

    expect(ok).toBe(true);
    expect(resource.error.value).toBe("");
    expect(apiPatch).toHaveBeenCalledWith("/admin-api/clients/acme", { label: "New label" });
  });

  it("short-circuits to false without calling the action when resourcePath() is undefined", async () => {
    const resource = usePatchResource(() => undefined);

    const ok = await resource.patchField("label", "New label", "Failed to save.");

    expect(ok).toBe(false);
    expect(apiPatch).not.toHaveBeenCalled();
  });

  it("sets error.value to the ApiError's own message when one is thrown", async () => {
    apiPatch.mockRejectedValueOnce(new ApiError(409, "conflict", "Name already exists."));
    const resource = usePatchResource(() => "/admin-api/clients/acme");

    const ok = await resource.patchField("label", "New label", "Failed to save.");

    expect(ok).toBe(false);
    expect(resource.error.value).toBe("Name already exists.");
  });

  it("falls back to the given message for a non-ApiError throw", async () => {
    apiPatch.mockRejectedValueOnce(new Error("network down"));
    const resource = usePatchResource(() => "/admin-api/clients/acme");

    const ok = await resource.patchField("label", "New label", "Failed to save.");

    expect(ok).toBe(false);
    expect(resource.error.value).toBe("Failed to save.");
  });

  it("toggles saving true then false around the async action", async () => {
    let resolveAction: () => void = () => {};
    apiPatch.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveAction = resolve;
        }),
    );
    const resource = usePatchResource(() => "/admin-api/clients/acme");

    const pending = resource.patchField("label", "New label", "Failed to save.");
    expect(resource.saving.value).toBe(true);

    resolveAction();
    await pending;
    expect(resource.saving.value).toBe(false);
  });

  it("patchFields sends the exact body object it's given", async () => {
    apiPatch.mockResolvedValueOnce(undefined);
    const resource = usePatchResource(() => "/admin-api/clients/acme");

    await resource.patchFields({ label: "New label", tags: ["a", "b"] }, "Failed to save.");

    expect(apiPatch).toHaveBeenCalledWith("/admin-api/clients/acme", { label: "New label", tags: ["a", "b"] });
  });

  it("run() invokes the given action with the resolved path and returns its outcome", async () => {
    const action = vi.fn().mockResolvedValue(undefined);
    const resource = usePatchResource(() => "/admin-api/clients/acme");

    const ok = await resource.run(action, "Failed.");

    expect(ok).toBe(true);
    expect(action).toHaveBeenCalledWith("/admin-api/clients/acme");
  });
});
