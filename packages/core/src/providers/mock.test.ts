import { describe, expect, it } from "vitest";
import { MockMarketDataProvider, MockNewsProvider } from "./mock";

describe("mock providers", () => {
  it("returns universe and news", async () => {
    const market = new MockMarketDataProvider();
    const news = new MockNewsProvider();

    const universe = await market.getUniverse();
    const items = await news.getNews("AAPL", 3);

    expect(universe.length).toBeGreaterThan(0);
    expect(items[0].symbol).toBe("AAPL");
  });
});
