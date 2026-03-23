import { describe, expect, it } from "vitest";
import { makeExecutionDecision } from "./decision-engine";

describe("makeExecutionDecision", () => {
  it("blocks trading when the kill switch is active", () => {
    const result = makeExecutionDecision({
      candidate: {
        symbol: "AAPL",
        timeframe: "5m",
        direction: "LONG",
        strategyType: "breakout_continuation",
        detectedAt: new Date().toISOString(),
        currentPrice: 190,
        proposedEntry: 190,
        stopLoss: 188,
        takeProfit: 194,
        riskReward: 2,
        confidenceScore: 78,
        setupScore: 80,
        featureValues: {},
        indicatorSnapshot: {
          sma20: 180,
          sma50: 175,
          ema21: 181,
          ema50: 176,
          rsi14: 63,
          macd: 1.2,
          macdSignal: 0.9,
          atr14: 3,
          atrPct: 1.6,
          volumeRatio: 1.4,
          trendStrength: 50,
          momentumScore: 60,
        },
        reasoningLog: [],
        status: "VALIDATED",
        correlationTags: ["tech"],
        volatilityClassification: "medium",
      },
      validation: {
        winRateEstimate: 0.58,
        averageReturn: 4.2,
        averageAdverseExcursion: 0.6,
        averageFavorableExcursion: 1.8,
        maxDrawdown: 1.2,
        profitFactor: 1.7,
        expectancy: 0.52,
        confidenceScore: 74,
        confidenceIntervalLow: 0.2,
        confidenceIntervalHigh: 0.8,
        historicalSampleSize: 24,
        dataQualityNotes: [],
      },
      account: {
        balance: 100000,
        equity: 99500,
        freeMargin: 80000,
        usedMargin: 19500,
        openPnl: -500,
        realizedPnlDaily: -250,
        drawdownPct: 1.2,
        maxDrawdownPct: 2.6,
        riskState: "NORMAL",
        killSwitchActive: true,
        mode: "paper",
      },
      openPositions: [],
      riskLimits: {
        maxActiveTrades: 4,
        maxDailyLossPct: 3,
        maxRiskPerTradePct: 0.75,
        maxTotalExposurePct: 20,
        maxSymbolExposurePct: 8,
        maxCorrelatedExposurePct: 12,
        staleSignalSeconds: 300,
        manualApprovalMode: false,
      },
      references: [],
    });

    expect(result.action).toBe("SKIP");
    expect(result.blockingReasons.length).toBeGreaterThan(0);
  });
});
