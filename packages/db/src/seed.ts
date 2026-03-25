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
  const mt5Integration = await prisma.integration.upsert({
    where: { id: "seed-mt5" },
    update: {},
    create: {
      id: "seed-mt5",
      kind: "MT5",
      name: "MT5 Paper Broker (Local Adapter)",
      mode: "PAPER",
      enabled: true,
      configJson: asJson({ host: "http://mt5-adapter:4310", paper: true }),
    },
  });

  await prisma.integrationStatus.create({
    data: {
      integrationId: mt5Integration.id,
      status: "CONNECTED",
      summary: "Paper trading adapter running locally.",
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
