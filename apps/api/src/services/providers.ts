import { getPlatformConfig } from "@stock-radar/config";
import {
  AlphaVantageMarketDataProvider,
  MassiveMarketDataProvider,
  MockMarketDataProvider,
  MockNewsProvider,
  PolygonNewsProvider,
} from "@stock-radar/core";
import type { MarketDataProvider, NewsProvider } from "@stock-radar/core";

export interface ProviderBundle {
  market: MarketDataProvider;
  news: NewsProvider;
}

export const createProviders = (): ProviderBundle => {
  const config = getPlatformConfig();
  const marketProvider = config.marketDataProvider;
  const newsProvider = (process.env.NEWS_PROVIDER ?? "mock").toLowerCase();

  const market =
    marketProvider === "polygon" && config.marketData.massive.apiKey
      ? new MassiveMarketDataProvider({
          apiKey: config.marketData.massive.apiKey,
          restBaseUrl: config.marketData.massive.restBaseUrl,
          watchlistSymbols: config.watchlistSymbols,
        })
      : marketProvider === "alpha_vantage" && config.marketData.alphaVantage.apiKey
      ? new AlphaVantageMarketDataProvider({
          apiKey: config.marketData.alphaVantage.apiKey,
          watchlistSymbols: config.watchlistSymbols,
        })
      : new MockMarketDataProvider();

  let news: NewsProvider = new MockNewsProvider();

  if (newsProvider === "polygon" || newsProvider === "massive") {
    const apiKey = process.env.MASSIVE_API_KEY ?? "";
    if (apiKey) {
      news = new PolygonNewsProvider({ apiKey, restBaseUrl: process.env.POLYGON_REST_BASE_URL });
    }
  }

  return { market, news };
};
