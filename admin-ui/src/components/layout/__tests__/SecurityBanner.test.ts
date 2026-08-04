// The banner exists to be un-ignorable when it matters and quiet when it does
// not, so these tests pin exactly that boundary: which severities raise it, when
// dismissal is offered, and what a dismissal is scoped to. A regression in any
// of the three turns a security warning into wallpaper.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import SecurityBanner from "../SecurityBanner.vue";
import type { PostureFinding, SecurityPosture } from "@/types/api";

const apiGet = vi.fn();

vi.mock("@/composables/useApi", () => ({
  api: { get: (path: string) => apiGet(path) },
}));

function finding(over: Partial<PostureFinding> = {}): PostureFinding {
  return {
    id: "session_cookie_insecure",
    severity: "warning",
    summary: "Server-side English summary.",
    tolerated: null,
    remediation: "Do the thing.",
    ...over,
  };
}

function posture(findings: PostureFinding[]): SecurityPosture {
  const rank = { info: 0, warning: 1, critical: 2 } as const;
  const worst = findings.reduce<SecurityPosture["worst"]>(
    (acc, f) => (acc === null || rank[f.severity] > rank[acc] ? f.severity : acc),
    null,
  );
  return { findings, worst };
}

async function mountBanner() {
  const wrapper = mount(SecurityBanner);
  await flushPromises();
  return wrapper;
}

beforeEach(() => {
  localStorage.clear();
  apiGet.mockReset();
});

afterEach(() => {
  localStorage.clear();
});

describe("SecurityBanner", () => {
  it("renders nothing when the posture is clean", async () => {
    apiGet.mockResolvedValue(posture([]));
    expect((await mountBanner()).find(".security-banner").exists()).toBe(false);
  });

  it("renders nothing when the endpoint refuses (a non-admin gets a 403)", async () => {
    // Nothing here is actionable by that user, so a broken-looking banner would
    // be worse than none.
    apiGet.mockRejectedValue(new Error("Forbidden"));
    expect((await mountBanner()).find(".security-banner").exists()).toBe(false);
  });

  it("does NOT raise for info findings alone — they are capability limits, not exposure", async () => {
    apiGet.mockResolvedValue(posture([finding({ id: "secret_box_unset", severity: "info" })]));
    expect((await mountBanner()).find(".security-banner").exists()).toBe(false);
  });

  it("raises a dismissible warning banner", async () => {
    apiGet.mockResolvedValue(posture([finding()]));
    const wrapper = await mountBanner();

    expect(wrapper.find(".security-banner").classes()).toContain("is-warning");
    expect(wrapper.find(".banner-dismiss").exists()).toBe(true);
  });

  it("raises a critical banner that CANNOT be dismissed", async () => {
    // The whole point of the component: "every backend tool is callable without
    // credentials" must not be dismissible into silence.
    apiGet.mockResolvedValue(posture([finding({ id: "mcp_data_plane_open", severity: "critical" })]));
    const wrapper = await mountBanner();

    expect(wrapper.find(".security-banner").classes()).toContain("is-critical");
    expect(wrapper.find(".banner-dismiss").exists()).toBe(false);
  });

  it("a critical finding wins over warnings for the banner's severity", async () => {
    apiGet.mockResolvedValue(posture([finding(), finding({ id: "auth_disabled", severity: "critical" })]));
    const wrapper = await mountBanner();

    expect(wrapper.find(".security-banner").classes()).toContain("is-critical");
    expect(wrapper.find(".banner-dismiss").exists()).toBe(false);
  });

  it("dismissal hides the banner and is stored against the exact finding set", async () => {
    apiGet.mockResolvedValue(posture([finding()]));
    const wrapper = await mountBanner();

    await wrapper.find(".banner-dismiss").trigger("click");

    expect(wrapper.find(".security-banner").exists()).toBe(false);
    expect(localStorage.getItem("mcpbridge.security.dismissed")).toBe("session_cookie_insecure");
  });

  it("stays dismissed for the same finding set on a later visit", async () => {
    localStorage.setItem("mcpbridge.security.dismissed", "session_cookie_insecure");
    apiGet.mockResolvedValue(posture([finding()]));

    expect((await mountBanner()).find(".security-banner").exists()).toBe(false);
  });

  it("re-opens when a NEW warning appears, even though an older one was dismissed", async () => {
    // Dismissal is keyed on the finding ids, not on a boolean — otherwise the
    // first dismissal would silence every future warning forever.
    localStorage.setItem("mcpbridge.security.dismissed", "session_cookie_insecure");
    apiGet.mockResolvedValue(posture([finding(), finding({ id: "jwt_no_audience" })]));

    expect((await mountBanner()).find(".security-banner").exists()).toBe(true);
  });

  it("expands to a per-finding list with the remediation and the tolerated aside", async () => {
    apiGet.mockResolvedValue(posture([finding({ tolerated: "development" })]));
    const wrapper = await mountBanner();

    expect(wrapper.find(".banner-list").exists()).toBe(false);
    await wrapper.find(".banner-btn").trigger("click");

    const row = wrapper.find(".banner-list li");
    expect(row.exists()).toBe(true);
    expect(row.find(".finding-fix").text()).toBe("Do the thing.");
    // Parenthesized, and a separate element from the remediation — the DOM used
    // to concatenate the two into "…developmentServe over HTTPS…" because Vue
    // condenses the whitespace-only node between adjacent inline elements.
    expect(row.find(".finding-tolerated").text()).toBe("(allowed because NODE_ENV=development)");
    expect(row.text()).not.toContain("developmentDo the thing");
  });

  it("falls back to the server's summary for a finding id this UI has no copy for", async () => {
    // A newer server than this bundle. Showing the English summary beats
    // rendering a raw translation key.
    apiGet.mockResolvedValue(posture([finding({ id: "some_future_check" })]));
    const wrapper = await mountBanner();
    await wrapper.find(".banner-btn").trigger("click");

    expect(wrapper.find(".finding-text").text()).toContain("Server-side English summary.");
  });
});
