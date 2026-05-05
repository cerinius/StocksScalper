import type { AccountMode, AccountPhaseKind } from "@stock-radar/types";
import type { DistanceSummary } from "./distance";

export interface ModeTransitionInputs {
  currentMode: AccountMode;
  phaseKind: AccountPhaseKind;
  killSwitchActive: boolean;
  distance: DistanceSummary;
  consecutiveLosers: number;
  /** Fraction (0..1). If daily usage >= this, enter CAUTIOUS. */
  cautiousLossFraction: number;
  /** Fraction (0..1). If daily usage >= this, enter RECOVERY. */
  recoveryLossFraction: number;
  /** Fraction (0..1). If distanceToTarget <= this, enter TARGET_NEAR. Null disables. */
  targetNearFraction: number | null;
  /** Hours until payout window opens. Negative = inside window. */
  hoursUntilPayout: number | null;
  /** Days this account has been flagged for payout-protect posture. */
  payoutProtectWindowDays: number;
}

export interface ModeTransitionResult {
  mode: AccountMode;
  reason: string;
  reasonCode: string;
}

/**
 * Pure deterministic mode transition. Same inputs → same output.
 * This is the ONLY place that decides account mode. AI cannot override.
 *
 * Precedence (highest to lowest):
 *   1. LOCKED: killSwitch OR phase=BREACHED
 *   2. PAYOUT_PROTECT: hoursUntilPayout within window OR payoutProtectWindowDays > 0 + eligible
 *   3. RECOVERY: daily-loss-used >= recoveryLossFraction OR 3+ consecutive losers
 *   4. CAUTIOUS: daily-loss-used >= cautiousLossFraction
 *   5. TARGET_NEAR: distanceToTargetPct <= targetNearFraction (evaluation only)
 *   6. NORMAL
 */
export function computeAccountMode(inputs: ModeTransitionInputs): ModeTransitionResult {
  if (inputs.killSwitchActive) {
    return {
      mode: "LOCKED",
      reason: "Kill-switch is active at the account level.",
      reasonCode: "ACCOUNT_KILL_SWITCH",
    };
  }

  if (inputs.phaseKind === "BREACHED") {
    return {
      mode: "LOCKED",
      reason: "Account phase is BREACHED.",
      reasonCode: "ACCOUNT_BREACHED",
    };
  }

  if (inputs.distance.anyBreached) {
    return {
      mode: "LOCKED",
      reason: "A hard drawdown rule has been breached.",
      reasonCode: inputs.distance.dailyBreached
        ? "ACCOUNT_DAILY_DD_BREACH"
        : inputs.distance.totalBreached
          ? "ACCOUNT_TOTAL_DD_BREACH"
          : "ACCOUNT_TRAILING_DD_BREACH",
    };
  }

  const inPayoutWindow =
    (inputs.hoursUntilPayout != null && inputs.hoursUntilPayout <= 24 * inputs.payoutProtectWindowDays && inputs.hoursUntilPayout > 0) ||
    (inputs.hoursUntilPayout != null && inputs.hoursUntilPayout <= 0 && inputs.payoutProtectWindowDays > 0);
  if (inPayoutWindow && inputs.phaseKind === "FUNDED") {
    return {
      mode: "PAYOUT_PROTECT",
      reason: `Within payout window (${inputs.payoutProtectWindowDays}d before payout).`,
      reasonCode: "ACCOUNT_PAYOUT_PROTECT_ACTIVE",
    };
  }

  if (
    inputs.distance.dailyLossUsedPct >= inputs.recoveryLossFraction ||
    inputs.consecutiveLosers >= 3
  ) {
    return {
      mode: "RECOVERY",
      reason:
        inputs.consecutiveLosers >= 3
          ? `${inputs.consecutiveLosers} consecutive losers — only A+ setups, reduced size.`
          : `Daily drawdown used ${(inputs.distance.dailyLossUsedPct * 100).toFixed(1)}% — entering RECOVERY.`,
      reasonCode: "ACCOUNT_DAILY_DD_NEAR",
    };
  }

  if (inputs.distance.dailyLossUsedPct >= inputs.cautiousLossFraction) {
    return {
      mode: "CAUTIOUS",
      reason: `Daily drawdown used ${(inputs.distance.dailyLossUsedPct * 100).toFixed(1)}% — entering CAUTIOUS.`,
      reasonCode: "ACCOUNT_DAILY_DD_NEAR",
    };
  }

  if (
    inputs.targetNearFraction != null &&
    inputs.distance.distanceToTargetPct != null &&
    inputs.distance.distanceToTargetPct <= inputs.targetNearFraction &&
    (inputs.phaseKind === "EVALUATION" || inputs.phaseKind === "VERIFICATION")
  ) {
    return {
      mode: "TARGET_NEAR",
      reason: `Within ${(inputs.distance.distanceToTargetPct * 100).toFixed(1)}% of target — protect gains.`,
      reasonCode: "ACCOUNT_TOTAL_DD_NEAR",
    };
  }

  return {
    mode: "NORMAL",
    reason: "No restrictive triggers.",
    reasonCode: "ACCOUNT_ELIGIBLE",
  };
}

/**
 * Per-mode size multiplier. The decision engine multiplies the
 * computed quantity by this. Never >1.0 (AI can additionally reduce
 * further but never above this ceiling).
 */
export function modeSizeMultiplier(mode: AccountMode): number {
  switch (mode) {
    case "NORMAL":
      return 1.0;
    case "CAUTIOUS":
      return 0.5;
    case "RECOVERY":
      return 0.33;
    case "TARGET_NEAR":
      return 0.5;
    case "PAYOUT_PROTECT":
      return 0.5;
    case "LOCKED":
      return 0;
  }
}

/**
 * Minimum setup score (0..100) required for the mode to place a new
 * trade. Ensures that when the account is injured it only takes the
 * very best setups.
 */
export function modeMinSetupScore(mode: AccountMode): number {
  switch (mode) {
    case "NORMAL":
      return 55;
    case "CAUTIOUS":
      return 65;
    case "RECOVERY":
      return 80;
    case "TARGET_NEAR":
      return 70;
    case "PAYOUT_PROTECT":
      return 75;
    case "LOCKED":
      return 101; // unreachable
  }
}

/**
 * True if the mode permits opening a new position at all. LOCKED is
 * the only hard block.
 */
export function modePermitsOpen(mode: AccountMode): boolean {
  return mode !== "LOCKED";
}
