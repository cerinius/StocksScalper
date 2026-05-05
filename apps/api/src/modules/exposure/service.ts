import { prisma } from "@stock-radar/db";

export interface ExposureQuery {
  limit: number;
}

export const getExposureOverview = async (query: ExposureQuery) => {
  const [positions, snapshots] = await Promise.all([
    prisma.position.findMany({
      where: { status: "OPEN" },
      include: {
        symbol: {
          select: {
            ticker: true,
            correlationGroup: true,
            assetClass: true,
          },
        },
        account: {
          select: {
            id: true,
            displayName: true,
            mode: true,
            health: true,
          },
        },
      },
      orderBy: { openedAt: "desc" },
      take: query.limit,
    }),
    prisma.accountSnapshot.findMany({
      where: { accountId: { not: null } },
      orderBy: { capturedAt: "desc" },
      take: 500,
    }),
  ]);

  const latestSnapshotByAccount = new Map<string, (typeof snapshots)[number]>();
  for (const snapshot of snapshots) {
    if (!snapshot.accountId) continue;
    if (!latestSnapshotByAccount.has(snapshot.accountId)) {
      latestSnapshotByAccount.set(snapshot.accountId, snapshot);
    }
  }

  const byAccount = new Map<string, {
    accountId: string;
    accountName: string;
    mode: string;
    health: string;
    openPositionCount: number;
    grossExposurePct: number;
    netLongQty: number;
    netShortQty: number;
    unrealizedPnl: number;
    riskUsd: number;
    equity: number | null;
  }>();

  const bySymbol = new Map<string, {
    symbol: string;
    correlationGroup: string | null;
    assetClass: string;
    openPositionCount: number;
    longQty: number;
    shortQty: number;
    netQty: number;
    grossExposurePct: number;
    unrealizedPnl: number;
  }>();

  const byCorrelationGroup = new Map<string, {
    group: string;
    openPositionCount: number;
    grossExposurePct: number;
    unrealizedPnl: number;
  }>();

  const byAssetClass = new Map<string, {
    assetClass: string;
    openPositionCount: number;
    grossExposurePct: number;
    unrealizedPnl: number;
  }>();

  let totalGrossExposurePct = 0;
  let totalUnrealizedPnl = 0;
  let totalRiskUsd = 0;

  for (const position of positions) {
    const accountId = position.accountId ?? "unknown";
    const accountName = position.account?.displayName ?? "Unassigned";
    const accountMode = position.account?.mode ?? "UNKNOWN";
    const accountHealth = position.account?.health ?? "UNKNOWN";
    const symbol = position.symbol.ticker;
    const correlationGroup = position.symbol.correlationGroup ?? "uncategorized";
    const assetClass = String(position.symbol.assetClass);
    const qty = position.quantity;
    const signedQty = position.direction === "LONG" ? qty : -qty;
    const exposure = Math.abs(position.exposurePct);
    const unrealized = position.unrealizedPnl;
    const riskUsd = position.currentRiskUsd ?? position.riskUsdAtEntry ?? 0;

    totalGrossExposurePct += exposure;
    totalUnrealizedPnl += unrealized;
    totalRiskUsd += riskUsd;

    const accountRow = byAccount.get(accountId) ?? {
      accountId,
      accountName,
      mode: String(accountMode),
      health: String(accountHealth),
      openPositionCount: 0,
      grossExposurePct: 0,
      netLongQty: 0,
      netShortQty: 0,
      unrealizedPnl: 0,
      riskUsd: 0,
      equity: latestSnapshotByAccount.get(accountId)?.equity ?? null,
    };
    accountRow.openPositionCount += 1;
    accountRow.grossExposurePct += exposure;
    accountRow.unrealizedPnl += unrealized;
    accountRow.riskUsd += riskUsd;
    if (signedQty >= 0) accountRow.netLongQty += signedQty;
    if (signedQty < 0) accountRow.netShortQty += Math.abs(signedQty);
    byAccount.set(accountId, accountRow);

    const symbolRow = bySymbol.get(symbol) ?? {
      symbol,
      correlationGroup: position.symbol.correlationGroup,
      assetClass,
      openPositionCount: 0,
      longQty: 0,
      shortQty: 0,
      netQty: 0,
      grossExposurePct: 0,
      unrealizedPnl: 0,
    };
    symbolRow.openPositionCount += 1;
    symbolRow.grossExposurePct += exposure;
    symbolRow.unrealizedPnl += unrealized;
    if (signedQty >= 0) symbolRow.longQty += signedQty;
    if (signedQty < 0) symbolRow.shortQty += Math.abs(signedQty);
    symbolRow.netQty = symbolRow.longQty - symbolRow.shortQty;
    bySymbol.set(symbol, symbolRow);

    const corrRow = byCorrelationGroup.get(correlationGroup) ?? {
      group: correlationGroup,
      openPositionCount: 0,
      grossExposurePct: 0,
      unrealizedPnl: 0,
    };
    corrRow.openPositionCount += 1;
    corrRow.grossExposurePct += exposure;
    corrRow.unrealizedPnl += unrealized;
    byCorrelationGroup.set(correlationGroup, corrRow);

    const classRow = byAssetClass.get(assetClass) ?? {
      assetClass,
      openPositionCount: 0,
      grossExposurePct: 0,
      unrealizedPnl: 0,
    };
    classRow.openPositionCount += 1;
    classRow.grossExposurePct += exposure;
    classRow.unrealizedPnl += unrealized;
    byAssetClass.set(assetClass, classRow);
  }

  const accountRows = Array.from(byAccount.values()).sort((a, b) => b.grossExposurePct - a.grossExposurePct);
  const symbolRows = Array.from(bySymbol.values()).sort((a, b) => b.grossExposurePct - a.grossExposurePct);
  const correlationRows = Array.from(byCorrelationGroup.values()).sort((a, b) => b.grossExposurePct - a.grossExposurePct);
  const assetClassRows = Array.from(byAssetClass.values()).sort((a, b) => b.grossExposurePct - a.grossExposurePct);

  return {
    summary: {
      openPositionCount: positions.length,
      accountCount: accountRows.length,
      symbolCount: symbolRows.length,
      correlationGroupCount: correlationRows.length,
      totalGrossExposurePct: Number(totalGrossExposurePct.toFixed(2)),
      totalUnrealizedPnl: Number(totalUnrealizedPnl.toFixed(2)),
      totalRiskUsd: Number(totalRiskUsd.toFixed(2)),
      capturedAt: new Date().toISOString(),
    },
    byAccount: accountRows,
    bySymbol: symbolRows,
    byCorrelationGroup: correlationRows,
    byAssetClass: assetClassRows,
    openPositions: positions,
  };
};
