// Covers SelectMenu.vue's trigger-label resolution (the #30 fix) and the a11y
// props (#8) that must land on the role="combobox" button rather than the
// wrapper. The teleported listbox / keyboard nav is exercised indirectly by the
// components that mount SelectMenu; here we only assert the closed-trigger state.
import { afterEach, describe, expect, it } from "vitest";
import { mount, type VueWrapper } from "@vue/test-utils";
import SelectMenu from "../SelectMenu.vue";

type Opt = { value: string | null; label: string; disabled?: boolean };
const OPTIONS: Opt[] = [
  { value: "a", label: "Apple" },
  { value: "b", label: "Banana" },
];

let wrapper: VueWrapper | null = null;
function mountMenu(props: {
  modelValue: string | null;
  options?: Opt[];
  ariaRequired?: boolean;
  ariaDescribedby?: string;
}) {
  wrapper = mount(SelectMenu, { props: { options: OPTIONS, ...props } });
  return wrapper;
}
function triggerLabel(w: VueWrapper) {
  return w.find(".select-menu-value").text();
}

afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
});

describe("SelectMenu trigger label", () => {
  it("shows the matching option's label", () => {
    expect(triggerLabel(mountMenu({ modelValue: "b" }))).toBe("Banana");
  });

  it("falls back to the first option when the model is nullish", () => {
    // A per-row v-model like record[id] that's null/undefined until first touched.
    expect(triggerLabel(mountMenu({ modelValue: null }))).toBe("Apple");
  });

  it("prefers an explicit null-valued option over the first-option fallback", () => {
    const w = mountMenu({ modelValue: null, options: [{ value: null, label: "None" }, ...OPTIONS] });
    expect(triggerLabel(w)).toBe("None");
  });

  it("renders the raw value (never the first option) when a concrete value matches no option", () => {
    // The #30 regression: a stale team id / scope target must not be misrepresented
    // as options[0] ("Apple" / "None"); the model's actual value is surfaced instead.
    expect(triggerLabel(mountMenu({ modelValue: "ghost" }))).toBe("ghost");
  });
});

describe("SelectMenu a11y props", () => {
  it("binds aria-required and aria-describedby onto the combobox button, not the wrapper", () => {
    const w = mountMenu({ modelValue: "a", ariaRequired: true, ariaDescribedby: "sf-x-desc" });
    const button = w.find('[role="combobox"]');
    expect(button.attributes("aria-required")).toBe("true");
    expect(button.attributes("aria-describedby")).toBe("sf-x-desc");
    // and not leaked onto the wrapper div
    expect(w.find(".select-menu").attributes("aria-describedby")).toBeUndefined();
  });
});
