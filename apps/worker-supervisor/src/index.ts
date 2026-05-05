import { getPlatformConfig } from "@stock-radar/config";
import { summarizeAccountRisk, summarizeWorkerHealth, computeAtrTrailingStop } from "@stock-radar/core";
import type { PriceBar } from "@stock-radar/types";
import { Prisma } from "@prisma/client";
import { completeWorkerRun, createWorkerRun, failWorkerRun, prisma, upsertWorkerHeartbeat } from "@stock-radar/db";
import { createLogger } from "@stock-radar/logging";
import { createPlatformWorker, ensureDefaultSchedules, queueNames, queueNotification } from "@stock-radar/queues";
import { stableHash } from "@stock-radar/shared";
import { runPositionSupervisor } from "./jobs/position-supervisor";
import { runPostTradeReviewer } from "./jobs/post-trade-reviewer";
import { runWeeklySynthesis } from "./jobs/weekly-synthesis";
import { runPortfolioExposureSnapshot } from "./jobs/portfolio-exposure";
import { runJournalExportSweeper } from "./jobs/journal-export-sweeper";

const config = getPlatformConfig();
const logger = createLogger("worker-supervisor");
const asJson = <T>(value: T) => value as Prisma.InputJsonValue;
const asObject = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
const buildNotificationDedupeKey = (parts: Record<string, unknown>) =>
  `notification-${stableHash(parts).slice(0, 24)}`;

const enqueueSupervisorNotification = async (input: {
  category: string;
  severity: "info" | "warning" | "critical";
  title: string;
  body: string;
  metadata: Record<string, unknown>;
}) => {
  const dedupeKey = buildNotificationDedupeKey({
    category: input.category,
    severity: input.severity,
    title: input.title,
    body: input.body,
  });

  await queueNotification({
    category: input.category as "worker_health" | "trade_event" | "risk_event" | "daily_summary" | "integration" | "market_news" | "supervisor",
    severity: input.severity,
    title: input.title,
    body: input.body,
    dedupeKey,
    metadata: input.metadata,
  });

  return dedupeKey;
};

const readDynamicControls = async () => {
  const setting = await prisma.systemSetting.findUnique({ where: { key: "risk.dynamicControls" } });
  const value = asObject(setting?.value);
  const maxRiskPerTradePct =
    typeof value?.maxRiskPerTradePct === "number" && Number.isFinite(value.maxRiskPerTradePct)
      ? value.maxRiskPerTradePct
      : config.risk.maxRiskPerTradePct;
  const lastAdjustedAt = typeof value?.lastAdjustedAt === "string" ? value.lastAdjustedAt : null;

  return {
    maxRiskPerTradePct,
    lastAdjustedAt,
    reason: typeof value?.reason === "string" ? value.reason : null,
  };
};

