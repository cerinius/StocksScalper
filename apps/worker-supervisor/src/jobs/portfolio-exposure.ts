/**
 * Portfolio Exposure Snapshot Job
 *
 * Runs every ~30s. Computes current cross-account exposure by:
 *   - Symbol
 *   - Correlation group
 *   - Account
 *
 * Writes PortfolioBucketExposure rows that power the /exposure UI page
 * and feed into the pre-trade allocation fit-scoring.
 */

import { prisma } from "@stock-radar/db";
import { createLogger } from "@stock-radar/logging";

const logger = createLogger("portfolio-exposure");

type BucketKind = "SYMBOL" | "ACCOUNT" | "CORRELATION_GROUP" | "SESSION" | "STRATEGY";

export const runPortfolioExposureSnapshot = async (): Promise<void> => {
  const now = new Date();

  // Load all open positions with symbol + account info
  const openPositions = await prisma.position.findMany({
    where: { status: "OPEN" },
    include: {
      symbol: true,
      account: { select: { id: true, displayName: true } },
    },
  }) as any[];

  if (openPositions.length === 0) {
    return; // Nothing to aggregate
  }

  // Load latest account snapshots for balance/equity context
  const accountSnapshots = new Map<string, any>();
  const snapRows = await prisma.accountSnapshot.findMany({
    where: {
      accountId: {
        in: openPositions
          .map((p: any) => p.accountId)
          .filter((id: any): id is string => typeof id === "string"),
      },
    },
    orderBy: { capturedAt: "desc" },
    distinct: ["accountId" as any],
    select: { accountId: true, equity: true, balance: true },
  }) as any[];
  for (const snap of snapRows) {
    if (snap.accountId) accountSnapshots.set(snap.accountId, snap);
  }

  // -- Aggregate by SYMBOL --
  const bySymbol = new Map<string, {
    ticker: string;
    positions: typeof openPositions;
  }>();
  for (const pos of openPositions) {
    const key = pos.symbol?.ticker ?? "?";
    if (!bySymbol.has(key)) bySymbol.set(key, { ticker: key, positions: [] });
    bySymbol.get(key)!.positions.push(pos);
  }

  // -- Aggregate by ACCOUNT --
  const byAccount = new Map<string, {
    accountId: string;
    label: string;
    positions: typeof openPositions;
  }>();
  for (const pos of openPositions) {
    const key = pos.accountId ?? "unknown";
    if (!byAccount.has(key)) {
      byAccount.set(key, { accountId: key, label: pos.account?.displayName ?? key, positions: [] });
    }
    byAccount.get(key)!.positions.push(pos);
  }

  // -- Aggregate by CORRELATION_GROUP --
  const byCorrel = new Map<string, { group: string; positions: typeof openPositions }>();
  for (const pos of openPositions) {
    const key = pos.symbol?.correlationGroup ?? "UNCORRELATED";
    if (!byCorrel.has(key)) byCorrel.set(key, { group: key, positions: [] });
    byCorrel.get(key)!.positions.push(pos);
  }

  const createBucket = async (
    kind: BucketKind,
    bucketKey: string,
    accountId: string | null,
    positions: any[],
  ) => {
    const snapshot = accountId ? accountSnapshots.get(accountId) : null;
    const totalEquity = snapshot?.equity ?? 100_000;

    const longPositions = positions.filter((p) => p.direction === "LONG");
    const shortPositions = positions.filter((p) => p.direction === "SHORT");

    const grossRiskUsd = positions.reduce((s, p) => s + Math.abs(p.currentRiskUsd ?? p.riskUsdAtEntry ?? 0), 0);
    const netRiskUsd = Math.abs(
      longPositions.reduce((s, p) => s + (p.currentRiskUsd ?? p.riskUsdAtEntry ?? 0), 0) -
      shortPositions.reduce((s, p) => s + (p.currentRiskUsd ?? p.riskUsdAtEntry ?? 0), 0),
    );
    const aggregateUnrealizedPnl = positions.reduce((s, p) => s + (p.unrealizedPnl ?? 0), 0);
    const aggregateExposurePct = totalEquity > 0 ? (grossRiskUsd / totalEquity) * 100 : 0;

    const netQtyLong = longPositions.reduce((s, p) => s + (p.quantity ?? 0), 0);
    const netQtyShort = shortPositions.reduce((s, p) => s + (p.quantity ?? 0), 0);
    const netDirection =
      netQtyLong > netQtyShort ? "LONG" : netQtyShort > netQtyLong ? "SHORT" : "FLAT";

    // Build per-account breakdown
    const accountIds = [...new Set(positions.map((p) => p.accountId).filter(Boolean))];
    const perAccountJson = accountIds.map((aId) => {
      const acctPositions = positions.filter((p) => p.accountId === aId);
      const acctSnap = accountSnapshots.get(aId as string);
      const acctEquity = acctSnap?.equity ?? 0;
      return {
        accountId: aId,
        label: acctPositions[0]?.account?.displayName ?? aId,
        positionCount: acctPositions.length,
        grossRiskUsd: acctPositions.reduce((s, p) => s + Math.abs(p.currentRiskUsd ?? p.riskUsdAtEntry ?? 0), 0),
        exposurePct: acctEquity > 0
          ? (acctPositions.reduce((s, p) => s + Math.abs(p.currentRiskUsd ?? p.riskUsdAtEntry ?? 0), 0) / acctEquity) * 100
          : 0,
        unrealizedPnl: acctPositions.reduce((s, p) => s + (p.unrealizedPnl ?? 0), 0),
      };
    });

    try {
      await (prisma as any).portfolioBucketExposure.create({
        data: {
          kind,
          bucketKey,
          accountId,
          asOf: now,
          accountCount: accountIds.length,
          openPositionCount: positions.length,
          netQuantityLong: netQtyLong,
          netQuantityShort: netQtyShort,
          netDirection,
          grossRiskUsd,
          netRiskUsd,
          aggregateUnrealizedPnl,
          aggregateExposurePct,
          perAccountJson,
        },
      });
    } catch (err) {
      logger.warn("Failed to write portfolio bucket", { kind, bucketKey, error: (err as Error).message });
    }
  };

  // Write symbol buckets
  for (const [ticker, { positions }] of bySymbol) {
    await createBucket("SYMBOL", ticker, null, positions);
  }

  // Write account buckets
  for (const [accountId, { positions }] of byAccount) {
    await createBucket("ACCOUNT", accountId, accountId, positions);
  }

  // Write correlation group buckets
  for (const [group, { positions }] of byCorrel) {
    await createBucket("CORRELATION_GROUP", group, null, positions);
  }

  logger.debug("Portfolio exposure snapshot written", {
    openPositions: openPositions.length,
    symbolBuckets: bySymbol.size,
    accountBuckets: byAccount.size,
    correlBuckets: byCorrel.size,
  });
};
