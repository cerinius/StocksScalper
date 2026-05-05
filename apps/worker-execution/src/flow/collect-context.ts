import { prisma } from "@stock-radar/db";
import {
  computeAccountHealth,
  computeAccountMode,
  computeDistanceSummary,
} from "@stock-radar/core";
import type {
  AccountMode,
  AccountPhaseKind,
  AccountRuleProfile,
  AccountSnapshotExtended,
} from "@stock-radar/types";
import { checkAccountBridgeGate } from "../safety/bridge-gate";
import type { AccountContext } from "./types";

type AnyPrisma = Record<string, unknown>;
const p = prisma as unknown as AnyPrisma;

/**
 * Soft-accessor for the new multi-account Prisma delegates. Until
 * `prisma generate` is run after migration 20260425_multi_account_core,
 * the delegates aren't in the client yet — this keeps TS happy and
 * lets the worker degrade gracefully to the legacy single-account
 * path when the tables are empty.
 */
const delegate = (name: string) => {
  const d = p[name] as
    | { findMany?: (args?: unknown) => Promise<unknown[]>; findFirst?: (args?: unknown) => Promise<unknown | null> }
    | undefined;
  return d;
};

const toIso = (d: unknown): string => {
  if (!d) return new Date(0).toISOString();
  if (d instanceof Date) return d.toISOString();
  return new Date(String(d)).toISOString();
};

/**
 * Fetch all active accounts with their most-recent snapshot, active
 * rule profile, open position count, consecutive losers count, and
 * bridge status. Accounts with `isActive=false`, bridge STALE/
 * DISCONNECTED, or mode LOCKED are still returned — the allocator
 * will skip them — so callers can log *why* an account was excluded.
 */
