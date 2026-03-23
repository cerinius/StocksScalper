import { describe, expect, it } from "vitest";
import { scoreNewsIntelligence } from "./intelligence";

describe("scoreNewsIntelligence", () => {
  it("detects urgent macro language and directional tone", () => {
    const result = scoreNewsIntelligence({
      source: "MacroWire",
      headline: "Breaking CPI shock pushes yields higher ahead of Fed decision",
      summary: "Inflation came in hot and traders are repricing the rates path immediately.",
      originalTimestamp: new Date().toISOString(),
      affectedSymbols: ["SPY"],
      affectedAssetClasses: ["INDEX"],
      tags: ["cpi", "rates"],
      category: "macro",
    });

    expect(["HIGH", "CRITICAL"]).toContain(result.urgency);
    expect(result.volatilityImpact).toBe("HIGH");
    expect(result.relevanceScore).toBeGreaterThan(10);
  });
});
