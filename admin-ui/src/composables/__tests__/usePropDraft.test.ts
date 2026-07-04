import { describe, expect, it } from "vitest";
import { reactive, nextTick } from "vue";
import { usePropDraft } from "../useDraftField";

describe("usePropDraft", () => {
  it("seeds the draft from source() at creation time", () => {
    const props = reactive({ tags: ["a", "b"] });

    const draft = usePropDraft(() => props.tags.join(", "));

    expect(draft.value).toBe("a, b");
  });

  it("re-syncs the draft when source's reactive dependency changes", async () => {
    const props = reactive({ tags: ["a", "b"] });
    const draft = usePropDraft(() => props.tags.join(", "));

    props.tags = ["c", "d", "e"];
    await nextTick();

    expect(draft.value).toBe("c, d, e");
  });

  it("does not re-sync from a local mutation to the draft until source changes again", async () => {
    const props = reactive({ tags: ["a", "b"] });
    const draft = usePropDraft(() => props.tags.join(", "));

    draft.value = "locally edited";
    await nextTick();
    expect(draft.value).toBe("locally edited");

    // No change to props.tags yet, so the local edit should stick.
    await nextTick();
    expect(draft.value).toBe("locally edited");

    // Only once the source itself changes does the draft get overwritten.
    props.tags = ["z"];
    await nextTick();
    expect(draft.value).toBe("z");
  });
});
