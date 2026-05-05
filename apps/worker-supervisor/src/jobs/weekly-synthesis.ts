/**
 * Weekly Synthesis Job
 *
 * Runs Sunday 22:00 UTC (cron-triggered). For each active account:
 *   1. Aggregates the week's trading KPIs from closed positions + account snapshots
 *   2. Calls Ollama for a structured weekly review
 *   3. Persists a WeeklyReview row + AiReview + AiLesson rows
 *   4. Queues JournalExport for Obsidian
 *
 * Advisory only. No side effects on positions or orders.
 */

import { prisma } from "@stock-radar/db";
import { createLogger } from "@stock-radar/logging";
import { runOllamaWeeklyReview, WEEKLY_REVIEW_PROMPT_VERSION } from "@stock-radar/ai";
import { randomUUID } from "node:crypto";

const logger = createLogger("weekly-synthesis");

const getWeekBounds = (): { weekStart: string; weekEnd: string; startDate: Date; endDate: Date } => {
  const now = new Date();
  // Week ending at previous Sunday midnight
  const dayOfWeek = now.getUTCDay(); // 0 = Sunday
  const daysSinceSunday = dayOfWeek === 0 ? 7 : dayOfWeek;
  const weekEnd = new Date(now);
  weekEnd.setUTCDate(now.getUTCDate() - dayOfWeek + 7);
  weekEnd.setUTCHours(22, 0, 0, 0);

  const weekStart = new Date(weekEnd);
  weekStart.setUTCDate(weekEnd.getUTCDate() - 7);

  return {
    weekStart: weekStart.toISOString().split("T")[0],
    weekEnd: weekEnd.toISOString().split("T")[0],
    startDate: weekStart,
    endDate: weekEnd,
  };
};

