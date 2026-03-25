import { describe, expect, it } from "vitest";
import { calculatePearsonCorrelation } from "./correlation";

describe("calculatePearsonCorrelation", () => {
  it("detects strong positive correlation", () => {
    const correlation = calculatePearsonCorrelation([1, 2, 3, 4, 5], [2, 4, 6, 8, 10]);
    expect(correlation).toBeGreaterThan(0.99);
  });

  it("detects strong negative correlation", () => {
    const correlation = calculatePearsonCorrelation([1, 2, 3, 4, 5], [10, 8, 6, 4, 2]);
    expect(correlation).toBeLessThan(-0.99);
  });
});
