import { getPlatformConfig } from "@stock-radar/config";
import { MassiveMarketDataProvider, MockMarketDataProvider, MockNewsProvider } from "@stock-radar/core";
import type { MarketDataProvider, NewsProvider } from "@stock-radar/core";

export interface ProviderBundle {
  market: MarketDataProvider;
  news: NewsProvider;
}

export const createProviders = (): ProviderBundle => {
  const config = getPlatformConfig();
  const marketProvider = config.dataProvider;
  const newsProvider = process.env.NEWS_PROVIDER ?? "mock";

  if (marketProvider === "massive" && config.marketData.massive.apiKey) {
    return {
      market: new MassiveMarketDataProvider({
        apiKey: config.marketData.massive.apiKey,
        restBaseUrl: config.marketData.massive.restBaseUrl,
        watchlistSymbols: config.watchlistSymbols,
      }),
      news: new MockNewsProvider(),
    };
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