const maybeThrottleRisk = async (
  account: {
    balance: number;
    realizedPnlDaily: number;
    drawdownPct: number;
  } | null,
) => {
  const controls = await readDynamicControls();
  if (!account) return null;

  const recentPlacedDecisions = await prisma.executionDecision.findMany({
    where: {
      action: "PLACE",
      validationRunId: {
        not: null,
      },
    },
    include: {
      validationRun: true,
    },
    orderBy: { createdAt: "desc" },
    take: 12,
  });

  const expectancies = recentPlacedDecisions
    .map((decision: any) => decision.validationRun?.expectancy ?? null)
    .filter((value: unknown): value is number => typeof value === "number");
  const averageExpectancy =
    expectancies.length === 0
      ? 0
      : expectancies.reduce((total: number, value: number) => total + value, 0) / expectancies.length;
  const realizedLossPct =
    account.balance <= 0 ? 0 : Math.max(0, (-Math.min(account.realizedPnlDaily, 0) / account.balance) * 100);
  const drawdownPressure = account.drawdownPct >= Math.max(1, config.risk.maxDailyLossPct * 0.5);
  const expectancyMismatch = averageExpectancy >= 0.15 && realizedLossPct >= config.risk.maxRiskPerTradePct * 0.75;

  if (!drawdownPressure && !expectancyMismatch) {
    return null;
  }

  if (controls.lastAdjustedAt) {
    const lastAdjustedMs = new Date(controls.lastAdjustedAt).getTime();
    if (Date.now() - lastAdjustedMs < config.risk.riskThrottleCooldownMinutes * 60_000) {
      return null;
    }
  }

  if (controls.maxRiskPerTradePct <= config.risk.minDynamicRiskPerTradePct) {
    return null;
  }

  const nextRiskPerTradePct = Math.max(
    config.risk.minDynamicRiskPerTradePct,
    Number((controls.maxRiskPerTradePct - config.risk.riskThrottleStepPct).toFixed(2)),
  );
  if (nextRiskPerTradePct >= controls.maxRiskPerTradePct) {
    return null;
  }

  const reason = drawdownPressure
    ? `Drawdown reached ${account.drawdownPct.toFixed(2)}%, so dynamic risk was reduced.`
    : `Expected edge stayed positive (${averageExpectancy.toFixed(2)}R) while realized daily PnL lagged, so risk was reduced.`;

  await prisma.systemSetting.upsert({
    where: { key: "risk.dynamicControls" },
    update: {
      value: {
        maxRiskPerTradePct: nextRiskPerTradePct,
        lastAdjustedAt: new Date().toISOString(),
        reason,
      },
      valueType: "json",
      description: "Supervisor-managed dynamic execution throttle",
    },
    create: {
      key: "risk.dynamicControls",
      value: {
        maxRiskPerTradePct: nextRiskPerTradePct,
        lastAdjustedAt: new Date().toISOString(),
        reason,
      },
      valueType: "json",
      description: "Supervisor-managed dynamic execution throttle",
    },
  });

  await prisma.riskEvent.create({
    data: {
      severity: "WARNING",
      eventType: "dynamic_risk_throttle",
      message: `Risk per trade was reduced from ${controls.maxRiskPerTradePct.toFixed(2)}% to ${nextRiskPerTradePct.toFixed(2)}%.`,
      details: {
        averageExpectancy,
        realizedLossPct,
        drawdownPct: account.drawdownPct,
        previousRiskPerTradePct: controls.maxRiskPerTradePct,
        nextRiskPerTradePct,
      },
      blocking: false,
    },
  });

  await prisma.auditLog.create({
    data: {
      actorType: "WORKER",
      actorId: "worker-supervisor",
      workerType: "SUPERVISOR",
      severity: "WARNING",
      category: "supervisor.dynamic_risk",
      message: `Supervisor lowered max risk per trade to ${nextRiskPerTradePct.toFixed(2)}%.`,
      entityType: "system_setting",
      entityId: "risk.dynamicControls",
      data: {
        averageExpectancy,
        realizedLossPct,
        previousRiskPerTradePct: controls.maxRiskPerTradePct,
        nextRiskPerTradePct,
      },
    },
  });

  return {
    summary: `Dynamic risk throttle lowered max risk per trade to ${nextRiskPerTradePct.toFixed(2)}%.`,
    nextRiskPerTradePct,
  };
};

// ─── MT5 Position & Account Sync ─────────────────────────────────────────────

/**
 * Fetch live account state from MT5 adapter and write an AccountSnapshot.
 * This is what drives the Balance / Equity / PnL cards on the dashboard.
 */
const syncMT5Account = async () => {
  const url = `${config.services.mt5AdapterUrl}/account`;
  let data: Record<string, unknown>;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) {
      logger.warn("MT5 account sync skipped — adapter returned non-200", { status: res.status });
      return;
    }
    data = (await res.json()) as Record<string, unknown>;
  } catch (err) {
    logger.warn("MT5 account sync failed — adapter unreachable", { error: (err as Error).message });
    return;
  }

  const num = (key: string, fallback = 0) =>
    typeof data[key] === "number" ? (data[key] as number) : fallback;

  const integration = await prisma.integration.findFirst({ where: { kind: "MT5" } });

  await prisma.accountSnapshot.create({
    data: {
      integrationId: integration?.id ?? null,
      balance: num("balance"),
      equity: num("equity"),
      freeMargin: num("freeMargin"),
      usedMargin: num("usedMargin"),
      marginLevel: num("usedMargin") > 0
        ? (num("equity") / num("usedMargin")) * 100
        : 0,
      openPnl: num("openPnl"),
      realizedPnlDaily: num("realizedPnlDaily"),
      drawdownPct: num("drawdownPct"),
      maxDrawdownPct: num("maxDrawdownPct", 2.5),
      riskState: (["NORMAL", "CAUTION", "BLOCKED", "KILL_SWITCH"].includes(String(data.riskState))
        ? data.riskState
        : "NORMAL") as "NORMAL" | "CAUTION" | "BLOCKED" | "KILL_SWITCH",
      killSwitchActive: data.killSwitchActive === true,
      mode: typeof data.mode === "string" ? data.mode.toUpperCase() as "PAPER" | "LIVE" : "PAPER",
    },
  });

  logger.info("Account snapshot written", {
    balance: num("balance"),
    equity: num("equity"),
    openPnl: num("openPnl"),
    riskState: data.riskState,
  });
};

