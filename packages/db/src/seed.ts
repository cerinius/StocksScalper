/**
 * Database seed script.
 *
 * This script is designed to be IDEMPOTENT — it is safe to run multiple times.
 * All creates use upsert where a unique key exists, or are guarded by a findFirst check.
 *
 * The Docker API container runs this ONLY when user count is 0 (fresh database).
 * See docker/Dockerfile.api for the guard logic.
 */

import { Prisma, PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const asJson = <T>(value: T) => value as Prisma.InputJsonValue;

async function main() {
  console.log("Seeding database...");

  // ── Users & Roles ────────────────────────────────────────────────────────────────────────
  const roles = await Promise.all([
    prisma.role.upsert({ where: { key: "ADMIN" }, update: {}, create: { key: "ADMIN", label: "Administrator" } }),
    prisma.role.upsert({ where: { key: "OPERATOR" }, update: {}, create: { key: "OPERATOR", label: "Operator" } }),
    prisma.role.upsert({ where: { key: "VIEWER" }, update: {}, create: { key: "VIEWER", label: "Viewer" } }),
    prisma.role.upsert({ where: { key: "RISK_MANAGER" }, update: {}, create: { key: "RISK_MANAGER", label: "Risk Manager" } }),
    prisma.role.upsert({ where: { key: "TRADER" }, update: {}, create: { key: "TRADER", label: "Trader" } }),
  ]);
  const adminRole = roles[0];

  const adminUser = await prisma.user.upsert({
    where: { email: "admin@stockradar.local" },
    update: {},
    create: { email: "admin@stockradar.local", name: "Local Admin", isActive: true },
  });

  await prisma.userRole.upsert({
    where: { userId_roleId: { userId: adminUser.id, roleId: adminRole.id } },
    update: {},
    create: { userId: adminUser.id, roleId: adminRole.id },
  });

  // ── Integrations ─────────────────────────────────────────────────────────────────────────
  // Respect the TRADING_MODE env var for order semantics, but never seed a
  // synthetic paper broker account or synthetic balance snapshots.
  const tradingMode = (process.env.TRADING_MODE ?? "paper").toUpperCase() as "PAPER" | "LIVE";
  const mt5Login = process.env.REAL_MT5_LOGIN?.trim() || process.env.MT5_LOGIN?.trim() || "321783474";
  const mt5Label = `MT5 Demo ${mt5Login}`;
  const mt5Config = asJson({
    host: "http://mt5-adapter:4310",
    realDataOnly: true,
    paperBroker: false,
    login: mt5Login,
  });

  const mt5Integration = await prisma.integration.upsert({
    where: { id: "seed-mt5" },
    update: {
      name: mt5Label,
      mode: tradingMode,
      configJson: mt5Config,
    },
    create: {
      id: "seed-mt5",
      kind: "MT5",
      name: mt5Label,
      mode: tradingMode,
      enabled: true,
      configJson: mt5Config,
    },
  });

  await prisma.integrationStatus.create({
    data: {
      integrationId: mt5Integration.id,
      status: "DISCONNECTED",
      summary: "Waiting for the real MT5 bridge to confirm terminal and broker connectivity.",
      lastHeartbeatAt: new Date(),
    },
  });

  await prisma.integration.upsert({
    where: { id: "seed-discord" },
    update: {},
    create: {
      id: "seed-discord",
      kind: "DISCORD",
      name: "Discord Alerts Webhook",
      enabled: false,
      configJson: asJson({ webhookUrl: "" }),
    },
  });

  // ── Symbols ───────────────────────────────────────────────────────────────────────────────
  const symbolDefs = [
    { ticker: "AAPL", name: "Apple Inc.", assetClass: "EQUITY", exchange: "NASDAQ", sector: "Technology" },
    { ticker: "MSFT", name: "Microsoft Corp.", assetClass: "EQUITY", exchange: "NASDAQ", sector: "Technology" },
    { ticker: "NVDA", name: "NVIDIA Corp.", assetClass: "EQUITY", exchange: "NASDAQ", sector: "Technology" },
    { ticker: "AMD", name: "Advanced Micro Devices", assetClass: "EQUITY", exchange: "NASDAQ", sector: "Technology" },
    { ticker: "TSLA", name: "Tesla Inc.", assetClass: "EQUITY", exchange: "NASDAQ", sector: "Consumer Discretionary" },
    { ticker: "SPY", name: "SPDR S&P 500 ETF", assetClass: "ETF", exchange: "NYSE ARCA", sector: "Broad Market" },
    { ticker: "QQQ", name: "Invesco QQQ Trust", assetClass: "ETF", exchange: "NASDAQ", sector: "Technology" },
    { ticker: "EURUSD", name: "Euro / US Dollar", assetClass: "FX", exchange: "OTC", sector: "Forex" },
    { ticker: "XAUUSD", name: "Gold / US Dollar", assetClass: "COMMODITY", exchange: "OTC", sector: "Commodities" },
    { ticker: "BTCUSD", name: "Bitcoin / US Dollar", assetClass: "CRYPTO", exchange: "CRYPTO", sector: "Crypto" },
    { ticker: "ETHUSD", name: "Ethereum / US Dollar", assetClass: "CRYPTO", exchange: "CRYPTO", sector: "Crypto" },
  ] as const;

  for (const def of symbolDefs) {
    await prisma.symbol.upsert({
      where: { ticker: def.ticker },
      update: { name: def.name, assetClass: def.assetClass, exchange: def.exchange, sector: def.sector, isActive: true },
      create: { ticker: def.ticker, name: def.name, assetClass: def.assetClass, exchange: def.exchange, sector: def.sector, isActive: true },
    });
  }

  // ── Watchlist ─────────────────────────────────────────────────────────────────────────────
  const watchlist = await prisma.watchlist.upsert({
    where: { id: "seed-watchlist" },
    update: {},
    create: {
      id: "seed-watchlist",
      name: "Core Watchlist",
      description: "Primary trading universe",
      tier: "primary",
      scanIntervalMs: 30_000,
      isActive: true,
    },
  });

  for (const def of symbolDefs) {
    const symbol = await prisma.symbol.findUnique({ where: { ticker: def.ticker } });
    if (!symbol) continue;
    await prisma.watchlistItem.upsert({
      where: { watchlistId_symbolId: { watchlistId: watchlist.id, symbolId: symbol.id } },
      update: {},
      create: { watchlistId: watchlist.id, symbolId: symbol.id, priority: 50 },
    });
  }

  // ── Worker heartbeats — seed status, NOT "healthy" ───────────────────────────────────────
  // We deliberately seed as "seeded" (not "healthy") so the dashboard can distinguish
  // a worker that hasn't actually started from one that is genuinely running.
  const workerTypes = ["NEWS", "MARKET", "VALIDATION", "EXECUTION", "SUPERVISOR"] as const;
  for (const workerType of workerTypes) {
    await prisma.workerHeartbeat.upsert({
      where: { workerType },
      update: { metrics: asJson({ seeded: true }) },
      create: {
        workerType,
        serviceName: `worker-${workerType.toLowerCase()}`,
        status: "seeded",
        currentTask: "not_started",
        lagMs: 0,
        metrics: asJson({ seeded: true }),
        lastSeenAt: new Date(),
      },
    });
  }

  // ── Notification templates ────────────────────────────────────────────────────────────────
  await prisma.notificationTemplate.upsert({
    where: { key: "worker-degraded" },
    update: {},
    create: {
      key: "worker-degraded",
      channel: "DISCORD",
      severity: "WARNING",
      titleTemplate: "Worker Degraded: {{workerType}}",
      bodyTemplate: "{{workerType}} has entered a degraded state. Last seen: {{lastSeenAt}}",
      enabled: true,
    },
  });
  await prisma.notificationTemplate.upsert({
    where: { key: "trade-executed" },
    update: {},
    create: {
      key: "trade-executed",
      channel: "DISCORD",
      severity: "INFO",
      titleTemplate: "Trade Executed: {{symbol}}",
      bodyTemplate: "{{direction}} {{symbol}} at {{price}} — risk {{riskPct}}%",
      enabled: true,
    },
  });

  // ── System settings ───────────────────────────────────────────────────────────────────────
  await prisma.systemSetting.upsert({
    where: { key: "risk.dynamicControls" },
    update: {},
    create: {
      key: "risk.dynamicControls",
      value: asJson({ maxRiskPerTradePct: 0.75, lastAdjustedAt: null, reason: null }),
      valueType: "json",
      description: "Dynamic risk per trade throttle managed by the supervisor",
    },
  });
  await prisma.systemSetting.upsert({
    where: { key: "risk.killSwitch" },
    update: {},
    create: {
      key: "risk.killSwitch",
      value: asJson({ active: false }),
      valueType: "json",
      description: "Manual emergency trading stop",
    },
  });

  // ── Default Account (wraps the MT5 integration) ───────────────────────────────────────────
  // The old schema treated the single MT5 integration as the "account". From
  // multi-account onward, we model that explicitly as an Account row with a
  // default rule profile + phase. Backfill below points historical rows at
  // this account so nothing is orphaned.
  //
  // Circular FK note: Account.currentPhaseId → AccountPhase.id, but
  // AccountPhase.accountId → Account.id. So we create the Account first
  // (without currentPhaseId/activeRuleProfileId), then create the phase +
  // rule profile, then UPDATE the Account to point at them.
  const startingBalance = Number(process.env.DEFAULT_ACCOUNT_STARTING_BALANCE ?? 10_000);
  const defaultAccountId = `mt5-${mt5Login}`;
  const defaultPhaseId = `${defaultAccountId}-phase`;
  const defaultRuleProfileId = `${defaultAccountId}-rule-profile`;
  const accountDisplayName = `MT5 Demo ${mt5Login}`;

  await prisma.account.upsert({
    where: { id: defaultAccountId },
    update: {
      displayName: accountDisplayName,
      tradingMode,
      integrationId: mt5Integration.id,
      brokerAccountLogin: mt5Login,
      startingBalance,
      tags: asJson(["mt5", "real-demo"]),
      notes: "Real MT5 demo account. Live data is sourced only through the MT5 bridge.",
    },
    create: {
      id: defaultAccountId,
      displayName: accountDisplayName,
      kind: "DEMO",
      providerName: "MetaTrader 5",
      brokerAccountLogin: mt5Login,
      integrationId: mt5Integration.id,
      currency: "USD",
      startingBalance,
      mode: "NORMAL",
      health: "HEALTHY",
      isActive: true,
      tradingMode,
      tags: asJson(["mt5", "real-demo"]),
      notes: "Real MT5 demo account. Live data is sourced only through the MT5 bridge.",
    },
  });

  const defaultRuleProfile = await prisma.accountRuleProfile.upsert({
    where: { id: defaultRuleProfileId },
    update: {
      providerName: "MetaTrader 5",
      startingBalance,
    },
    create: {
      id: defaultRuleProfileId,
      accountId: defaultAccountId,
      version: 1,
      isActive: true,
      providerName: "MetaTrader 5",
      providerRulesUrl: null,
      startingBalance,
      dailyLossLimitUsd: startingBalance * 0.03,
      totalLossLimitUsd: startingBalance * 0.08,
      trailingDrawdownUsd: null,
      profitTargetUsd: null,
      maxRiskPerTradePct: 0.005,
      maxRiskPerTradeUsd: startingBalance * 0.005,
      minRiskRewardRatio: 1.5,
      maxOpenPositions: 3,
      maxConcurrentRiskPct: 0.03,
      maxCorrelatedPositions: 2,
      allowedAssetClasses: asJson([]),
      forbiddenAssetClasses: asJson([]),
      allowedSessions: asJson([]),
      forbiddenSessions: asJson([]),
      allowedTimeframes: asJson([]),
      noTradeBeforeUtc: null,
      noTradeAfterUtc: null,
      newsBlackoutMinutesBefore: 5,
      newsBlackoutMinutesAfter: 10,
      newsBlackoutUrgencies: asJson(["HIGH", "CRITICAL"]),
      blockWeekendHold: true,
      allowHedging: false,
      cautiousLossFraction: 0.5,
      recoveryLossFraction: 0.75,
      targetNearFraction: null,
      payoutEligibleAfter: 0,
      payoutProtectWindowDays: 0,
    },
  });

  const defaultPhase = await prisma.accountPhase.upsert({
    where: { id: defaultPhaseId },
    update: {
      startingBalance,
    },
    create: {
      id: defaultPhaseId,
      accountId: defaultAccountId,
      kind: "PERSONAL",
      isActive: true,
      startingBalance,
      profitTargetUsd: null,
      dailyLossLimitUsd: startingBalance * 0.03,
      totalLossLimitUsd: startingBalance * 0.08,
      outcome: "IN_PROGRESS",
      reason: null,
      notes: "Real MT5 demo account phase. Snapshot data must come from the MT5 bridge.",
    },
  });

  // Point the account at its default phase + rule profile.
  await prisma.account.update({
    where: { id: defaultAccountId },
    data: {
      currentPhaseId: defaultPhase.id,
      activeRuleProfileId: defaultRuleProfile.id,
    },
  });

  // ── Backfill: historical rows (if any) get pointed at the default account ────────────────
  // Safe/idempotent: only rows with accountId IS NULL get touched.
  await prisma.$executeRawUnsafe(
    `UPDATE "AccountSnapshot" SET "accountId" = $1, "accountPhaseId" = $2 WHERE "accountId" IS NULL`,
    defaultAccountId,
    defaultPhase.id,
  );
  await prisma.$executeRawUnsafe(
    `UPDATE "Order" SET "accountId" = $1 WHERE "accountId" IS NULL`,
    defaultAccountId,
  );
  await prisma.$executeRawUnsafe(
    `UPDATE "Position" SET "accountId" = $1 WHERE "accountId" IS NULL`,
    defaultAccountId,
  );
  await prisma.$executeRawUnsafe(
    `UPDATE "ExecutionDecision" SET "accountId" = $1 WHERE "accountId" IS NULL`,
    defaultAccountId,
  );
  await prisma.$executeRawUnsafe(
    `UPDATE "RiskEvent" SET "accountId" = $1 WHERE "accountId" IS NULL AND "positionId" IS NOT NULL`,
    defaultAccountId,
  );

  // ── Default setup allocation policy (personal account only) ──────────────────────────────
  await prisma.setupAllocationPolicy.upsert({
    where: { setupKey: "default" },
    update: {},
    create: {
      setupKey: "default",
      policy: "ONE_ACCOUNT_ONLY",
      maxAccounts: 1,
      requiredTags: asJson([]),
      excludedTags: asJson([]),
      allowedPhaseKinds: asJson([]),
      allowedAccountModes: asJson(["NORMAL", "CAUTIOUS"]),
      preferHigherHealth: true,
      preferLowerUtilization: true,
      notes: "Default fallback policy — one account per candidate.",
    },
  });

  console.log("Seed complete.");
}

main()
  .catch((error) => {
    console.error("Seed error:", error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
