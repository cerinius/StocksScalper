import { describe, expect, it } from "vitest";
import { getPlatformConfig } from "./index";

describe("platform config", () => {
  it("parses defaults and unique local-first ports", () => {
    const config = getPlatformConfig({
      DATABASE_URL: "postgresql://test:test@localhost:55432/test",
      REDIS_URL: "redis://localhost:56379",
    });

    expect(config.ports.api).toBe(4210);
    expect(config.ports.web).toBe(3210);
    expect(config.ports.gateway).toBe(4211);
    expect(config.ports.mt5Adapter).toBe(4310);
    expect(config.watchlistSymbols.length).toBeGreaterThan(3);
  });
});