/**
 * Fetch live MT5 positions and reconcile with the DB:
 *   - Positions in MT5 but not DB → INSERT (externally opened trades are visible on dashboard)
 *   - Positions in DB (OPEN) but not in MT5 → CLOSE them (MT5 is the source of truth)
 *   - Positions in both → UPDATE unrealized PnL from live MT5 data
 */
const syncMT5Positions = async () => {
  const url = `${config.services.mt5AdapterUrl}/positions`;

  // The adapter returns different schemas depending on whether it is connected
  // to the live Python bridge or running in paper mode:
  //   Live bridge:  { ticket, symbol, type: "buy"|"sell", volume, price_open, sl, tp, profit }
  //   Paper mode:   { brokerPositionId, symbol, direction: "LONG"|"SHORT",
  //                   quantity, averageEntryPrice, stopLoss, takeProfit, unrealizedPnl }
  // We normalise both into a single shape before processing.
  interface NormalisedPosition {
    ticketKey: string;       // unique broker key for deduplication
    ticketNum: number | undefined; // numeric ticket for metadata (live only)
    symbol: string;
    direction: "LONG" | "SHORT";
    volume: number;
    priceOpen: number;
    sl: number;
    tp: number;
    profit: number;
  }

  const normalisePosition = (raw: Record<string, unknown>): NormalisedPosition | null => {
    const sym = typeof raw.symbol === "string" ? raw.symbol : "";
    if (!sym) return null;

    // Live bridge format — ticket is a numeric MT5 position ticket
    if (typeof raw.ticket === "number") {
      const ticket = raw.ticket;
      // Use Number(...) || 0 so NaN, undefined, and 0 all fall back to 0
      const priceOpen = Number(raw.price_open) || 0;
      const direction: "LONG" | "SHORT" = raw.type === "buy" ? "LONG" : "SHORT";
      return {
        ticketKey: String(ticket),
        ticketNum: ticket,
        symbol: sym,
        direction,
        volume: Number(raw.volume) || 0,
        priceOpen,
        sl: Number(raw.sl) || 0,
        tp: Number(raw.tp) || 0,
        profit: Number(raw.profit) || 0,
      };
    }

    // Live bridge edge case — price_open present but no ticket yet (rare, e.g. pending)
    // Build a stable dedup key from symbol + direction + rounded price so we don't
    // create duplicate DB rows on each sync cycle.
    if (typeof raw.price_open === "number") {
      const priceOpen = raw.price_open;
      const direction: "LONG" | "SHORT" = raw.type === "buy" ? "LONG" : "SHORT";
      const stableKey = `live-${sym}-${direction}-${Math.round(priceOpen * 10000)}`;
      return {
        ticketKey: stableKey,
        ticketNum: undefined,
        symbol: sym,
        direction,
        volume: Number(raw.volume) || 0,
        priceOpen,
        sl: Number(raw.sl) || 0,
        tp: Number(raw.tp) || 0,
        profit: Number(raw.profit) || 0,
      };
    }

    // Paper mode adapter format
    const brokerId = raw.brokerPositionId ?? raw.positionId;
    if (brokerId != null) {
      const dir = typeof raw.direction === "string" ? raw.direction.toUpperCase() : "LONG";
      const priceOpen = Number(raw.averageEntryPrice) || 0;
      return {
        ticketKey: String(brokerId),
        ticketNum: undefined,
        symbol: sym,
        direction: dir === "SHORT" ? "SHORT" : "LONG",
        volume: Number(raw.quantity) || 0,
        priceOpen,
        sl: Number(raw.stopLoss) || 0,
        tp: Number(raw.takeProfit) || 0,
        profit: Number(raw.unrealizedPnl) || 0,
      };
    }

    return null;
  };

  let rawPositions: Array<Record<string, unknown>>;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) {
      logger.warn("MT5 position sync skipped — adapter returned non-200", { status: res.status });
      return;
    }
    rawPositions = (await res.json()) as Array<Record<string, unknown>>;
  } catch (err) {
    logger.warn("MT5 position sync failed — adapter unreachable", { error: (err as Error).message });
    return;
  }

  if (!Array.isArray(rawPositions)) return;

  const mt5Positions: NormalisedPosition[] = rawPositions
    .map(normalisePosition)
    .filter((p): p is NormalisedPosition => p !== null);

  // Load all open DB positions
  const dbPositions = await prisma.position.findMany({
    where: { status: "OPEN" },
    include: { symbol: true },
  });

  const dbByTicket = new Map<string, (typeof dbPositions)[number]>(
    dbPositions
      .filter((p: (typeof dbPositions)[number]) => p.brokerPositionId != null)
      .map((p: (typeof dbPositions)[number]) => [String(p.brokerPositionId), p]),
  );

  const mt5TicketSet = new Set(mt5Positions.map((p) => p.ticketKey));

  // ── 1. Update existing or create new positions from MT5 ──────────────────
  for (const mp of mt5Positions) {
    const { ticketKey, ticketNum, direction } = mp;
    const existing = dbByTicket.get(ticketKey);

    if (existing) {
      // Update unrealized PnL live from MT5
      await prisma.position.update({
        where: { id: existing.id },
        data: { unrealizedPnl: mp.profit },
      });
    } else {
      // New position in MT5 not yet in DB — find or derive the symbol
      const rawTicker = mp.symbol.toUpperCase();
      // Try exact match first, then strip broker suffixes (.PRO, .m, etc.)
      const cleanTicker = rawTicker.replace(/\.(PRO|m|ECN|RAW|PLUS)$/i, "");

      let symbol = await prisma.symbol.findFirst({
        where: { ticker: { in: [rawTicker, cleanTicker] } },
      });

      if (!symbol) {
        // Auto-create symbol so the position can be tracked
        const assetClass =
          ["BTC", "ETH", "SOL", "LTC", "XRP"].some((c) => cleanTicker.includes(c))
            ? "CRYPTO"
            : ["XAU", "XAG", "OIL", "BRENT"].some((c) => cleanTicker.includes(c))
              ? "COMMODITY"
              : cleanTicker.length === 6 &&
                ["USD", "EUR", "GBP", "JPY", "CHF", "AUD", "NZD", "CAD"].some((c) =>
                  cleanTicker.startsWith(c) || cleanTicker.endsWith(c)
                )
                ? "FX"
                : "EQUITY";

        symbol = await prisma.symbol.upsert({
          where: { ticker: cleanTicker },
          update: {},
          create: {
            ticker: cleanTicker,
            name: cleanTicker,
            assetClass: assetClass as never,
            isActive: true,
          },
        });
      }

      await prisma.position.create({
        data: {
          symbolId: symbol.id,
          brokerPositionId: ticketKey,
          direction,
          quantity: mp.volume,
          avgEntryPrice: mp.priceOpen,
          stopLoss: mp.sl > 0 ? mp.sl : mp.priceOpen * (direction === "LONG" ? 0.98 : 1.02),
          takeProfit: mp.tp > 0 ? mp.tp : mp.priceOpen * (direction === "LONG" ? 1.04 : 0.96),
          unrealizedPnl: mp.profit,
          realizedPnl: 0,
          exposurePct: 1.0,
          status: "OPEN",
          openedAt: new Date(),
          metadata: { source: "mt5_sync", ticket: ticketNum ?? ticketKey },
        },
      });

      logger.info("MT5 position imported to DB", {
        symbol: mp.symbol,
        direction,
        volume: mp.volume,
        ticket: ticketKey,
        profit: mp.profit,
      });

      await prisma.auditLog.create({
        data: {
          actorType: "WORKER",
          actorId: "worker-supervisor",
          workerType: "SUPERVISOR",
          severity: "INFO",
          category: "mt5_sync",
          message: `Imported MT5 position ticket ${ticketKey} (${mp.symbol} ${direction} ${mp.volume} lots @ ${mp.priceOpen})`,
          entityType: "position",
          entityId: ticketKey,
          symbolId: symbol.id,
        },
      });
    }
  }

  // ── 2. Close DB positions that are no longer open in MT5 ─────────────────
  for (const dbPos of dbPositions) {
    if (!dbPos.brokerPositionId) continue; // system-generated, skip
    if (mt5TicketSet.has(dbPos.brokerPositionId)) continue; // still open in MT5

    await prisma.position.update({
      where: { id: dbPos.id },
      data: {
        status: "CLOSED",
        closedAt: new Date(),
        realizedPnl: dbPos.unrealizedPnl, // best approximation at close
        unrealizedPnl: 0,
      },
    });

    logger.info("DB position marked CLOSED (no longer in MT5)", {
      symbol: dbPos.symbol.ticker,
      ticket: dbPos.brokerPositionId,
    });

    await prisma.auditLog.create({
      data: {
        actorType: "WORKER",
        actorId: "worker-supervisor",
        workerType: "SUPERVISOR",
        severity: "INFO",
        category: "mt5_sync",
        message: `Position ticket ${dbPos.brokerPositionId} (${dbPos.symbol.ticker}) closed in MT5 — marked CLOSED in DB`,
        entityType: "position",
        entityId: dbPos.id,
        symbolId: dbPos.symbolId,
      },
    });
  }

  if (mt5Positions.length > 0) {
    logger.info("MT5 position sync complete", {
      mt5Count: mt5Positions.length,
      dbCount: dbPositions.length,
    });
  }
};

