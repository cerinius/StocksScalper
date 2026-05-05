import { describe, expect, it } from "vitest";
import { computeAccountHealth } from "./health";

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

describe("computeAccountHealth", () => {
  it("BREACHED when kill switch active", () => {
    expect(computeAccountHealth({
      mode: "NORMAL", distance: baseDistance, consecutiveLosers: 0, killSwitchActive: true, phaseKind: "FUNDED",
    })).toBe("BREACHED");
  });
  it("BREACHED when phase BREACHED", () => {
    expect(computeAccountHealth({
      mode: "NORMAL", distance: baseDistance, consecutiveLosers: 0, killSwitchActive: false, phaseKind: "BREACHED",
    })).toBe("BREACHED");
  });
  it("BREACHED when any DD breached", () => {
    expect(computeAccountHealth({
      mode: "NORMAL",
      distance: { ...baseDistance, dailyBreached: true, anyBreached: true },
      consecutiveLosers: 0, killSwitchActive: false, phaseKind: "FUNDED",
    })).toBe("BREACHED");
  });
  it("CRITICAL on RECOVERY mode", () => {
    expect(computeAccountHealth({
      mode: "RECOVERY", distance: baseDistance, consecutiveLosers: 0, killSwitchActive: false, phaseKind: "FUNDED",
    })).toBe("CRITICAL");
  });
  it("WARNING on CAUTIOUS mode", () => {
    expect(computeAccountHealth({
      mode: "CAUTIOUS", distance: baseDistance, consecutiveLosers: 0, killSwitchActive: false, phaseKind: "FUNDED",
    })).toBe("WARNING");
  });
  it("HEALTHY otherwise", () => {
    expect(computeAccountHealth({
      mode: "NORMAL", distance: baseDistance, consecutiveLosers: 0, killSwitchActive: false, phaseKind: "FUNDED",
    })).toBe("HEALTHY");
  });
});
