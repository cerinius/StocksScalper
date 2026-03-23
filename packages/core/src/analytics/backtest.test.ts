import { describe, expect, it } from "vitest";
import { backtestSetup, buildStrategyScorecards, getTradeLevels } from "./backtest";

describe("backtest analytics", () => {
  it("derives levels from setup records", () => {
    const levels = getTradeLevels({
      trigger: { level: 100 },
      invalidation: { level: 95 },
      targets: { atrMultiple: 2 },
    });

    expect(levels.entry).toBe(100);
    expect(levels.stop).toBe(95);
    expect(levels.target).toBe(110);
    expect(levels.riskReward).toBe(2);
  });

  it("marks a winning setup when target is reached after entry", () => {
    const result = backtestSetup(
      {
        id: "setup-1",
        symbol: "TEST",
        createdAt: "2024-01-01T00:00:00.000Z",
        setupType: "breakout_retest",
        timeframe: "swing",
        confidence: 78,
        trigger: { level: 100 },
        invalidation: { level: 95 },
        targets: { atrMultiple: 2 },
      },
      [
        { date: "2024-01-01", open: 97, high: 99, low: 96, close: 98, volume: 100000 },
        { date: "2024-01-02", open: 99, high: 101, low: 99, close: 100, volume: 100000 },
        { date: "2024-01-03", open: 101, high: 111, low: 100, close: 110, volume: 100000 },
      ],
    );

    expect(result.outcome).toBe("win");
    expect(result.rMultiple).toBe(2);
    expect(result.holdBars).toBe(2);
  });

  it("builds scorecards from closed and pending setups", () => {
    const scorecards = buildStrategyScorecards([
      {
        setupId: "1",
        symbol: "AAA",
        setupType: "breakout_retest",
        timeframe: "swing",
        createdAt: "2024-01-01T00:00:00.000Z",
        confidence: 80,
        entry: 100,
        stop: 95,
        target: 110,
        riskReward: 2,
        outcome: "win",
        entryAt: "2024-01-02T00:00:00.000Z",
        exitAt: "2024-01-03T00:00:00.000Z",
        holdBars: 2,
        rMultiple: 2,
        returnPct: 10,
      },
      {
        setupId: "2",
        symbol: "BBB",
        setupType: "breakout_retest",
        timeframe: "swing",
        createdAt: "2024-01-01T00:00:00.000Z",
        confidence: 60,
        entry: 50,
        stop: 47,
        target: 56,
        riskReward: 2,
        outcome: "loss",
        entryAt: "2024-01-02T00:00:00.000Z",
        exitAt: "2024-01-02T00:00:00.000Z",
        holdBars: 1,
        rMultiple: -1,
        returnPct: -6,
      },
      {
        setupId: "3",
        symbol: "CCC",
        setupType: "breakout_retest",
        timeframe: "swing",
        createdAt: "2024-01-01T00:00:00.000Z",
        confidence: 70,
        entry: 70,
        stop: 66,
        target: 78,
        riskReward: 2,
        outcome: "not_triggered",
        entryAt: null,
        exitAt: null,
        holdBars: 0,
        rMultiple: null,
        returnPct: null,
      },
    ]);

    expect(scorecards).toHaveLength(1);
    expect(scorecards[0].sampleSize).toBe(3);
    expect(scorecards[0].closedCount).toBe(2);
    expect(scorecards[0].winRate).toBe(0.5);
    expect(scorecards[0].pending).toBe(1);
    expect(scorecards[0].expectancyR).toBe(0.5);
  });
});
