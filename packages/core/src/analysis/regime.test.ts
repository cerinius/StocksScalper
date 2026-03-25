import { describe, expect, it } from "vitest";
import type { PriceBar } from "@stock-radar/types";
import { calculateIndicatorSnapshot } from "./indicators";
import { detectMarketRegime } from "./regime";

const makeBars = (direction: "up" | "down" | "flat", volatility = 1): PriceBar[] =>
  Array.from({ length: 60 }).map((_, index) => {
    const drift = direction === "up" ? index * 0.45 : direction === "down" ? index * -0.42 : Math.sin(index / 4) * 0.35;
    const base = 100 + drift;
    const range = 0.7 * volatility + (index % 3) * 0.15;

    return {
      symbol: "TEST",
      timeframe: "5m",
      timestamp: new Date(Date.now() - (60 - index) * 300_000).toISOString(),
      open: base,
      high: base + range,
      low: base - range,
      close: base + (direction === "flat" ? Math.sin(index / 3) * 0.2 : direction === "up" ? 0.25 : -0.25),
      volume: 100_000 + index * (direction === "flat" ? 150 : 1_200),
    };
  });

describe("detectMarketRegime", () => {
  it("identifies directional trend regimes", () => {
    const bars = makeBars("up", 0.8);
    const regime = detectMarketRegime(bars, calculateIndicatorSnapshot(bars));

    expect(regime.regime).toBe("bull_trend");
    expect(regime.directionBias).toBe("LONG");
    expect(regime.preferredStrategy).toBe("trend");
  });

  it("identifies range behavior when trend is muted", () => {
    const bars = makeBars("flat", 0.7);
    const regime = detectMarketRegime(bars, calculateIndicatorSnapshot(bars));

    expect(["range_mean_reversion", "volatile_reversal"]).toContain(regime.regime);
  });
});
