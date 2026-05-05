import type { AccountHealth, AccountMode } from "@stock-radar/types";
import type { DistanceSummary } from "./distance";

export interface HealthInputs {
  mode: AccountMode;
  distance: DistanceSummary;
  consecutiveLosers: number;
  killSwitchActive: boolean;
  phaseKind: string; // AccountPhaseKind string
}

/**
 * Deterministic health rollup, independent of mode but using the same
 * distance summary. Health is what shows up as a color in the UI.
 */
export function computeAccountHealth(inputs: HealthInputs): AccountHealth {
  if (inputs.killSwitchActive || inputs.phaseKind === "BREACHED") {
    return "BREACHED";
  }
  if (inputs.distance.anyBreached) {
    return "BREACHED";
  }
  if (
    inputs.mode === "RECOVERY" ||
    inputs.distance.dailyLossUsedPct >= 0.75 ||
    inputs.distance.totalLossUsedPct >= 0.75 ||
    (inputs.distance.trailingLossUsedPct != null && inputs.distance.trailingLossUsedPct >= 0.75) ||
    inputs.consecutiveLosers >= 3
  ) {
    return "CRITICAL";
  }
  if (
    inputs.mode === "CAUTIOUS" ||
    inputs.mode === "PAYOUT_PROTECT" ||
    inputs.distance.dailyLossUsedPct >= 0.5 ||
    inputs.distance.totalLossUsedPct >= 0.5 ||
    inputs.consecutiveLosers >= 2
  ) {
    return "WARNING";
  }
  return "HEALTHY";
}
