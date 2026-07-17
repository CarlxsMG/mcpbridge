// a11y wiring for SchemaForm.vue (#8): each field's description <p> gets an id
// that every control references via aria-describedby, and enum/checkbox controls
// carry aria-required. The enum control is a real SelectMenu, so this also proves
// those two attributes reach the role="combobox" button (declared as props there,
// not left to fall through onto the wrapper div).
import { afterEach, describe, expect, it } from "vitest";
import { mount, type VueWrapper } from "@vue/test-utils";
import SchemaForm from "../SchemaForm.vue";

const SCHEMA = {
  properties: {
    q: { type: "string", description: "The search query" },
    verbose: { type: "boolean", description: "Verbose output" },
    mode: { enum: ["fast", "slow"], description: "Run mode" },
    bare: { type: "string" },
  },
  required: ["q", "verbose", "mode"],
};

let wrapper: VueWrapper | null = null;
function mountForm() {
  wrapper = mount(SchemaForm, { props: { schema: SCHEMA, modelValue: {} } });
  return wrapper;
}

afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
});

describe("SchemaForm accessibility", () => {
  it("links a string input to its description and keeps native required", () => {
    const w = mountForm();
    expect(w.find("#sf-q-desc").text()).toBe("The search query");
    expect(w.find("#sf-q").attributes("aria-describedby")).toBe("sf-q-desc");
    expect(w.find("#sf-q").attributes("required")).toBeDefined();
  });

  it("marks a required checkbox with aria-required and links its description", () => {
    const w = mountForm();
    const checkbox = w.find("#sf-verbose");
    expect(checkbox.attributes("aria-required")).toBe("true");
    expect(checkbox.attributes("aria-describedby")).toBe("sf-verbose-desc");
  });

  it("puts aria-required and aria-describedby on the enum's combobox button", () => {
    const w = mountForm();
    const combobox = w.find("#sf-mode");
    expect(combobox.attributes("role")).toBe("combobox");
    expect(combobox.attributes("aria-required")).toBe("true");
    expect(combobox.attributes("aria-describedby")).toBe("sf-mode-desc");
  });

  it("omits aria-describedby when a field has no description", () => {
    const w = mountForm();
    expect(w.find("#sf-bare").attributes("aria-describedby")).toBeUndefined();
  });
});
