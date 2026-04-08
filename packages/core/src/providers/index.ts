import { getPlatformConfig } from "@stock-radar/config";
import { AlphaVantageNewsProvider } from "./alpha-vantage";
import { FinnhubNewsProvider } from "./finnhub-news";
import { MockNewsProvider, MockMarketDataProvider } from "./mock";
import { NewsProvider } from "./news";
import { MarketDataProvider } from "./market-data";
import { PolygonNewsProvider } from "./polygon";
import { AlphaVantageMarketDataProvider } from "./alpha-vantage-market";
import { MassiveMarketDataProvider } from "./massive";
import { YahooFinanceMarketDataProvider } from "./yahoo-finance-market";

export * from "./market-data";
export * from "./news";
export * from "./mock";
export * from "./massive";
export * from "./polygon";
export * from "./execution";
export * from "./alpha-vantage";
export * from "./alpha-vantage-market";
export * from "./yahoo-finance-market";
export * from "./finnhub-news";

// ─── News provider factory ────────────────────────────────────────────────────

export const createNewsProvider = (): NewsProvider => {
  const config = getPlatformConfig();
  switch (config.news.provider) {
    case "mock":
      return new MockNewsProvider();

    case "finnhub":
      if (!config.news.finnhub.apiKey) {
        console.warn("[providers] FINNHUB_API_KEY not set — falling back to mock news. Get a free key at https://finnhub.io/register");
        return new MockNewsProvider();
      }
      return new FinnhubNewsProvider({
        apiKey: config.news.finnhub.apiKey,
        lookbackDays: 3,
      });

    case "alpha_vantage":
      return new AlphaVantageNewsProvider({
        apiKey: config.news.alphaVantage.apiKey,
      });

    case "polygon":
      return new PolygonNewsProvider({
        apiKey: config.marketData.massive.apiKey,
      });

    default:
      throw new Error(`Unsupported news provider: ${config.news.provider}`);
  }
};

// ─── Market data provider factory ────────────────────────────────────────────

export const createMarketDataProvider = (): MarketDataProvider => {
  const config = getPlatformConfig();

  switch (config.marketDataProvider) {
    case "yahoo_finance":
      // Yahoo Finance: free, no API key required.
      return new YahooFinanceMarketDataProvider({ rateLimitMs: 200 });

    case "polygon":
      if (config.marketData.massive.apiKey) {
        return new MassiveMarketDataProvider({
          apiKey: config.marketData.massive.apiKey,
          restBaseUrl: config.marketData.massive.restBaseUrl,
        });
      }
      console.warn("[providers] POLYGON_API_KEY not set — falling back to Yahoo Finance");
      return new YahooFinanceMarketDataProvider({ rateLimitMs: 200 });

    case "alpha_vantage":
      if (config.marketData.alphaVantage.apiKey) {
        return new AlphaVantageMarketDataProvider({
          apiKey: config.marketData.alphaVantage.apiKey,
        });
      }
      console.warn("[providers] ALPHA_VANTAGE_API_KEY not set — falling back to Yahoo Finance");
      return new YahooFinanceMarketDataProvider({ rateLimitMs: 200 });

    case "mock":
      return new MockMarketDataProvider();

    default:
      // Safe default: Yahoo Finance always works without credentials
      return new YahooFinanceMarketDataProvider({ rateLimitMs: 200 });
  }
};
