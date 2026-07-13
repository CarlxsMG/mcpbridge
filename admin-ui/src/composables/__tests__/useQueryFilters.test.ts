// useQueryFilters calls useRoute()/useRouter() internally, so it needs a real
// mounted component with vue-router installed (see router/__tests__/router.test.ts
// for the plain-router-instance style used elsewhere) rather than a bare
// composable call — a tiny host component exposes the composable's return
// value for assertions.
import { describe, expect, it, vi } from "vitest";
import { defineComponent } from "vue";
import { createRouter, createMemoryHistory, type Router } from "vue-router";
import { mount } from "@vue/test-utils";
import { useQueryFilters } from "../useQueryFilters";

function makeRouter(): Router {
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: "/", component: { template: "<div/>" } },
      { path: "/list", component: { template: "<div/>" } },
    ],
  });
}

async function setup(query: Record<string, string>) {
  const router = makeRouter();
  await router.push({ path: "/list", query });
  await router.isReady();

  let composable!: ReturnType<typeof useQueryFilters<"tool" | "session_id">>;
  const Host = defineComponent({
    setup() {
      composable = useQueryFilters(["tool", "session_id"] as const);
      return () => null;
    },
  });
  const wrapper = mount(Host, { global: { plugins: [router] } });
  return { router, wrapper, composable };
}

describe("useQueryFilters", () => {
  it("seeds filter refs from the current route's query at creation time", async () => {
    const { composable } = await setup({ tool: "github__search_issues", session_id: "abc123" });

    expect(composable.filters.tool.value).toBe("github__search_issues");
    expect(composable.filters.session_id.value).toBe("abc123");
  });

  it("seeds empty-string filters for keys absent from the route query", async () => {
    const { composable } = await setup({ tool: "search" });

    expect(composable.filters.tool.value).toBe("search");
    expect(composable.filters.session_id.value).toBe("");
  });

  it("seeds empty-string filters when the route has no query at all", async () => {
    const { composable } = await setup({});

    expect(composable.filters.tool.value).toBe("");
    expect(composable.filters.session_id.value).toBe("");
  });

  it("toQuery omits filters that are empty or whitespace-only", async () => {
    const { composable } = await setup({});
    composable.filters.tool.value = "  ";
    composable.filters.session_id.value = "abc";

    expect(composable.toQuery()).toEqual({ tool: undefined, session_id: "abc" });
  });

  it("toQuery trims filter values", async () => {
    const { composable } = await setup({});
    composable.filters.tool.value = "  spaced  ";

    expect(composable.toQuery().tool).toBe("spaced");
  });

  it("toQuery merges extra params alongside the filters", async () => {
    const { composable } = await setup({});
    composable.filters.tool.value = "search";

    expect(composable.toQuery({ cursor: "page2" })).toEqual({
      tool: "search",
      session_id: undefined,
      cursor: "page2",
    });
  });

  it("toQuery omits empty-string extra params the same way it does filters", async () => {
    const { composable } = await setup({});

    expect(composable.toQuery({ cursor: "" })).toEqual({
      tool: undefined,
      session_id: undefined,
      cursor: undefined,
    });
  });

  it("toQuery lets extra override a filter key of the same name", async () => {
    const { composable } = await setup({});
    composable.filters.tool.value = "from-filter";

    expect(composable.toQuery({ tool: "from-extra" }).tool).toBe("from-extra");
  });

  it("syncUrl calls router.replace with the expected query shape", async () => {
    const { router, composable } = await setup({});
    const replaceSpy = vi.spyOn(router, "replace");
    composable.filters.tool.value = "search";
    composable.filters.session_id.value = "  ";

    composable.syncUrl({ cursor: "next-cursor" });

    expect(replaceSpy).toHaveBeenCalledWith({
      query: { tool: "search", session_id: undefined, cursor: "next-cursor" },
    });
  });

  it("syncUrl without extra args omits every currently-empty filter", async () => {
    const { router, composable } = await setup({ tool: "old-tool" });
    const replaceSpy = vi.spyOn(router, "replace");
    composable.filters.tool.value = "";

    composable.syncUrl();

    expect(replaceSpy).toHaveBeenCalledWith({ query: { tool: undefined, session_id: undefined } });
  });
});
