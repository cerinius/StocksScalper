import { describe, expect, it } from "vitest";
import { scoreUniverse } from "./normalize";

const sample = [
  {
    symbol: "AAA",
    metrics: {
      price: 10,
      dollarVolume: 100,
      avgVolume: 10,
      atrPct: 2,
      rvol: 1,
      trendScore: 0.5,
      catalystScore: 0.2,
    },
  },
  {
    symbol: "BBB",
    metrics: {
      price: 20,
      dollarVolume: 200,
      avgVolume: 20,
      atrPct: 4,
      rvol: 2,
      trendScore: 0.8,
      catalystScore: 0.5,
    },
  },
];

describe("scoreUniverse", () => {
  it("normalizes and scores candidates", () => {
    const scored = scoreUniverse(sample, {
      liquidity: 35,
      volatility: 25,
      volume: 20,
      trend: 10,
      catalyst: 10,
    });
    expect(scored).toHaveLength(2);
    expect(scored[1].totalScore).toBeGreaterThan(scored[0].totalScore);
  });
});
