import { describe, expect, it } from "vitest";
import { buildListEnvelope, defaultEmptyMessage, parseListQuery } from "./pagination";

describe("parseListQuery", () => {
  it("applies defaults and clamps to safe ranges", () => {
    expect(parseListQuery({})).toEqual({
      page: 1,
      pageSize: 25,
      sort: "createdAt",
      direction: "desc",
    });
  });

  it("honours supplied values when they are in range", () => {
    expect(
      parseListQuery(
        { page: "3", pageSize: "50", sort: "detectedAt", direction: "asc" },
        { sort: "createdAt", direction: "desc" },
      ),
    ).toEqual({ page: 3, pageSize: 50, sort: "detectedAt", direction: "asc" });
  });

  it("clamps absurdly large page sizes and invalid pages", () => {
    expect(parseListQuery({ page: "-1", pageSize: "99999" }).page).toBe(1);
    expect(parseListQuery({ page: "-1", pageSize: "99999" }).pageSize).toBe(200);
  });

  it("falls back to 'desc' for any non-asc direction string", () => {
    expect(parseListQuery({ direction: "sideways" }).direction).toBe("desc");
  });
});

describe("buildListEnvelope", () => {
  it("computes hasMore and pageCount correctly for a mid-range page", () => {
    const env = buildListEnvelope({
      items: [1, 2, 3, 4, 5],
      total: 47,
      page: 2,
      pageSize: 5,
      sort: { field: "detectedAt", direction: "desc" },
    });
    expect(env.meta.pageCount).toBe(10);
    expect(env.meta.hasMore).toBe(true);
    expect(env.meta.emptyReason).toBeUndefined();
  });

  it("attaches an emptyReason + message when there are no items", () => {
    const env = buildListEnvelope({
      items: [] as number[],
      total: 0,
      page: 1,
      pageSize: 25,
      sort: { field: "createdAt", direction: "desc" },
      emptyReason: "no_data_yet",
    });
    expect(env.meta.emptyReason).toBe("no_data_yet");
    expect(env.meta.emptyMessage).toBe(defaultEmptyMessage("no_data_yet"));
    expect(env.meta.hasMore).toBe(false);
  });

  it("never marks the final page as having more", () => {
    const env = buildListEnvelope({
      items: [1],
      total: 1,
      page: 1,
      pageSize: 25,
      sort: { field: "createdAt", direction: "desc" },
    });
    expect(env.meta.hasMore).toBe(false);
    expect(env.meta.pageCount).toBe(1);
  });
});
