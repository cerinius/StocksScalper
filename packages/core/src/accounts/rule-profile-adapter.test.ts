import { describe, expect, it } from "vitest";
import { buildRiskLimitsFromRuleProfile } from "./rule-profile-adapter";

const baseProfile = {
  startingBalance: 100_000,
  dailyLossLimitUsd: 5_000, // 5%
  maxRiskPerTradePct: 0.0075, // 0.75%
  maxOpenPositions: 3,
  maxConcurrentRiskPct: 0.03, // 3%
  maxCorrelatedPositions: 2,
};

const platformDefaults = {
  maxSymbolExposurePct: 20,
  maxCorrelatedExposurePct: 30,
  maxEntrySpreadPct: 0.1,
  staleSignalSeconds: 120,
};

describe("buildRiskLimitsFromRuleProfile", () => {
  it("converts ruleProfile to legacy riskLimits shape", () => {
    const limits = buildRiskLimitsFromRuleProfile({
      ruleProfile: baseProfile,
      mode: "NORMAL",
      manualApprovalMode: false,
      platformDefaults,
    });

    expect(limits.maxActiveTrades).toBe(3);
    expect(limits.maxDailyLossPct).toBeCloseTo(5, 4);
    expect(limits.maxRiskPerTradePct).toBeCloseTo(0.75, 4);
    expect(limits.maxTotalExposurePct).toBeCloseTo(3, 4);
    expect(limits.maxSymbolExposurePct).toBe(20);
    expect(limits.maxCorrelatedExposurePct).toBe(30);
    expect(limits.maxEntrySpreadPct).toBe(0.1);
    expect(limits.staleSignalSeconds).toBe(120);
    expect(limits.manualApprovalMode).toBe(false);
    expect(limits.dynamicRiskPerTradePct).toBeCloseTo(0.75, 4);
  });

  it("scales dynamic risk down in CAUTIOUS mode", () => {
    const limits = buildRiskLimitsFromRuleProfile({
      ruleProfile: baseProfile,
      mode: "CAUTIOUS",
      manualApprovalMode: false,
      platformDefaults,
    });
    // CAUTIOUS multiplier is 0.5
    expect(limits.dynamicRiskPerTradePct).toBeCloseTo(0.375, 4);
    // Hard cap stays the same
    expect(limits.maxRiskPerTradePct).toBeCloseTo(0.75, 4);
  });

  it("zeroes dynamic risk in LOCKED mode", () => {
    const limits = buildRiskLimitsFromRuleProfile({
      ruleProfile: baseProfile,
      mode: "LOCKED",
      manualApprovalMode: false,
      platformDefaults,
    });
    expect(limits.dynamicRiskPerTradePct).toBe(0);
  });

  it("reduces dynamic risk in RECOVERY mode", () => {
    const limits = buildRiskLimitsFromRuleProfile({
      ruleProfile: baseProfile,
      mode: "RECOVERY",
      manualApprovalMode: false,
      platformDefaults,
    });
    // RECOVERY multiplier is 0.33
    expect(limits.dynamicRiskPerTradePct).toBeCloseTo(0.2475, 4);
  });

  it("passes through manualApprovalMode", () => {
    const limits = buildRiskLimitsFromRuleProfile({
      ruleProfile: baseProfile,
      mode: "NORMAL",
      manualApprovalMode: true,
      platformDefaults,
    });
    expect(limits.manualApprovalMode).toBe(true);
  });
});