// ─── Bridge Health Sync ─────────────────────────────────────────────────────

const resolveBridgeHost = () => {
  try {
    const url = new URL(config.services.mt5AdapterUrl);
    return `${url.hostname}:${url.port}`;
  } catch {
    return config.services.mt5AdapterUrl;
  }
};

const fetchAdapterHealth = async (): Promise<{
  reachable: boolean;
  bridgeConnected: boolean;
  latencyMs: number | null;
  bridgeError: string | null;
}> => {
  const startedAt = Date.now();
  try {
    let response = await fetch(`${config.services.mt5AdapterUrl}/health/deep`, {
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) {
      response = await fetch(`${config.services.mt5AdapterUrl}/health`, {
        signal: AbortSignal.timeout(8_000),
      });
    }
    const latencyMs = Date.now() - startedAt;
    if (!response.ok) {
      return {
        reachable: false,
        bridgeConnected: false,
        latencyMs,
        bridgeError: `Adapter health endpoint returned ${response.status}`,
      };
    }
    const payload = (await response.json()) as {
      reachable?: boolean;
      bridgeConnected?: boolean;
      bridgeError?: string | null;
    };
    return {
      reachable: payload.reachable ?? true,
      bridgeConnected: payload.bridgeConnected === true,
      latencyMs,
      bridgeError: payload.bridgeError ?? null,
    };
  } catch (error) {
    return {
      reachable: false,
      bridgeConnected: false,
      latencyMs: null,
      bridgeError: (error as Error).message,
    };
  }
};

/**
 * Persist one BridgeHealthSnapshot per active account on every
 * supervisor health cycle. This gives the stale-bridge gate a concrete
 * heartbeat source and powers the /bridge page + dashboard warning.
 */
const syncBridgeHealthSnapshots = async () => {
  const accounts = await prisma.account.findMany({
    where: { isActive: true },
    select: {
      id: true,
      displayName: true,
      integrationId: true,
      brokerAccountLogin: true,
    },
  });

  if (accounts.length === 0) {
    return;
  }

  const bridgeHost = resolveBridgeHost();
  const health = await fetchAdapterHealth();
  const now = new Date();

  const status = !health.reachable
    ? "DISCONNECTED"
    : !health.bridgeConnected
      ? "DISCONNECTED"
      : (health.latencyMs ?? 0) > 2_000
        ? "DEGRADED"
        : "CONNECTED";

  const stalenessSeconds = status === "CONNECTED" || status === "DEGRADED" ? 0 : 999;

  await prisma.$transaction(
    accounts.map((account: { id: string; integrationId: string; brokerAccountLogin: string | null }) =>
      prisma.bridgeHealthSnapshot.create({
        data: {
          accountId: account.id,
          integrationId: account.integrationId,
          bridgeHost,
          status: status as "CONNECTED" | "DEGRADED" | "STALE" | "DISCONNECTED" | "ERROR",
          terminalConnected: health.bridgeConnected,
          brokerConnected: health.bridgeConnected,
          accountLogin: account.brokerAccountLogin,
          server: null,
          pingMs: health.latencyMs,
          lastOrderAckMs: null,
          lastPositionSyncMs: null,
          lastHeartbeatAt: now,
          stalenessSeconds,
          sdkVersion: null,
          notes: health.bridgeError,
        },
      }),
    ),
  );

  logger.info("Bridge health snapshots written", {
    accounts: accounts.length,
    status,
    latencyMs: health.latencyMs,
    bridgeConnected: health.bridgeConnected,
    bridgeError: health.bridgeError,
  });
};

// ─── Price Bar Helpers ────────────────────────────────────────────────────────

/** Fetch recent price bars for a symbol+timeframe from the DB */
const getRecentBars = async (symbolId: string, timeframe: string, take = 30): Promise<PriceBar[]> => {
  const rows = await prisma.priceBar.findMany({
    where: { symbolId, timeframe },
    orderBy: { timestamp: "asc" },
    take,
    select: { open: true, high: true, low: true, close: true, volume: true, timestamp: true },
  });
  return rows.map((r: { open: number; high: number; low: number; close: number; volume: number; timestamp: Date }) => ({
    symbol: symbolId,
    timeframe: timeframe as PriceBar["timeframe"],
    timestamp: r.timestamp.toISOString(),
    open: r.open,
    high: r.high,
    low: r.low,
    close: r.close,
    volume: r.volume,
  }));
};

/**
 * ATR Trailing Stop Manager
 * Runs each supervisor cycle. For every open position it:
 *   1. Fetches recent price bars from the DB
 *   2. Computes the ATR-based trailing stop
 *   3. If the stop has moved in the position's favour, updates it in the DB
 *      and sends a modify order to the MT5 adapter
 */
const manageTrailingStops = async () => {
  const openPositions = await prisma.position.findMany({
    where: { status: "OPEN" },
    include: { symbol: true },
  });

  if (openPositions.length === 0) return;

  const mt5AdapterUrl = config.services.mt5AdapterUrl;

  for (const pos of openPositions) {
    try {
      const bars = await getRecentBars(pos.symbolId, pos.stopLoss ? "15m" : "1h", 30);
      if (bars.length < 15) continue;

      const direction = pos.direction as "LONG" | "SHORT";
      const trailResult = computeAtrTrailingStop(
        bars,
        direction,
        pos.stopLoss,
        pos.avgEntryPrice,
        2.0, // 2× ATR trail
      );

      if (!trailResult.moved) continue;

      // Only accept the new stop if it genuinely improves the position
      const improved =
        direction === "LONG"
          ? trailResult.newStopLoss > pos.stopLoss  // trail up
          : trailResult.newStopLoss < pos.stopLoss; // trail down

      if (!improved) continue;

      // Update in DB
      await prisma.position.update({
        where: { id: pos.id },
        data: { stopLoss: trailResult.newStopLoss },
      });

      // Send modify to MT5 adapter if connected
      try {
        await fetch(`${mt5AdapterUrl}/positions/${pos.id}/modify`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ stopLoss: trailResult.newStopLoss }),
          signal: AbortSignal.timeout(5000),
        });
      } catch {
        // Non-fatal: DB is the source of truth; adapter will resync
      }

      logger.info("ATR trailing stop moved", {
        symbol: pos.symbol.ticker,
        direction,
        oldStop: pos.stopLoss.toFixed(5),
        newStop: trailResult.newStopLoss.toFixed(5),
        atr: trailResult.atr.toFixed(5),
        distanceAtr: trailResult.distanceAtr,
      });

      await prisma.auditLog.create({
        data: {
          actorType: "WORKER",
          actorId: "worker-supervisor",
          workerType: "SUPERVISOR",
          severity: "INFO",
          category: "trailing_stop",
          message: `Trailing stop moved for ${pos.symbol.ticker}: ${pos.stopLoss.toFixed(5)} → ${trailResult.newStopLoss.toFixed(5)} (ATR ${trailResult.atr.toFixed(5)})`,
          entityType: "position",
          entityId: pos.id,
          symbolId: pos.symbolId,
        },
      });
    } catch (err) {
      logger.warn("Failed to compute trailing stop", { positionId: pos.id, error: (err as Error).message });
    }
  }
};

