// usePatchTool had no tests before this file. It's now a thin adapter over
// usePatchResource (see usePatchResource.test.ts for the shared save-path
// coverage: error handling, saving toggling, undefined short-circuiting) — this
// file only confirms the adapter still reproduces its exact prior
// toolPath-based behavior after the refactor.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { usePatchTool } from "../usePatchTool";

const apiPatch = vi.fn();
const apiPut = vi.fn();
const apiPost = vi.fn();

vi.mock("@/composables/useApi", () => ({
  api: {
    patch: (path: string, body: unknown) => apiPatch(path, body),
    put: (path: string, body: unknown) => apiPut(path, body),
    post: (path: string) => apiPost(path),
  },
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

describe("usePatchTool", () => {
  beforeEach(() => {
    apiPatch.mockReset();
    apiPut.mockReset();
    apiPost.mockReset();
  });

  it("resolves false without patching when toolName() is undefined", async () => {
    const tool = usePatchTool(
      () => "acme",
      () => undefined,
    );

    const ok = await tool.patchField("enabled", false, "Failed to save.");

    expect(ok).toBe(false);
    expect(apiPatch).not.toHaveBeenCalled();
  });

  it("patches the client/tool path built via toolPath() when toolName() is defined", async () => {
    apiPatch.mockResolvedValueOnce(undefined);
    const tool = usePatchTool(
      () => "acme",
      () => "search",
    );

    const ok = await tool.patchField("enabled", false, "Failed to save.");

    expect(ok).toBe(true);
    expect(apiPatch).toHaveBeenCalledWith("/admin-api/clients/acme/tools/search", { enabled: false });
  });

  it("putTags PUTs to the tool path's /tags sub-resource", async () => {
    apiPut.mockResolvedValueOnce(undefined);
    const tool = usePatchTool(
      () => "acme",
      () => "search",
    );

    const ok = await tool.putTags(["a", "b"], "Failed to save tags.");

    expect(ok).toBe(true);
    expect(apiPut).toHaveBeenCalledWith("/admin-api/clients/acme/tools/search/tags", { tags: ["a", "b"] });
  });

  it("clearQuarantine POSTs to the tool path's /quarantine/clear sub-resource", async () => {
    apiPost.mockResolvedValueOnce(undefined);
    const tool = usePatchTool(
      () => "acme",
      () => "search",
    );

    const ok = await tool.clearQuarantine("Failed to clear quarantine.");

    expect(ok).toBe(true);
    expect(apiPost).toHaveBeenCalledWith("/admin-api/clients/acme/tools/search/quarantine/clear");
  });

  it("re-evaluates clientName()/toolName() on every call, not just at construction", async () => {
    apiPatch.mockResolvedValueOnce(undefined);
    let client = "acme";
    let tool = "search";
    const patcher = usePatchTool(
      () => client,
      () => tool,
    );
    client = "globex";
    tool = "fetch";

    await patcher.patchField("enabled", true, "Failed to save.");

    expect(apiPatch).toHaveBeenCalledWith("/admin-api/clients/globex/tools/fetch", { enabled: true });
  });
});
