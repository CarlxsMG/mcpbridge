import { describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";
import ListWidget from "../ListWidget.vue";
import { emptyStores, type DashboardStores, type WidgetInstance } from "../widgetCatalog";
import type { AuditLogEntry } from "@/types/api";

function storesWith(auditLog: AuditLogEntry[]): DashboardStores {
  const s = emptyStores();
  s.auditLog = auditLog;
  return s;
}

const listWidget = (feed: string): WidgetInstance => ({
  id: "w",
  type: "list",
  w: 6,
  h: 2,
  options: { title: "Recent activity", feed },
});

describe("ListWidget", () => {
  it("renders one table row per feed entry", () => {
    const wrapper = mount(ListWidget, {
      props: {
        widget: listWidget("audit.recent"),
        stores: storesWith([
          { id: 1, actor: "me", action: "client.update", target: "a", detail: null, createdAt: Date.now(), hash: null },
          { id: 2, actor: "me", action: "tool.delete", target: "b", detail: null, createdAt: Date.now(), hash: null },
          { id: 3, actor: "me", action: "key.create", target: "c", detail: null, createdAt: Date.now(), hash: null },
        ]),
      },
    });
    expect(wrapper.findAll("tbody tr")).toHaveLength(3);
    expect(wrapper.find(".w-muted").exists()).toBe(false);
  });

  it("shows the feed's empty message when there are no rows", () => {
    const wrapper = mount(ListWidget, {
      props: { widget: listWidget("audit.recent"), stores: emptyStores() },
    });
    expect(wrapper.find(".w-muted").text()).toBe("No recent admin actions.");
  });
});
