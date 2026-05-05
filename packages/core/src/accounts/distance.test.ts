import { describe, expect, it } from "vitest";
import { computeDistanceSummary } from "./distance";

describe("computeDistanceSummary", () => {
  const limits = {
    dailyLossLimitUsd: 500,
    totalLossLimitUsd: 2_000,
    trailingDrawdownUsd: null,
    profitTargetUsd: 1_000,
    startingBalance: 10_000,
  };

  it("returns zero-usage summary when no losses", () => {
    const s = computeDistanceSummary(
      { dailyLossUsd: 0, totalLossUsd: 0, trailingDrawdownUsd: null },
      limits,
      10_500,
    );
    expect(s.dailyLossUsedPct).toBe(0);
    expect(s.totalLossUsedPct).toBe(0);
    expect(s.dailyBreached).toBe(false);
    expect(s.totalBreached).toBe(false);
    expect(s.anyBreached).toBe(false);
    expect(s.distanceToTargetUsd).toBe(500);
    expect(s.distanceToTargetPct).toBeCloseTo(0.5);
  });

  it("flags daily breach when loss meets limit", () => {
    const s = computeDistanceSummary(
      { dailyLossUsd: 500, totalLossUsd: 500, trailingDrawdownUsd: null },
      limits,
      9_500,
    );
    expect(s.dailyBreached).toBe(true);
    expect(s.anyBreached).toBe(true);
    expect(s.dailyLossRemainingUsd).toBe(0);
  });

  it("flags total breach when loss exceeds limit", () => {
    const s = computeDistanceSummary(
      { dailyLossUsd: 100, totalLossUsd: 2_500, trailingDrawdownUsd: null },
      limits,
      7_500,
    );
    expect(s.totalBreached).toBe(true);
    expect(s.anyBreached).toBe(true);
  });

  it("computes trailing DD when configured", () => {
    const s = computeDistanceSummary(
      { dailyLossUsd: 0, totalLossUsd: 0, trailingDrawdownUsd: 300 },
      { ...limits, trailingDrawdownUsd: 400 },
      10_000,
    );
    expect(s.trailingLossUsedPct).toBeCloseTo(0.75);
    expect(s.trailingBreached).toBe(false);
    expect(s.trailingLossRemainingUsd).toBe(100);
  });

  it("returns null distance-to-target when target unset", () => {
    const s = computeDistanceSummary(
      { dailyLossUsd: 0, totalLossUsd: 0, trailingDrawdownUsd: null },
      { ...limits, profitTargetUsd: null },
      10_000,
    );
    expect(s.distanceToTargetUsd).toBeNull();
    expect(s.distanceToTargetPct).toBeNull();
  });
});
