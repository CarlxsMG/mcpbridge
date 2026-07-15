// useCursorPagination has no lifecycle hooks or injected context (unlike
// useQueryFilters, which needs a real router) — it's safe to call directly
// without mounting a host component, same as usePatchResource.test.ts.
import { describe, expect, it, vi } from "vitest";
import { useCursorPagination } from "../useCursorPagination";
import type { PaginatedResult } from "@/types/api";

function makeFetch<T>(pages: Record<string, PaginatedResult<T>>) {
  return vi.fn((cursor?: string) => Promise.resolve(pages[cursor ?? "start"]));
}

describe("useCursorPagination", () => {
  it("next()/prev() push and pop the cursor stack symmetrically", async () => {
    const fetchPage = makeFetch<number>({
      start: { items: [1, 2], nextCursor: "p2" },
      p2: { items: [3, 4], nextCursor: "p3" },
      p3: { items: [5, 6], nextCursor: undefined },
    });
    const pagination = useCursorPagination(fetchPage);
    await pagination.load();
    await pagination.next();
    await pagination.next();
    expect(pagination.items.value).toEqual([5, 6]);

    await pagination.prev();
    expect(fetchPage).toHaveBeenLastCalledWith("p2");
    expect(pagination.items.value).toEqual([3, 4]);

    await pagination.prev();
    expect(fetchPage).toHaveBeenLastCalledWith(undefined);
    expect(pagination.items.value).toEqual([1, 2]);
    expect(pagination.hasPrev.value).toBe(false);
  });

  it("hasNext/hasPrev reflect nextCursor presence and cursor-stack depth", async () => {
    const fetchPage = makeFetch<number>({
      start: { items: [1], nextCursor: "p2" },
      p2: { items: [2], nextCursor: undefined },
    });
    const pagination = useCursorPagination(fetchPage);
    expect(pagination.hasNext.value).toBe(false);
    expect(pagination.hasPrev.value).toBe(false);

    await pagination.load();
    expect(pagination.hasNext.value).toBe(true);
    expect(pagination.hasPrev.value).toBe(false);

    await pagination.next();
    expect(pagination.hasNext.value).toBe(false);
    expect(pagination.hasPrev.value).toBe(true);
  });

  it("onCursorChange fires with the destination cursor on next() and the popped cursor on prev()", async () => {
    const fetchPage = makeFetch<number>({
      start: { items: [1], nextCursor: "p2" },
      p2: { items: [2], nextCursor: undefined },
    });
    const onCursorChange = vi.fn();
    const pagination = useCursorPagination(fetchPage, { onCursorChange });
    await pagination.load();

    await pagination.next();
    expect(onCursorChange).toHaveBeenLastCalledWith("p2");

    await pagination.prev();
    expect(onCursorChange).toHaveBeenLastCalledWith(undefined);
  });

  it("next()/prev() are no-ops with no fetch or callback when there is nowhere to go", async () => {
    const fetchPage = makeFetch<number>({ start: { items: [1], nextCursor: undefined } });
    const onCursorChange = vi.fn();
    const pagination = useCursorPagination(fetchPage, { onCursorChange });
    await pagination.load();

    await pagination.next();
    expect(fetchPage).toHaveBeenCalledTimes(1);
    expect(onCursorChange).not.toHaveBeenCalled();

    await pagination.prev();
    expect(fetchPage).toHaveBeenCalledTimes(1);
    expect(onCursorChange).not.toHaveBeenCalled();
  });

  it("loadMore appends fetched items instead of replacing them", async () => {
    const fetchPage = makeFetch<number>({
      start: { items: [1, 2], nextCursor: "p2" },
      p2: { items: [3, 4], nextCursor: undefined },
    });
    const pagination = useCursorPagination(fetchPage);
    await pagination.load();
    expect(pagination.items.value).toEqual([1, 2]);

    await pagination.loadMore();
    expect(pagination.items.value).toEqual([1, 2, 3, 4]);
    expect(pagination.hasNext.value).toBe(false);
  });

  it("reset() clears the cursor stack and current cursor", async () => {
    const fetchPage = makeFetch<number>({
      start: { items: [1], nextCursor: "p2" },
      p2: { items: [2], nextCursor: undefined },
    });
    const pagination = useCursorPagination(fetchPage);
    await pagination.load();
    await pagination.next();
    expect(pagination.hasPrev.value).toBe(true);

    pagination.reset();
    expect(pagination.hasPrev.value).toBe(false);
  });
});