const processSupervisorJob = async (trigger: "health_check" | "daily_summary" | "manual") => {
  const run = await createWorkerRun({
    workerType: "SUPERVISOR",
    queueName: queueNames.supervisor,
    jobName: trigger,
    payload: { trigger },
  });

  try {
    await upsertWorkerHeartbeat({
      workerType: "SUPERVISOR",
      serviceName: "worker-supervisor",
      status: "running",
      currentTask: trigger,
    });

    if (trigger === "daily_summary") {
      const snapshots = await prisma.accountSnapshot.findMany({
        orderBy: { capturedAt: "desc" },
        take: 2,
      });
      const latest = snapshots[0];
      const previous = snapshots[1] ?? latest;

      await enqueueSupervisorNotification({
        category: "daily_summary",
        severity: "info",
        title: "Daily trading summary",
        body: latest
          ? `Balance ${previous?.balance?.toFixed(2) ?? latest.balance.toFixed(2)} -> ${latest.balance.toFixed(2)}. Realized PnL ${latest.realizedPnlDaily.toFixed(2)}.`
          : "No account snapshot available yet.",
        metadata: { latest, previous },
      });
    } else {
      const [heartbeats, account] = await Promise.all([
        prisma.workerHeartbeat.findMany({ orderBy: { workerType: "asc" } }),
        prisma.accountSnapshot.findFirst({ orderBy: { capturedAt: "desc" } }),
      ]);

      // Sync live MT5 account state → AccountSnapshot (drives dashboard balance/equity/PnL)
      await syncMT5Account();

      // Sync bridge freshness/status per active account for stale-bridge gating.
      await syncBridgeHealthSnapshots();

      // Sync live MT5 positions → DB (reconcile open/closed, import new)
      await syncMT5Positions();

      // Manage ATR trailing stops on all open positions
      await manageTrailingStops();

      // AI-assisted position supervision (rate-limited per-position)
      await runPositionSupervisor(config.services.mt5AdapterUrl).catch((err) => {
        logger.warn("Position supervisor cycle error", { error: (err as Error).message });
      });

      const throttleEvent = await maybeThrottleRisk(
        account
          ? {
              balance: account.balance,
              realizedPnlDaily: account.realizedPnlDaily,
              drawdownPct: account.drawdownPct,
            }
          : null,
      );

      const workerAlerts = summarizeWorkerHealth(
        heartbeats.map((heartbeat: any) => ({
          workerType: heartbeat.workerType.toLowerCase() as "news" | "market" | "validation" | "execution" | "supervisor",
          status:
            Date.now() - heartbeat.lastSeenAt.getTime() > config.schedules.supervisorMs * 4
              ? "offline"
              : heartbeat.status === "degraded"
                ? "degraded"
                : "healthy",
          lastHeartbeatAt: heartbeat.lastSeenAt.toISOString(),
          lagMs: heartbeat.lagMs,
          currentTask: heartbeat.currentTask ?? "idle",
          failureCount24h: 0,
        })),
      );
      const accountAlerts = summarizeAccountRisk(
        account
          ? {
              balance: account.balance,
              equity: account.equity,
              freeMargin: account.freeMargin,
              usedMargin: account.usedMargin,
              openPnl: account.openPnl,
              realizedPnlDaily: account.realizedPnlDaily,
              drawdownPct: account.drawdownPct,
              maxDrawdownPct: account.maxDrawdownPct,
              riskState: account.riskState,
              killSwitchActive: account.killSwitchActive,
              mode: account.mode === "PAPER" ? "paper" : "live",
            }
          : null,
      );
      const throttleAlerts = throttleEvent
        ? [{ severity: "warning" as const, summary: throttleEvent.summary }]
        : [];

      for (const alert of [...workerAlerts, ...accountAlerts, ...throttleAlerts]) {
        const dedupeKey = await enqueueSupervisorNotification({
          category: alert.severity === "critical" ? "supervisor" : "worker_health",
          severity: alert.severity,
          title: "Supervisor alert",
          body: alert.summary,
          metadata: { trigger, summary: alert.summary },
        });

        await prisma.supervisorEvent.create({
          data: {
            severity: alert.severity.toUpperCase() as "INFO" | "WARNING" | "CRITICAL",
            eventType: "health_check",
            summary: alert.summary,
            details: { dedupeKey },
          },
        });
      }
    }

    await completeWorkerRun(run.id, `Supervisor ${trigger} processed`);
    await upsertWorkerHeartbeat({
      workerType: "SUPERVISOR",
      serviceName: "worker-supervisor",
      status: "healthy",
      currentTask: "idle",
    });
  } catch (error) {
    const err = error as Error;
    await failWorkerRun({
      runId: run.id,
      workerType: "SUPERVISOR",
      message: err.message,
      stack: err.stack,
      payload: { trigger },
    });
    await upsertWorkerHeartbeat({
      workerType: "SUPERVISOR",
      serviceName: "worker-supervisor",
      status: "degraded",
      currentTask: "error",
      metrics: { error: err.message },
    });
    throw error;
  }
};

