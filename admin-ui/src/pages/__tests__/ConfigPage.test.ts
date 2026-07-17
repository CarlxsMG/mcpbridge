// Smoke coverage for ConfigPage.vue: it wires three child sections' events to a
// shared result/error panel. Children are stubbed (they own their own network
// calls); we assert the page renders and that an emitted import result surfaces
// the applied-counts summary.
import { afterEach, describe, expect, it } from "vitest";
import { mount, flushPromises, type VueWrapper } from "@vue/test-utils";
import ConfigPage from "../ConfigPage.vue";
import ConfigImportSection from "@/components/config/ConfigImportSection.vue";
import type { ConfigImportResult } from "@/types/api";

let wrapper: VueWrapper | null = null;
function mountPage() {
  wrapper = mount(ConfigPage, {
    global: {
      stubs: { ConfigExportSection: true, ConfigImportSection: true, ConfigSnapshotsSection: true },
    },
  });
  return wrapper;
}
afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
});

describe("ConfigPage", () => {
  it("renders the page shell with no result panel initially", () => {
    const w = mountPage();
    expect(w.find("section").exists()).toBe(true);
    expect(w.find(".result").exists()).toBe(false);
  });

  it("shows the applied-counts summary when a child section emits an import result", async () => {
    const w = mountPage();
    const result: ConfigImportResult = {
      dryRun: false,
      applied: { bundles: 1, alertRules: 0, clientsConfigured: 2, toolsConfigured: 3, guardrails: 0, consumers: 0 },
      skipped: [],
    };
    w.findComponent(ConfigImportSection).vm.$emit("result", result);
    await flushPromises();
    expect(w.find(".result").exists()).toBe(true);
    expect(w.find(".result").text()).toContain("Bundles: 1");
  });
});
