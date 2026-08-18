// The sidebar's progressive disclosure: a first-run user meets the day-1 pages
// only, and nothing is lost — every advanced page stays routable and stays in the
// command palette.
//
// Two visibility rules make hiding safe, and each gets its own case: the entry's
// tier, and the page currently open. The second one especially — without it a user
// can land on /schedules and find no row in the nav pointing at the page they are
// looking at.
//
// The third rule that used to exist (promote an entry the browser had visited,
// remembered in localStorage) is gone on purpose, and the case below pins its
// absence: a sidebar that differs per browser is one no doc and no support reply
// can describe. See useNavDisclosure's docblock for the full reasoning.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { createRouter, createMemoryHistory, type Router } from "vue-router";
import TheSidebar from "../TheSidebar.vue";
import { navEntries } from "@/navigation";
import { NAV_ADVANCED_STORAGE_KEY } from "@/composables/useNavEntries";

vi.mock("@/composables/useAuth", () => ({
  useAuth: () => ({
    state: { user: { username: "root", role: "admin" } },
    logout: vi.fn(),
  }),
}));

// The palette child fetches servers/bundles/keys when it opens; nothing here
// opens it, but the stub keeps a stray call from reaching the real fetch.
vi.mock("@/composables/useApi", () => ({
  api: { get: vi.fn().mockResolvedValue({ items: [] }) },
}));

const Blank = { template: "<div />" };

// Account is `core` but has no group, so it renders in the footer rather than in
// a section — the disclosure only ever holds grouped entries.
const ADVANCED_IN_GROUPS = navEntries.filter((e) => e.tier === "advanced" && e.group !== null).length;

function makeRouter(): Router {
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: "/", redirect: "/servers" },
      { path: "/login", component: Blank },
      ...navEntries.map((e) => ({ path: e.path, name: e.name, component: Blank })),
      // Stands in for the app's detail/create routes (/servers/:name,
      // /composites/:name, …) so a spec can mount on one.
      { path: "/:pathMatch(.*)*", component: Blank },
    ],
  });
}

async function mountSidebar(path = "/servers") {
  const router = makeRouter();
  await router.push(path);
  await router.isReady();
  const wrapper = mount(TheSidebar, { props: { navOpen: false }, global: { plugins: [router] } });
  return { wrapper, router };
}

/** Visible nav link labels, in render order — what a user can actually click. */
function linkLabels(wrapper: Awaited<ReturnType<typeof mountSidebar>>["wrapper"]): string[] {
  return wrapper.findAll(".nav-groups a").map((a) => a.text());
}

beforeEach(() => {
  localStorage.clear();
});

describe("TheSidebar progressive disclosure", () => {
  it("shows the core entries and hides the advanced ones on a first visit", async () => {
    const { wrapper } = await mountSidebar();
    const labels = linkLabels(wrapper);

    // Core: everything a user needs before they have traffic.
    // "Activity" is one row for what used to be three (Usage/Traffic/Traces).
    expect(labels).toEqual(["Servers", "Bundles", "API keys", "Overview", "Activity", "Audit log", "Users", "Config"]);
    // Advanced: real pages, but not day-1 questions.
    for (const hidden of ["Catalog", "Composites", "WS proxies", "Policies", "Monitors", "Schedules", "SSO"]) {
      expect(labels).not.toContain(hidden);
    }
  });

  it("keeps the advanced links out of the DOM, not merely out of sight", async () => {
    // Collapsed rows that are only visually hidden stay in the tab order and in
    // the sidebar's focus trap, which is worse than not offering them at all.
    const { wrapper } = await mountSidebar();

    expect(wrapper.find("#sidebar-advanced").exists()).toBe(true);
    expect(wrapper.findAll("#sidebar-advanced a")).toHaveLength(0);
  });

  it("counts the folded-away pages in the toggle's accessible name", async () => {
    const { wrapper } = await mountSidebar();
    const toggle = wrapper.get(".nav-advanced-toggle");

    // Derived, not a literal: a new advanced page should not have to touch this
    // test. The claim is that the number in the button's NAME (it is deliberately
    // not aria-hidden) equals what the disclosure is holding back.
    expect(toggle.text()).toBe(`Advanced ${ADVANCED_IN_GROUPS}`);
  });

  it("flips aria-expanded and reveals the advanced entries when toggled", async () => {
    const { wrapper } = await mountSidebar();
    const toggle = wrapper.get(".nav-advanced-toggle");

    expect(toggle.attributes("aria-expanded")).toBe("false");
    expect(toggle.attributes("aria-controls")).toBe("sidebar-advanced");

    await toggle.trigger("click");

    expect(toggle.attributes("aria-expanded")).toBe("true");
    expect(linkLabels(wrapper)).toContain("Schedules");
  });

  it("remembers the expansion across a remount", async () => {
    const first = await mountSidebar();
    await first.wrapper.get(".nav-advanced-toggle").trigger("click");
    expect(localStorage.getItem(NAV_ADVANCED_STORAGE_KEY)).toBe("1");

    const second = await mountSidebar();
    expect(second.wrapper.get(".nav-advanced-toggle").attributes("aria-expanded")).toBe("true");
    expect(linkLabels(second.wrapper)).toContain("Schedules");

    // ...and collapsing again sticks too, rather than only the open state.
    await second.wrapper.get(".nav-advanced-toggle").trigger("click");
    const third = await mountSidebar();
    expect(third.wrapper.get(".nav-advanced-toggle").attributes("aria-expanded")).toBe("false");
  });

  it("always shows the entry for the page the user is on, even collapsed", async () => {
    const { wrapper } = await mountSidebar("/schedules");

    expect(wrapper.get(".nav-advanced-toggle").attributes("aria-expanded")).toBe("false");
    expect(linkLabels(wrapper)).toContain("Schedules");
    expect(linkLabels(wrapper)).not.toContain("Monitors");
  });

  it("resolves the active entry from a nested route, not just an exact path", async () => {
    // A composite's detail page belongs to the Composites entry. Match on the
    // exact path only and the nav goes blank on every detail page of an
    // advanced section — the deep link is precisely how a teammate's shared
    // URL gets opened.
    const { wrapper } = await mountSidebar("/composites/nightly-rollup");

    expect(linkLabels(wrapper)).toContain("Composites");
    expect(linkLabels(wrapper)).not.toContain("Catalog");
  });

  it("does not let this browser's history change which entries are folded away", async () => {
    // Visiting an advanced page shows its row while you are on it...
    const onPage = await mountSidebar("/monitors");
    expect(linkLabels(onPage.wrapper)).toContain("Monitors");

    // ...and moving on puts it back. Two colleagues, or one person's second
    // browser, must be able to follow the same instructions and see the same
    // sidebar, which a remembered "visited" set made impossible.
    const elsewhere = await mountSidebar("/servers");
    expect(linkLabels(elsewhere.wrapper)).not.toContain("Monitors");
    expect(elsewhere.wrapper.get(".nav-advanced-toggle").text()).toBe(`Advanced ${ADVANCED_IN_GROUPS}`);
  });

  it("writes nothing to storage but the expansion preference", async () => {
    // Storage is the mechanism a per-browser nav needs, so the assertion is on
    // storage rather than on the rendered rows: anything else appearing here is
    // adaptivity creeping back in.
    const { wrapper } = await mountSidebar("/monitors");
    await wrapper.get(".nav-advanced-toggle").trigger("click");

    expect(Object.keys(localStorage)).toEqual([NAV_ADVANCED_STORAGE_KEY]);
  });
});
