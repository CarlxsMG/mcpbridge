import { describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";
import NoteWidget from "../NoteWidget.vue";
import type { WidgetInstance } from "../widgetCatalog";

const noteWidget = (text: string): WidgetInstance => ({
  id: "n",
  type: "note",
  w: 4,
  h: 1,
  options: { title: "Note", text },
});

describe("NoteWidget", () => {
  it("renders markdown but never injects raw HTML", () => {
    const wrapper = mount(NoteWidget, {
      props: { widget: noteWidget("# Hi\n\n<script>alert(1)</script> see http://ok.test") },
    });
    const html = wrapper.html();
    expect(html).toContain("<h3>Hi</h3>");
    expect(html).toContain('href="http://ok.test"');
    expect(html).not.toContain("<script>alert");
  });
});
