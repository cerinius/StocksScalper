import type { AccountMode, AccountRuleProfile } from "@stock-radar/types";
import { modeSizeMultiplier } from "./modes";

/**
 * Legacy `riskLimits` shape expected by `makeExecutionDecision`.
 * We keep the existing decision engine unchanged and feed it a
 * limits object derived from the account rule profile + current mode.
 * This is the *bridge* between the new account-aware world and the
 * existing deterministic decision engine.
 */
export interface LegacyRiskLimits {
  maxActiveTrades: number;
  maxDailyLossPct: number;
  maxRiskPerTradePct: number;
  maxTotalExposurePct: number;
  maxSymbolExposurePct: number;
  maxCorrelatedExposurePct: number;
  maxEntrySpreadPct: number;
  staleSignalSeconds: number;
  manualApprovalMode: boolean;
  dynamicRiskPerTradePct?: number;
}

export interface BuildRiskLimitsInputs {
  ruleProfile: Pick<
    AccountRuleProfile,
    | "startingBalance"
    | "dailyLossLimitUsd"
    | "maxRiskPerTradePct"
    | "maxOpenPositions"
    | "maxConcurrentRiskPct"
    | "maxCorrelatedPositions"
  >;
  mode: AccountMode;
  /** Manual approval toggle from global trading config. */
  manualApprovalMode: boolean;
  /** Global fallbacks for rules that are not per-account yet. */
  platformDefaults: {
    maxSymbolExposurePct: number;
    maxCorrelatedExposurePct: number;
    maxEntrySpreadPct: number;
    staleSignalSeconds: number;
  };
}

/**
 * Convert an account's rule profile (dollar-denominated, explicit)
 * into the percentage-denominated `riskLimits` object used by the
 * existing decision engine. The account's runtime `mode` scales the
 * per-trade risk budget so CAUTIOUS/RECOVERY accounts size smaller
 * without requiring a second rule profile version.
 */
export const buildRiskLimitsFromRuleProfile = (inputs: BuildRiskLimitsInputs): LegacyRiskLimits => {
  const { ruleProfile, mode, manualApprovalMode, platformDefaults } = inputs;

  const dailyLossPct = ruleProfile.startingBalance > 0
    ? (ruleProfile.dailyLossLimitUsd / ruleProfile.startingBalance) * 100
    : 0;
  const riskPerTradePct = ruleProfile.maxRiskPerTradePct * 100; // fraction → percent
  const totalExposurePct = ruleProfile.maxConcurrentRiskPct * 100;
  const sizeMultiplier = modeSizeMultiplier(mode);
  const dynamicRiskPerTradePct = riskPerTradePct * sizeMultiplier;

  return {
    maxActiveTrades: ruleProfile.maxOpenPositions,
    maxDailyLossPct: Number(dailyLossPct.toFixed(4)),
    maxRiskPerTradePct: Number(riskPerTradePct.toFixed(4)),
    maxTotalExposurePct: Number(totalExposurePct.toFixed(4)),
    maxSymbolExposurePct: platformDefaults.maxSymbolExposurePct,
    maxCorrelatedExposurePct: platformDefaults.maxCorrelatedExposurePct,
    maxEntrySpreadPct: platformDefaults.maxEntrySpreadPct,
    staleSignalSeconds: platformDefaults.staleSignalSeconds,
    manualApprovalMode,
    dynamicRiskPerTradePct: Number(dynamicRiskPerTradePct.toFixed(4)),
  };
};
