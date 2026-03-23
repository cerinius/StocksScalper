import type { DailyBar, NewsItem, PriceBar, Timeframe, UniverseCandidate } from "../types";
import type { MarketDataProvider } from "./market-data";
import type { NewsProvider } from "./news";
import { createMockBars, createMockHeadline } from "@stock-radar/shared";

const sampleSymbols = ["AAPL", "MSFT", "NVDA", "TSLA", "AMZN", "META", "AMD", "NFLX"];

const makeDailyBars = (days: number): DailyBar[] =>
  Array.from({ length: days }).map((_, idx) => {
    const base = 100 + idx * 0.3;
    return {
      date: new Date(Date.now() - idx * 86_400_000).toISOString().slice(0, 10),
      open: base,
      high: base * 1.02,
      low: base * 0.98,
      close: base * 1.01,
      volume: 2_500_000 + idx * 10_000,
    };
  });

const makeIntradayBars = (days: number, timeframe: "1m" | "5m"): DailyBar[] => {
  const stepMs = timeframe === "1m" ? 60_000 : 300_000;
  const points = days * 24;

  return Array.from({ length: points }).map((_, idx) => {
    const drift = idx * 0.12;
    const base = 100 + drift;
    const ts = Date.now() - idx * stepMs;

    return {
      date: new Date(ts).toISOString(),
      open: base,
      high: base * 1.004,
      low: base * 0.996,
      close: base * 1.002,
      volume: 150_000 + idx * 1_000,
    };
  });
};

export class MockMarketDataProvider implements MarketDataProvider {
  async getUniverse(): Promise<UniverseCandidate[]> {
    return sampleSymbols.map((symbol, idx) => ({
      symbol,
      metrics: {
        price: 50 + idx * 10,
        dollarVolume: 80_000_000 + idx * 5_000_000,
        avgVolume: 3_000_000 + idx * 100_000,
        atrPct: 2.5 + idx * 0.1,
        rvol: 1.2 + idx * 0.05,
        trendScore: 0.6 + idx * 0.02,
        catalystScore: 0.4 + idx * 0.03,
      },
    }));
  }

  async getDailyBars(_symbol: string, days: number): Promise<DailyBar[]> {
    return makeDailyBars(days);
  }

  async getIntradayBars(_symbol: string, timeframe: "1m" | "5m", days: number): Promise<DailyBar[]> {
    return makeIntradayBars(days, timeframe);
  }

  async getPriceBars(symbol: string, timeframe: Timeframe, bars: number): Promise<PriceBar[]> {
    return createMockBars(symbol, timeframe, bars, symbol.length);
  }
}

export class MockNewsProvider implements NewsProvider {
  async getNews(symbol: string, days: number): Promise<NewsItem[]> {
    return Array.from({ length: Math.min(days, 3) }).map((_, idx) => ({
      symbol,
      publishedAt: new Date(Date.now() - idx * 86_400_000).toISOString(),
      headline: `${symbol} catalyst update ${idx + 1}`,
      source: "MockWire",
      url: `https://example.com/${symbol}/${idx}`,
      summary: "Mock news item for offline development.",
      tags: ["earnings", "guidance"].slice(0, idx + 1),
    }));
  }

  async getMacroNews(limit: number): Promise<NewsItem[]> {
    return Array.from({ length: limit }).map((_, idx) => ({
      symbol: idx % 2 === 0 ? "SPY" : "XAUUSD",
      publishedAt: new Date(Date.now() - idx * 3_600_000).toISOString(),
      headline: createMockHeadline(idx % 2 === 0 ? "SPY" : "XAUUSD", idx),
      source: "MockMacro",
      url: `https://example.com/macro/${idx}`,
      summary:
        idx % 2 === 0
          ? "Macro tape remains sensitive to rates, liquidity, and growth data."
          : "Commodity markets are reacting to cross-asset volatility and geopolitical headlines.",
      tags: idx % 2 === 0 ? ["rates", "macro"] : ["commodities", "risk"],
    }));
  }
}
