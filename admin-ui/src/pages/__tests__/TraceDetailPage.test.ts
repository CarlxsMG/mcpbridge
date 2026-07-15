// Regression coverage for commit d8541ca: every waterfall row (not just the
// last one) must be clickable and switch the Attributes panel to that span.
import { afterEach, describe, expect, it, vi } from "vitest";
import { mount, flushPromises, type VueWrapper } from "@vue/test-utils";
import TraceDetailPage from "../TraceDetailPage.vue";
import type { StoredSpan } from "@/types/api";

const apiGet = vi.fn();

vi.mock("@/composables/useApi", () => ({
  api: { get: (path: string) => apiGet(path) },
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

function makeSpan(overrides: Partial<StoredSpan> = {}): StoredSpan {
  return {
    id: 1,
    traceId: "trace-1",
    spanId: "span-1",
    name: "span-1",
    mcpToolName: null,
    sessionId: null,
    startMs: 0,
    endMs: 10,
    statusCode: 0,
    attributes: {},
    createdAt: 0,
    ...overrides,
  };
}

let activeWrapper: VueWrapper | null = null;
afterEach(() => {
  activeWrapper?.unmount();
  activeWrapper = null;
  apiGet.mockReset();
});

describe("TraceDetailPage", () => {
  it("switches the Attributes panel to a non-last span when its waterfall row is clicked", async () => {
    const spans = [
      makeSpan({ id: 1, name: "first-span", startMs: 0, endMs: 10, attributes: { step: "first" } }),
      makeSpan({ id: 2, name: "second-span", startMs: 10, endMs: 20, attributes: { step: "second" } }),
      makeSpan({ id: 3, name: "third-span", startMs: 20, endMs: 30, attributes: { step: "third" } }),
    ];
    apiGet.mockResolvedValueOnce({ traceId: "trace-1", spans });
    activeWrapper = mount(TraceDetailPage, { props: { traceId: "trace-1" } });
    await flushPromises();
    const wrapper = activeWrapper;

    // Selection defaults to the last span.
    expect(wrapper.find(".attrs-heading").text()).toContain("third-span");

    const rows = wrapper.findAll(".waterfall-row");
    expect(rows).toHaveLength(3);
    await rows[0].trigger("click");

    expect(wrapper.find(".attrs-heading").text()).toContain("first-span");
    expect(wrapper.find(".attrs pre").text()).toContain("first");
    expect(rows[0].attributes("aria-pressed")).toBe("true");
    expect(rows[2].attributes("aria-pressed")).toBe("false");
  });
});
