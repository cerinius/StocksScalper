import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  describeEmptyReason,
  formatRelativeTime,
  toQueryString,
  type ListMeta,
} from "./api";

describe("toQueryString", () => {
  it("drops blanks, nulls, undefineds, and empty arrays", () => {
    const qs = toQueryString({
      a: "value",
      b: "",
      c: null,
      d: undefined,
      e: [],
    });
    expect(qs).toBe("?a=value");
  });

  it("joins arrays with commas so multi-select filters survive the round-trip", () => {
    const qs = toQueryString({ status: ["NEW", "VALIDATED"] });
    expect(qs).toBe("?status=NEW%2CVALIDATED");
  });

  it("keeps numeric and boolean values so pagination & toggles are preserved", () => {
    const qs = toQueryString({ page: 2, pageSize: 25, blockingOnly: true });
    // Order in URLSearchParams is insertion order, which is deterministic.
    expect(qs).toBe("?page=2&pageSize=25&blockingOnly=true");
  });

  it("returns an empty string when everything is filtered out — so routes stay clean", () => {
    expect(toQueryString({ a: "", b: undefined, c: [] })).toBe("");
  });
});

describe("formatRelativeTime", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-15T12:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("reports the latest activity bucket so a stalled pipeline is visible", () => {
    expect(formatRelativeTime(new Date("2026-04-15T11:59:58Z").toISOString())).toBe("just now");
    expect(formatRelativeTime(new Date("2026-04-15T11:59:30Z").toISOString())).toBe("30s ago");
    expect(formatRelativeTime(new Date("2026-04-15T11:55:00Z").toISOString())).toBe("5m ago");
    expect(formatRelativeTime(new Date("2026-04-15T09:00:00Z").toISOString())).toBe("3h ago");
    expect(formatRelativeTime(new Date("2026-04-13T12:00:00Z").toISOString())).toBe("2d ago");
  });

  it("handles null / undefined so the UI never throws on missing timestamps", () => {
    expect(formatRelativeTime(null)).toBe("never");
    expect(formatRelativeTime(undefined)).toBe("never");
  });
});

describe("describeEmptyReason", () => {
  const cases: Array<[ListMeta["emptyReason"], string]> = [
    ["no_data_yet", "Nothing has been recorded here yet. New entries will appear automatically."],
    ["no_matches", "No records match the current filters. Try broadening the search."],
    ["filter_too_narrow", "Filters are too narrow — relax at least one to see results."],
    ["loading_failed", "The request failed while loading. Use the refresh button to try again."],
  ];

  it.each(cases)("distinguishes %s so operators know whether to clear filters or check ingestion", (reason, expected) => {
    expect(describeEmptyReason(reason)).toBe(expected);
  });

  it("prefers the server's custom message when the envelope includes one", () => {
    expect(describeEmptyReason("no_data_yet", "Ingest worker is starting up.")).toBe("Ingest worker is starting up.");
  });

  it("falls back to a safe default for an unknown reason", () => {
    expect(describeEmptyReason(undefined)).toBe("No results.");
  });
});
