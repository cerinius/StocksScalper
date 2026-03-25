import { describe, expect, it } from "vitest";
import { calculateHalfKellyMultiplier } from "./kelly";

describe("calculateHalfKellyMultiplier", () => {
  it("returns a larger multiplier for stronger validated edge", () => {
    const strong = calculateHalfKellyMultiplier({
      winRateEstimate: 0.62,
      riskReward: 2.2,
      confidenceScore: 84,
    });
    const weak = calculateHalfKellyMultiplier({
      winRateEstimate: 0.48,
      riskReward: 1.1,
      confidenceScore: 52,
    });

    expect(strong).toBeGreaterThan(weak);
    expect(strong).toBeLessThanOrEqual(1);
    expect(weak).toBeGreaterThanOrEqual(0.25);
  });
});