const processNotification = async (payload: {
  category: string;
  severity: "info" | "warning" | "critical";
  title: string;
  body: string;
  dedupeKey: string;
  metadata: Record<string, unknown>;
}) => {
  // Guard against duplicate delivery using dedupeKey (@@unique in schema).
  // We use findFirst + create/update instead of upsert to avoid relying on the
  // compiled Prisma client type for the unique where clause before regeneration.
  const existing = await prisma.notification.findFirst({ where: { dedupeKey: payload.dedupeKey } });

  if (existing) {
    // Already delivered or suppressed — skip re-sending.
    if (existing.status === "SENT" || existing.status === "SUPPRESSED") {
      logger.info("Notification already handled, skipping delivery", { dedupeKey: payload.dedupeKey, status: existing.status });
      return;
    }
    // Bump retry count and fall through to re-attempt delivery.
    await prisma.notification.update({
      where: { id: existing.id },
      data: { retryCount: { increment: 1 }, lastAttemptAt: new Date() },
    });
  }

  const notification =
    existing ??
    (await prisma.notification.create({
      data: {
        category: payload.category,
        severity: payload.severity.toUpperCase() as "INFO" | "WARNING" | "CRITICAL",
        channel: "DISCORD",
        status: config.discordWebhookUrl ? "PENDING" : "SUPPRESSED",
        dedupeKey: payload.dedupeKey,
        title: payload.title,
        body: payload.body,
        payload: asJson(payload.metadata),
      },
    }));

  if (!config.discordWebhookUrl) {
    await prisma.notification.update({
      where: { id: notification.id },
      data: { status: "SUPPRESSED", errorMessage: "DISCORD_WEBHOOK_URL is not configured." },
    });
    return;
  }

  const response = await fetch(config.discordWebhookUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      content: `**${payload.title}**\n${payload.body}`,
    }),
  });

  await prisma.notification.update({
    where: { id: notification.id },
    data: {
      status: response.ok ? "SENT" : "FAILED",
      deliveredAt: response.ok ? new Date() : null,
      lastAttemptAt: new Date(),
      errorMessage: response.ok ? null : `Discord webhook failed with ${response.status}`,
    },
  });
};

