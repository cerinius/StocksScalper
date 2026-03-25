import { describe, expect, it } from "vitest";
import { runMonteCarloSimulation } from "./monte-carlo";

describe("runMonteCarloSimulation", () => {
  it("produces stable drawdown and ruin metrics", () => {
    const summary = runMonteCarloSimulation([1.5, -1, 0.8, 2.2, -0.6, 1.1, -0.9], {
      simulations: 250,
      riskPerTradePct: 0.75,
      ruinDrawdownPct: 8,
      seed: 7,
    });

    expect(summary.simulations).toBe(250);
    expect(summary.drawdownPct95).toBeGreaterThanOrEqual(summary.drawdownPct50);
    expect(summary.riskOfRuinPct).toBeGreaterThanOrEqual(0);
    expect(summary.riskOfRuinPct).toBeLessThanOrEqual(1);
  });
});
