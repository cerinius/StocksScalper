import { describe, expect, it } from "vitest";
import { detectSwingSetups } from "./swing";
import { detectScalpSetups } from "./scalp";

const bars = [
  { date: "2024-01-02", open: 100, high: 110, low: 95, close: 108, volume: 1000000 },
  { date: "2024-01-01", open: 98, high: 105, low: 94, close: 100, volume: 900000 },
];

describe("setup detectors", () => {
  it("detects swing setups", () => {
    const setups = detectSwingSetups({
      symbol: "TEST",
      bars,
      news: [{
        symbol: "TEST",
        publishedAt: new Date().toISOString(),
        headline: "Test",
        source: "Mock",
        url: "https://example.com",
      }],
      levels: {
        prevHigh: 105,
        prevLow: 94,
        weekHigh: 104,
        weekLow: 90,
      },
    });

    expect(setups.length).toBeGreaterThan(0);
  });

  it("detects scalp setups", () => {
    const setups = detectScalpSetups({
      symbol: "TEST",
      bars,
      vwap: 100,
      openingRangeHigh: 103,
      openingRangeLow: 97,
      yesterdayHigh: 104,
      yesterdayLow: 96,
    });

    expect(setups.length).toBeGreaterThan(0);
  });
});