setInterval(() => {
  void upsertWorkerHeartbeat({
    workerType: "SUPERVISOR",
    serviceName: "worker-supervisor",
    status: "healthy",
    currentTask: "monitoring",
  });
}, 15_000);

// Portfolio exposure snapshot — every 30s
setInterval(() => {
  void runPortfolioExposureSnapshot().catch((err) => {
    logger.warn("Portfolio exposure snapshot error", { error: (err as Error).message });
  });
}, 30_000);

// Post-trade reviewer — every 60s
setInterval(() => {
  void runPostTradeReviewer().catch((err) => {
    logger.warn("Post-trade reviewer error", { error: (err as Error).message });
  });
}, 60_000);

// Journal export sweeper — every 5 minutes
setInterval(() => {
  void runJournalExportSweeper().catch((err) => {
    logger.warn("Journal export sweeper error", { error: (err as Error).message });
  });
}, 5 * 60_000);

// Weekly synthesis — check every hour whether it's time to run (Sunday 22:00 UTC)
setInterval(() => {
  const now = new Date();
  const isSunday = now.getUTCDay() === 0;
  const isWeeklyHour = now.getUTCHours() === 22 && now.getUTCMinutes() < 5;
  if (isSunday && isWeeklyHour) {
    void runWeeklySynthesis().catch((err) => {
      logger.warn("Weekly synthesis error", { error: (err as Error).message });
    });
  }
}, 60 * 60_000);

void ensureDefaultSchedules().catch((error) => {
  logger.error("Failed to ensure schedules", { error: (error as Error).message });
});

createPlatformWorker<{ trigger: "health_check" | "daily_summary" | "manual" }>(
  queueNames.supervisor,
  "worker-supervisor",
  async (payload) => {
    await processSupervisorJob(payload.trigger);
  },
);

createPlatformWorker<{
  category: string;
  severity: "info" | "warning" | "critical";
  title: string;
  body: string;
  dedupeKey: string;
  metadata: Record<string, unknown>;
}>(queueNames.notifications, "worker-supervisor-notifications", async (payload) => {
  await processNotification(payload);
});

logger.info("Supervisor worker started");