export const collectAccountContexts = async (): Promise<AccountContext[]> => {
  const accountDelegate = delegate("account");
  if (!accountDelegate?.findMany) {
    // Prisma client not regenerated yet → no accounts available.
    return [];
  }

  const accounts = (await accountDelegate.findMany({
    where: { isActive: true },
    include: {
      activeRuleProfile: true,
      currentPhase: true,
    },
  })) as Array<Record<string, unknown>>;

  const contexts: AccountContext[] = [];

  for (const a of accounts) {
    const ruleProfile = a.activeRuleProfile as Record<string, unknown> | null;
    const currentPhase = a.currentPhase as Record<string, unknown> | null;
    if (!ruleProfile || !currentPhase) continue;

    const snapshotRow = (await delegate("accountSnapshot")?.findFirst?.({
      where: { accountId: a.id },
      orderBy: { capturedAt: "desc" },
    })) as Record<string, unknown> | null | undefined;

    const effectiveSnapshot = snapshotRow ?? {
      id: "",
      capturedAt: new Date(0),
      balance: Number(a.startingBalance ?? ruleProfile.startingBalance ?? 0),
      equity: Number(a.startingBalance ?? ruleProfile.startingBalance ?? 0),
      freeMargin: Number(a.startingBalance ?? ruleProfile.startingBalance ?? 0),
      usedMargin: 0,
      marginLevel: 0,
      openPnl: 0,
      realizedPnlDaily: 0,
      drawdownPct: 0,
      maxDrawdownPct: 0,
      riskState: "NORMAL",
      killSwitchActive: false,
      mode: String(a.tradingMode ?? "PAPER"),
    };

    const openPositions = (await delegate("position")?.findMany?.({
      where: { accountId: a.id, status: "OPEN" },
      include: { symbol: true },
    })) as Array<Record<string, unknown>> | undefined;

    const recentClosed = (await delegate("position")?.findMany?.({
      where: { accountId: a.id, status: "CLOSED" },
      orderBy: { closedAt: "desc" },
      take: 10,
    })) as Array<{ realizedPnl: number }> | undefined;

    let consecutiveLosers = 0;
    for (const p of recentClosed ?? []) {
      if (p.realizedPnl < 0) consecutiveLosers += 1;
      else break;
    }

    const startingBalance = Number(ruleProfile.startingBalance);
    const limits = {
      dailyLossLimitUsd: Number(ruleProfile.dailyLossLimitUsd),
      totalLossLimitUsd: Number(ruleProfile.totalLossLimitUsd),
      trailingDrawdownUsd: ruleProfile.trailingDrawdownUsd == null
        ? null
        : Number(ruleProfile.trailingDrawdownUsd),
      profitTargetUsd: ruleProfile.profitTargetUsd == null
        ? null
        : Number(ruleProfile.profitTargetUsd),
      startingBalance,
    };

    const currentEquity = Number(effectiveSnapshot.equity);
    const dailyLossUsd = Math.max(0, -Number(effectiveSnapshot.realizedPnlDaily ?? 0));
    const totalLossUsd = Math.max(0, startingBalance - currentEquity);
    const trailingDdUsd = effectiveSnapshot.maxDrawdownPct != null
      ? (Number(effectiveSnapshot.maxDrawdownPct) / 100) * startingBalance
      : null;

    const distance = computeDistanceSummary(
      {
        dailyLossUsd,
        totalLossUsd,
        trailingDrawdownUsd: trailingDdUsd,
      },
      limits,
      currentEquity,
    );

    const phaseKind = String(currentPhase.kind) as AccountPhaseKind;
    const killSwitchActive = Boolean(effectiveSnapshot.killSwitchActive);
    const cautiousFraction = Number(ruleProfile.cautiousLossFraction);
    const recoveryFraction = Number(ruleProfile.recoveryLossFraction);
    const targetNearFraction = ruleProfile.targetNearFraction == null
      ? null
      : Number(ruleProfile.targetNearFraction);
    const payoutWindowDays = Number(ruleProfile.payoutProtectWindowDays ?? 0);

    const modeResult = computeAccountMode({
      currentMode: String(a.mode) as AccountMode,
      phaseKind,
      killSwitchActive,
      distance,
      consecutiveLosers,
      cautiousLossFraction: cautiousFraction,
      recoveryLossFraction: recoveryFraction,
      targetNearFraction,
      hoursUntilPayout: null,
      payoutProtectWindowDays: payoutWindowDays,
    });
    const mode = modeResult.mode;
    const health = computeAccountHealth({
      mode,
      distance,
      consecutiveLosers,
      killSwitchActive,
      phaseKind,
    });

    const bridgeGate = await checkAccountBridgeGate(String(a.id));

    const extendedSnapshot: AccountSnapshotExtended = {
      id: String(effectiveSnapshot.id ?? ""),
      accountId: String(a.id),
      capturedAt: toIso(effectiveSnapshot.capturedAt),
      balance: Number(effectiveSnapshot.balance),
      equity: currentEquity,
      freeMargin: Number(effectiveSnapshot.freeMargin),
      usedMargin: Number(effectiveSnapshot.usedMargin),
      marginLevel: Number(effectiveSnapshot.marginLevel),
      openPnl: Number(effectiveSnapshot.openPnl),
      realizedPnlDaily: Number(effectiveSnapshot.realizedPnlDaily),
      drawdownPct: Number(effectiveSnapshot.drawdownPct),
      maxDrawdownPct: Number(effectiveSnapshot.maxDrawdownPct),
      riskState: String(effectiveSnapshot.riskState) as AccountSnapshotExtended["riskState"],
      killSwitchActive,
      mode: String(effectiveSnapshot.mode).toLowerCase() as AccountSnapshotExtended["mode"],
      accountMode: mode,
      accountHealth: health,
      phaseKind,
      dailyLossUsedUsd: dailyLossUsd,
      dailyLossUsedPct: distance.dailyLossUsedPct,
      dailyLossRemainingUsd: distance.dailyLossRemainingUsd,
      totalLossUsedUsd: totalLossUsd,
      totalLossUsedPct: distance.totalLossUsedPct,
      totalLossRemainingUsd: distance.totalLossRemainingUsd,
      distanceToTargetUsd: distance.distanceToTargetUsd,
      distanceToTargetPct: distance.distanceToTargetPct,
      consecutiveLosers,
      openPositionCount: openPositions?.length ?? 0,
      concurrentRiskUsd: (openPositions ?? []).reduce(
        (sum, p) => sum + Number((p as { currentRiskUsd?: number | null }).currentRiskUsd ?? 0),
        0,
      ),
      concurrentRiskPct: 0, // filled by supervisor; not needed for open decisions
    };

    const ruleProfileTyped: AccountRuleProfile = {
      id: String(ruleProfile.id),
      accountId: String(ruleProfile.accountId),
      version: Number(ruleProfile.version),
      isActive: Boolean(ruleProfile.isActive),
      startingBalance,
      dailyLossLimitUsd: Number(ruleProfile.dailyLossLimitUsd),
      totalLossLimitUsd: Number(ruleProfile.totalLossLimitUsd),
      trailingDrawdownUsd: ruleProfile.trailingDrawdownUsd == null
        ? null
        : Number(ruleProfile.trailingDrawdownUsd),
      profitTargetUsd: ruleProfile.profitTargetUsd == null
        ? null
        : Number(ruleProfile.profitTargetUsd),
      maxRiskPerTradePct: Number(ruleProfile.maxRiskPerTradePct),
      maxRiskPerTradeUsd: Number(ruleProfile.maxRiskPerTradeUsd),
      minRiskRewardRatio: Number(ruleProfile.minRiskRewardRatio),
      maxOpenPositions: Number(ruleProfile.maxOpenPositions),
      maxConcurrentRiskPct: Number(ruleProfile.maxConcurrentRiskPct),
      maxCorrelatedPositions: Number(ruleProfile.maxCorrelatedPositions),
      allowedAssetClasses: (ruleProfile.allowedAssetClasses as string[] | null) ?? [],
      forbiddenAssetClasses: (ruleProfile.forbiddenAssetClasses as string[] | null) ?? [],
      allowedSessions: (ruleProfile.allowedSessions as string[] | null) ?? [],
      forbiddenSessions: (ruleProfile.forbiddenSessions as string[] | null) ?? [],
      allowedTimeframes: (ruleProfile.allowedTimeframes as string[] | null) ?? [],
      noTradeBeforeUtc: (ruleProfile.noTradeBeforeUtc as string | null) ?? null,
      noTradeAfterUtc: (ruleProfile.noTradeAfterUtc as string | null) ?? null,
      newsBlackoutMinutesBefore: Number(ruleProfile.newsBlackoutMinutesBefore ?? 0),
      newsBlackoutMinutesAfter: Number(ruleProfile.newsBlackoutMinutesAfter ?? 0),
      newsBlackoutUrgencies: (ruleProfile.newsBlackoutUrgencies as AccountRuleProfile["newsBlackoutUrgencies"] | null) ?? [],
      blockWeekendHold: Boolean(ruleProfile.blockWeekendHold),
      allowHedging: Boolean(ruleProfile.allowHedging),
      cautiousLossFraction: cautiousFraction,
      recoveryLossFraction: recoveryFraction,
      targetNearFraction,
      payoutEligibleAfter: Number(ruleProfile.payoutEligibleAfter ?? 0),
      payoutProtectWindowDays: payoutWindowDays,
      providerName: String(ruleProfile.providerName ?? ""),
      providerRulesUrl: (ruleProfile.providerRulesUrl as string | null) ?? null,
      createdAt: toIso(ruleProfile.createdAt),
      updatedAt: toIso(ruleProfile.updatedAt),
    };

    contexts.push({
      accountId: String(a.id),
      displayName: String(a.displayName ?? ""),
      kind: String(a.kind) as AccountContext["kind"],
      integrationId: String(a.integrationId),
      tradingMode: String(a.tradingMode).toLowerCase() as AccountContext["tradingMode"],
      tags: (a.tags as string[] | null) ?? [],
      mode,
      ruleProfile: ruleProfileTyped,
      snapshot: extendedSnapshot,
      openPositions: (openPositions ?? []).map((pos) => {
        const symbol = pos.symbol as { ticker: string } | null;
        const dir = String((pos as { direction: string }).direction).toUpperCase();
        return {
          symbol: symbol?.ticker ?? "",
          direction: (dir === "LONG" ? "LONG" : "SHORT") as "LONG" | "SHORT",
          quantity: Number((pos as { quantity: number }).quantity),
          averageEntryPrice: Number((pos as { avgEntryPrice: number }).avgEntryPrice),
          unrealizedPnl: Number((pos as { unrealizedPnl: number }).unrealizedPnl),
          exposurePct: Number((pos as { exposurePct: number }).exposurePct),
          correlationTags:
            ((pos as { metadata?: { correlationTags?: string[] } }).metadata?.correlationTags) ?? [],
        };
      }),
      consecutiveLosers,
      bridgeAllowOpen: bridgeGate.allowOpen,
      bridgeAllowManage: bridgeGate.allowManage,
      bridgeReasons: bridgeGate.reasons,
    });
  }

  return contexts;
};
