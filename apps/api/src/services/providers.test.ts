import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { createProviders } from "./providers";

describe("createProviders", () => {
  const originalEnv = process.env;

  beforeAll(() => {
    process.env = { ...originalEnv };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it("returns mock providers by default", () => {
    delete process.env.NEWS_PROVIDER;
    process.env.DATA_PROVIDER = "mock";
    const providers = createProviders();
    expect(providers.market).toBeTruthy();
    expect(typeof providers.market.getUniverse).toBe("function");
    expect(providers.news).toBeTruthy();
    expect(typeof providers.news.getNews).toBe("function");
  });

  it("returns polygon news provider when configured", () => {
    process.env.NEWS_PROVIDER = "polygon";
    process.env.MASSIVE_API_KEY = "dummy-key";
    const providers = createProviders();
    expect(providers.news).toBeTruthy();
    expect(typeof providers.news.getNews).toBe("function");
  });
});