export const runWeeklySynthesis = async (): Promise<void> => {
  const aiEnabled = process.env.OLLAMA_ENABLED !== "false";
  if (!aiEnabled) {
    logger.debug("Weekly synthesis skipped — OLLAMA_ENABLED=false");
    return;
  }

  const { weekStart, weekEnd, startDate, endDate } = getWeekBounds();
  logger.info("Starting weekly synthesis", { weekStart, weekEnd });

  // Process per-account and portfolio-wide
  const accounts = await (prisma as any).account.findMany({
    where: { isActive: true },
    include: {
      currentPhase: true,
      snapshots: {
        where: { capturedAt: { gte: startDate, lte: endDate } },
        orderBy: { capturedAt: "asc" },
        take: 1,
        select: { balance: true, equity: true },
      },
    },
    take: 20,
  });

  // Also run a portfolio-wide synthesis
  const accountsToProcess: Array<any | null> = [...accounts, null];

  for (const account of accountsToProcess) {
    try {
      const accountId = account?.id ?? null;
      const accountLabel = account?.label ?? "portfolio";

      // Skip if already reviewed this week
      const existing = await (prisma as any).weeklyReview.findUnique({
        where: { accountId_weekStart: { accountId: accountId ?? "", weekStart } },
      }).catch(() => null);

      if (existing) {
        logger.debug("Weekly review already exists", { accountId, weekStart });
        continue;
      }

      // Aggregate closed positions this week
      const closedPositions = await prisma.position.findMany({
        where: {
          status: "CLOSED",
          closedAt: { gte: startDate, lte: endDate },
          ...(accountId ? { accountId } : {}),
        },
        include: {
          symbol: true,
          aiReviews: {
            where: { kind: "POST_TRADE_JOURNAL" as any },
            select: { summary: true },
            take: 1,
          },
        },
      }) as any[];

      if (closedPositions.length === 0 && account !== null) {
        logger.debug("No closed positions this week", { accountId });
        continue;
      }

      // Compute KPIs
      const wins = closedPositions.filter((p: any) => p.realizedPnl > 0);
      const losses = closedPositions.filter((p: any) => p.realizedPnl <= 0);
      const totalPnl = closedPositions.reduce((s: number, p: any) => s + (p.realizedPnl ?? 0), 0);
      const winRatePct = closedPositions.length > 0 ? (wins.length / closedPositions.length) * 100 : 0;
      const avgRR = closedPositions.length > 0
        ? closedPositions.reduce((s: number, p: any) => s + (p.riskUsdAtEntry && p.riskUsdAtEntry > 0 ? (p.realizedPnl ?? 0) / p.riskUsdAtEntry : 0), 0) / closedPositions.length
        : 0;
      const largestWin = wins.length > 0 ? Math.max(...wins.map((p: any) => p.realizedPnl)) : 0;
      const largestLoss = losses.length > 0 ? Math.min(...losses.map((p: any) => p.realizedPnl)) : 0;
      const startingEquity = account?.snapshots?.[0]?.equity ?? account?.initialBalance ?? 0;
      const totalPnlPct = startingEquity > 0 ? (totalPnl / startingEquity) * 100 : 0;
      const tradingDays = new Set(
        closedPositions.map((p: any) => p.closedAt?.toISOString()?.split("T")[0]).filter(Boolean),
      ).size;

      const kpis = {
        totalTrades: closedPositions.length,
        wins: wins.length,
        losses: losses.length,
        winRatePct,
        totalPnl,
        totalPnlPct,
        avgRR,
        largestWin,
        largestLoss,
        maxDrawdownPct: 0, // TODO: compute from snapshots
        tradesPerDay: tradingDays > 0 ? closedPositions.length / tradingDays : 0,
      };

      // Build trade digests
      const tradeDigests = closedPositions.map((p: any) => ({
        symbol: p.symbol?.ticker ?? "?",
        direction: p.direction,
        strategy: typeof p.metadata === "object" && p.metadata ? (p.metadata as any).strategy ?? null : null,
        realizedPnlPct: p.exposurePct ?? 0,
        durationMinutes: p.closedAt && p.openedAt
          ? Math.floor((new Date(p.closedAt).getTime() - new Date(p.openedAt).getTime()) / 60_000)
          : 0,
        closeReason: typeof p.metadata === "object" && p.metadata ? (p.metadata as any).closeReason ?? null : null,
        postTradeJournalSummary: p.aiReviews?.[0]?.summary ?? null,
      }));

      // Load rule violations this week
      const violations = await (prisma as any).ruleViolation.findMany({
        where: {
          ...(accountId ? { accountId } : {}),
          createdAt: { gte: startDate, lte: endDate },
        },
        select: { ruleCode: true, severity: true, message: true },
        take: 20,
      }).catch(() => []);

      // Load recent lessons
      const recentLessons = await (prisma as any).aiLesson.findMany({
        where: { ...(accountId ? { accountId } : {}), active: true },
        orderBy: { updatedAt: "desc" },
        take: 10,
        select: { title: true, detail: true, tags: true },
      }).catch(() => []);

      // Call Ollama
      const aiResult = await runOllamaWeeklyReview({
        weekStart,
        weekEnd,
        account: account ? {
          accountId: account.id,
          displayName: account.label,
          phase: account.currentPhase?.kind ?? "UNKNOWN",
          initialBalance: account.initialBalance,
          startingEquity,
          endingEquity: startingEquity + totalPnl,
        } : null,
        kpis,
        tradeDigests,
        activeRuleViolations: violations.map((v: any) => ({
          ruleCode: v.ruleCode,
          severity: v.severity,
          message: v.message,
        })),
        recentLessons: recentLessons.map((l: any) => ({
          title: l.title,
          detail: l.detail,
          tags: Array.isArray(l.tags) ? l.tags : [],
        })),
      });

      const correlationId = randomUUID();

      // Persist AiReview
      const aiReview = await (prisma as any).aiReview.create({
        data: {
          kind: "WEEKLY_REVIEW",
          accountId,
          correlationId,
          model: aiResult.model,
          promptVersion: WEEKLY_REVIEW_PROMPT_VERSION,
          promptTokens: aiResult.promptTokens,
          responseTokens: aiResult.responseTokens,
          latencyMs: aiResult.latencyMs,
          contextDigest: aiResult.contextDigest,
          verdict: "NEUTRAL",
          confidence: 70,
          summary: aiResult.output.summary,
          concerns: aiResult.output.repeatingMistakes,
          suggestions: aiResult.output.recommendations,
          structuredOutput: aiResult.output,
          safetyFiltered: false,
          safetyFilterReasons: [],
        },
      });

      // Persist WeeklyReview (upsert since account+weekStart is unique)
      await (prisma as any).weeklyReview.upsert({
        where: { accountId_weekStart: { accountId: accountId ?? "", weekStart } },
        create: {
          accountId,
          weekStart,
          weekEnd,
          kpis,
          output: aiResult.output,
          aiReviewId: aiReview.id,
          obsidianNoteRef: null,
        },
        update: {
          kpis,
          output: aiResult.output,
          aiReviewId: aiReview.id,
        },
      });

      // Extract AiLesson rows from recommendations
      for (const rec of aiResult.output.recommendations) {
        await (prisma as any).aiLesson.create({
          data: {
            sourceKind: "WEEKLY",
            sourceId: aiReview.id,
            accountId,
            title: rec.slice(0, 200),
            detail: rec,
            tags: ["weekly"],
            weight: 0.6,
            active: true,
          },
        }).catch(() => {});
      }

      // Queue JournalExport
      const entityId = `${accountId ?? "portfolio"}-${weekStart}`;
      await (prisma as any).journalExport.upsert({
        where: { kind_entityId_bucket: { kind: "WEEKLY_REVIEW", entityId, bucket: "weekly" } },
        create: {
          kind: "WEEKLY_REVIEW",
          entityId,
          bucket: "weekly",
          accountId,
          relativePath: `accounts/${accountLabel}/weekly/${weekStart}.md`,
          contentHash: correlationId,
          status: "PENDING",
        },
        update: { status: "PENDING", contentHash: correlationId, attempts: 0, lastError: null },
      }).catch(() => {});

      logger.info("Weekly synthesis complete", {
        accountId,
        weekStart,
        totalTrades: kpis.totalTrades,
        latencyMs: aiResult.latencyMs,
      });
    } catch (err) {
      logger.warn("Weekly synthesis failed for account", {
        accountId: account?.id ?? "portfolio",
        error: (err as Error).message,
      });
    }
  }
};
