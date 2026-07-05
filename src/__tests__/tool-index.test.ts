import { describe, test, expect } from "bun:test";
import { ToolIndex } from "../mcp/tool-index.js";

describe("ToolIndex — set / get / delete", () => {
  test("set then get roundtrips", () => {
    const i = new ToolIndex();
    i.set("a__b", { clientName: "a", toolName: "b" });
    expect(i.get("a__b")).toEqual({ clientName: "a", toolName: "b" });
  });

  test("setTool builds the canonical key from name parts", () => {
    const i = new ToolIndex();
    i.setTool("a", "b");
    expect(i.get("a__b")).toEqual({ clientName: "a", toolName: "b" });
  });

  test("delete returns true when present, false when absent", () => {
    const i = new ToolIndex();
    i.setTool("a", "b");
    expect(i.delete("a__b")).toBe(true);
    expect(i.delete("a__b")).toBe(false);
    expect(i.size()).toBe(0);
  });

  test("deleteTool works by parts", () => {
    const i = new ToolIndex();
    i.setTool("a", "b");
    expect(i.deleteTool("a", "b")).toBe(true);
    expect(i.size()).toBe(0);
  });
});

describe("ToolIndex — deleteForClient", () => {
  test("removes only entries with the matching prefix", () => {
    const i = new ToolIndex();
    i.setTool("acme", "t1");
    i.setTool("acme", "t2");
    i.setTool("acme-evil", "t3");
    const removed = i.deleteForClient("acme");
    expect(removed).toBe(2);
    expect(i.size()).toBe(1);
    expect(i.get("acme-evil__t3")).toEqual({ clientName: "acme-evil", toolName: "t3" });
  });

  test("returns 0 when no entries match", () => {
    const i = new ToolIndex();
    i.setTool("other", "x");
    expect(i.deleteForClient("acme")).toBe(0);
    expect(i.size()).toBe(1);
  });
});

describe("ToolIndex — clearAll / size diagnostics", () => {
  test("clearAll empties the index", () => {
    const i = new ToolIndex();
    i.setTool("a", "x");
    i.setTool("b", "y");
    expect(i.size()).toBe(2);
    i.clearAll();
    expect(i.size()).toBe(0);
  });
});
