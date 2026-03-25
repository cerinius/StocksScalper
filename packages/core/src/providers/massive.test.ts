import { describe, expect, it } from "vitest";
import { resolveMassiveSymbol } from "./massive";

describe("resolveMassiveSymbol", () => {
  it("keeps stock tickers as stock subscriptions", () => {
    const symbol = resolveMassiveSymbol("AAPL");

    expect(symbol.assetType).toBe("stocks");
    expect(symbol.restTicker).toBe("AAPL");
    expect(symbol.websocketSubscriptions).toContain("A.AAPL");
  });

  it("maps fiat pairs to the forex feed", () => {
    const symbol = resolveMassiveSymbol("EURUSD");

    expect(symbol.assetType).toBe("forex");
    expect(symbol.restTicker).toBe("C:EURUSD");
    expect(symbol.websocketSubscriptions).toContain("CAS.EUR/USD");
    expect(symbol.dbAssetClass).toBe("FX");
  });

  it("maps metals to the forex feed but commodity asset class", () => {
    const symbol = resolveMassiveSymbol("XAUUSD");

    expect(symbol.assetType).toBe("forex");
    expect(symbol.restTicker).toBe("C:XAUUSD");
    expect(symbol.dbAssetClass).toBe("COMMODITY");
  });

  it("maps crypto pairs to the crypto feed", () => {
    const symbol = resolveMassiveSymbol("BTCUSD");

    expect(symbol.assetType).toBe("crypto");
    expect(symbol.restTicker).toBe("X:BTCUSD");
    expect(symbol.websocketSubscriptions).toContain("XAS.BTC-USD");
    expect(symbol.dbAssetClass).toBe("CRYPTO");
  });
});
