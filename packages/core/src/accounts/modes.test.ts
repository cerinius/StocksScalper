import { describe, expect, it } from "vitest";
import { computeAccountMode, modeMinSetupScore, modePermitsOpen, modeSizeMultiplier } from "./modes";

const baseDistance = {
  dailyLossUsedPct: 0,
  totalLossUsedPct: 0,
  trailingLossUsedPct: null as number | null,
  dailyLossRemainingUsd: 500,
  totalLossRemainingUsd: 2_000,
  trailingLossRemainingUsd: null as number | null,
  distanceToTargetUsd: 500,
  distanceToTargetPct: 0.5,
  dailyBreached: false,
  totalBreached: false,
  trailingBreached: false,
  anyBreached: false,
};

describe("computeAccountMode", () => {
  it("locks on kill switch", () => {
    const r = computeAccountMode({
      currentMode: "NORMAL",
      phaseKind: "FUNDED",
      killSwitchActive: true,
      distance: baseDistance,
      consecutiveLosers: 0,
      cautiousLossFraction: 0.5,
      recoveryLossFraction: 0.75,
      targetNearFraction: null,
      hoursUntilPayout: null,
      payoutProtectWindowDays: 0,
    });
    expect(r.mode).toBe("LOCKED");
    expect(r.reasonCode).toBe("ACCOUNT_KILL_SWITCH");
  });

  it("locks on breached phase", () => {
    const r = computeAccountMode({
      currentMode: "NORMAL",
      phaseKind: "BREACHED",
      killSwitchActive: false,
      distance: baseDistance,
      consecutiveLosers: 0,
      cautiousLossFraction: 0.5,
      recoveryLossFraction: 0.75,
      targetNearFraction: null,
      hoursUntilPayout: null,
      payoutProtectWindowDays: 0,
    });
    expect(r.mode).toBe("LOCKED");
    expect(r.reasonCode).toBe("ACCOUNT_BREACHED");
  });

  it("enters CAUTIOUS on half daily DD", () => {
    const r = computeAccountMode({
      currentMode: "NORMAL",
      phaseKind: "FUNDED",
      killSwitchActive: false,
      distance: { ...baseDistance, dailyLossUsedPct: 0.55 },
      consecutiveLosers: 0,
      cautiousLossFraction: 0.5,
      recoveryLossFraction: 0.75,
      targetNearFraction: null,
      hoursUntilPayout: null,
      payoutProtectWindowDays: 0,
    });
    expect(r.mode).toBe("CAUTIOUS");
  });

  it("enters RECOVERY on deep DD", () => {
    const r = computeAccountMode({
      currentMode: "NORMAL",
      phaseKind: "FUNDED",
      killSwitchActive: false,
      distance: { ...baseDistance, dailyLossUsedPct: 0.8 },
      consecutiveLosers: 0,
      cautiousLossFraction: 0.5,
      recoveryLossFraction: 0.75,
      targetNearFraction: null,
      hoursUntilPayout: null,
      payoutProtectWindowDays: 0,
    });
    expect(r.mode).toBe("RECOVERY");
  });

  it("enters RECOVERY on 3 consecutive losers", () => {
    const r = computeAccountMode({
      currentMode: "NORMAL",
      phaseKind: "FUNDED",
      killSwitchActive: false,
      distance: baseDistance,
      consecutiveLosers: 3,
      cautiousLossFraction: 0.5,
      recoveryLossFraction: 0.75,
      targetNearFraction: null,
      hoursUntilPayout: null,
      payoutProtectWindowDays: 0,
    });
    expect(r.mode).toBe("RECOVERY");
  });

  it("enters TARGET_NEAR close to target in EVALUATION", () => {
    const r = computeAccountMode({
      currentMode: "NORMAL",
      phaseKind: "EVALUATION",
      killSwitchActive: false,
      distance: { ...baseDistance, distanceToTargetPct: 0.1 },
      consecutiveLosers: 0,
      cautiousLossFraction: 0.5,
      recoveryLossFraction: 0.75,
      targetNearFraction: 0.2,
      hoursUntilPayout: null,
      payoutProtectWindowDays: 0,
    });
    expect(r.mode).toBe("TARGET_NEAR");
  });

  it("enters PAYOUT_PROTECT inside payout window when FUNDED", () => {
    const r = computeAccountMode({
      currentMode: "NORMAL",
      phaseKind: "FUNDED",
      killSwitchActive: false,
      distance: baseDistance,
      consecutiveLosers: 0,
      cautiousLossFraction: 0.5,
      recoveryLossFraction: 0.75,
      targetNearFraction: null,
      hoursUntilPayout: 10,
      payoutProtectWindowDays: 1,
    });
    expect(r.mode).toBe("PAYOUT_PROTECT");
  });

  it("defaults to NORMAL when nothing triggers", () => {
    const r = computeAccountMode({
      currentMode: "NORMAL",
      phaseKind: "FUNDED",
      killSwitchActive: false,
      distance: baseDistance,
      consecutiveLosers: 0,
      cautiousLossFraction: 0.5,
      recoveryLossFraction: 0.75,
      targetNearFraction: null,
      hoursUntilPayout: null,
      payoutProtectWindowDays: 0,
    });
    expect(r.mode).toBe("NORMAL");
  });
});

describe("mode helpers", () => {
  it("LOCKED blocks opens and gives 0 multiplier", () => {
    expect(modePermitsOpen("LOCKED")).toBe(false);
    expect(modeSizeMultiplier("LOCKED")).toBe(0);
    expect(modeMinSetupScore("LOCKED")).toBeGreaterThan(100);
  });
  it("monotone-ish: recovery is stricter than cautious than normal", () => {
    expect(modeMinSetupScore("RECOVERY")).toBeGreaterThan(modeMinSetupScore("CAUTIOUS"));
    expect(modeMinSetupScore("CAUTIOUS")).toBeGreaterThan(modeMinSetupScore("NORMAL"));
    expect(modeSizeMultiplier("RECOVERY")).toBeLessThan(modeSizeMultiplier("CAUTIOUS"));
    expect(modeSizeMultiplier("CAUTIOUS")).toBeLessThan(modeSizeMultiplier("NORMAL"));
  });
});
