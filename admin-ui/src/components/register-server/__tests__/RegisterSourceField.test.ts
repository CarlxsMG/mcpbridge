// The source field's correction UI, at the level of "which affordance does the
// user actually get".
//
// The interesting case is the one that has no right answer: an OpenAPI document
// pasted or file-loaded as text. POST /register discovers from `openapi_url`,
// `tools`, `curl_input` or `postman_collection` and there is no inline-spec field,
// so every one of the six pills would build a payload the API rejects — the
// "OpenAPI" one most convincingly of all, since it is the obvious pick and it
// fails as a URL-validation error. So the chooser has to go silent and the field
// has to say what to paste instead.
import { afterEach, describe, expect, it } from "vitest";
import { mount, type VueWrapper } from "@vue/test-utils";
import RegisterSourceField from "../RegisterSourceField.vue";
import { detectSource, type SourceId } from "@/utils/registerSource";

let activeWrapper: VueWrapper | null = null;
afterEach(() => {
  activeWrapper?.unmount();
  activeWrapper = null;
});

/** Mounts the field over whatever `detectSource` really returns for `source`. */
function mountField(source: string, opts?: { activeSource?: SourceId | null; overridden?: boolean }): VueWrapper {
  const wrapper = mount(RegisterSourceField, {
    props: {
      source,
      detection: detectSource(source),
      activeSource: opts?.activeSource ?? detectSource(source).detected,
      overridden: opts?.overridden ?? false,
    },
  });
  activeWrapper = wrapper;
  return wrapper;
}

const SPEC = JSON.stringify({ openapi: "3.1.0", info: { title: "Payments" }, paths: {} });

describe("RegisterSourceField", () => {
  it("offers the full chooser for input nothing has been ruled out for", () => {
    const wrapper = mountField("the payments API");

    expect(wrapper.text()).toContain("Not sure what this is");
    expect(wrapper.findAll(".choice")).toHaveLength(6);
  });

  it("offers exactly the two candidates for an ambiguous URL", () => {
    const wrapper = mountField("https://api.example.com/v1");

    expect(wrapper.findAll(".choice").map((b) => b.text())).toEqual(["OpenAPI URL", "MCP server"]);
  });

  it("explains a pasted spec instead of offering a source for it", () => {
    const wrapper = mountField(SPEC);

    expect(wrapper.find(".dead-end").text()).toContain("needs the URL this document is served from");
    expect(wrapper.findAll(".choice")).toHaveLength(0);
    // No "Detected: …" line either — there is nothing to correct, so a correction
    // affordance would only invite one of the six wrong answers back.
    expect(wrapper.find(".detected").exists()).toBe(false);
  });

  it("keeps saying so when a source the user picked earlier is still standing", () => {
    // Reachable order of events: pick "MCP server" for a URL, then paste a spec
    // into the same field. The parent's override survives an edit on purpose, so
    // the field would otherwise claim "Registering as: MCP server." over text that
    // cannot be registered as anything.
    const wrapper = mountField(SPEC, { activeSource: "mcp", overridden: true });

    expect(wrapper.find(".dead-end").exists()).toBe(true);
    expect(wrapper.text()).not.toContain("Registering as");
    expect(wrapper.findAll(".choice")).toHaveLength(0);
  });
});
