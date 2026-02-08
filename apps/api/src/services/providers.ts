import { MockMarketDataProvider, MockNewsProvider } from "@stock-radar/core";
import type { MarketDataProvider, NewsProvider } from "@stock-radar/core";

export interface ProviderBundle {
  market: MarketDataProvider;
  news: NewsProvider;
}

export const createProviders = (): ProviderBundle => {
  const marketProvider = process.env.DATA_PROVIDER ?? "mock";
  const newsProvider = process.env.NEWS_PROVIDER ?? "mock";

  if (marketProvider !== "mock") {
    // Placeholder for Polygon or other providers.
    // TODO: implement real provider adapter.
  }

  if (newsProvider !== "mock") {
    // Placeholder for Polygon or other providers.
    // TODO: implement real provider adapter.
  }

  return {
    market: new MockMarketDataProvider(),
    news: new MockNewsProvider(),
  };
};
