import type { DailyBar, NewsItem, UniverseCandidate } from "../types";
import type { MarketDataProvider } from "./market-data";
import type { NewsProvider } from "./news";

const sampleSymbols = ["AAPL", "MSFT", "NVDA", "TSLA", "AMZN", "META", "AMD", "NFLX"];

const makeBars = (days: number): DailyBar[] =>
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
    return makeBars(days);
  }

  async getIntradayBars(_symbol: string, _timeframe: "1m" | "5m", days: number): Promise<DailyBar[]> {
    return makeBars(days);
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
}
