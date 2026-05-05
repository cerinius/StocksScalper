/**
 * Post-Trade Reviewer Job
 *
 * Runs every ~60s. Finds positions closed since the last review run,
 * calls Ollama for a structured debrief, and:
 *   1. Persists an AiReview(kind=POST_TRADE_JOURNAL) row
 *   2. Extracts AiLesson rows from the review output
 *   3. Queues a JournalExport row for Obsidian export
 *
 * Rate-limited: each position is reviewed exactly once.
 * Advisory only: no side effects on positions or orders.
 */

import { prisma } from "@stock-radar/db";
import { createLogger } from "@stock-radar/logging";
import { runOllamaPostTradeJournal, POST_TRADE_PROMPT_VERSION } from "@stock-radar/ai";
import { randomUUID } from "node:crypto";

const logger = createLogger("post-trade-reviewer");

// Only process positions closed in the last N ms per cycle (avoid processing ancient history at startup)
const LOOKBACK_MS = 24 * 60 * 60 * 1_000; // 24 hours

let lastRunAt: Date | null = null;

export const runPostTradeReviewer = async (): Promise<void> => {
  const now = new Date();
  const since = lastRunAt ?? new Date(now.getTime() - LOOKBACK_MS);
  lastRunAt = now;

  const aiEnabled = process.env.OLLAMA_ENABLED !== "false";
  if (!aiEnabled) {
    logger.debug("Post-trade reviewer skipped — OLLAMA_ENABLED=false");
    return;
  }

  // Find positions closed since last run that don't have a POST_TRADE_JOURNAL AiReview yet
  const closedPositions = await prisma.position.findMany({
    where: {
      status: "CLOSED",
      closedAt: { gte: since },
    },
    include: {
      symbol: true,
      account: { include: { currentPhase: true } },
      aiReviews: {
        where: { kind: "POST_TRADE_JOURNAL" as any },
        select: { id: true },
        take: 1,
      },
    },
    orderBy: { closedAt: "asc" },
    take: 20, // batch cap
  }) as any[];

  const unreviewed = closedPositions.filter((p: any) => p.aiReviews.length === 0);
  if (unreviewed.length === 0) {
    logger.debug("No unreviewed closed positions");
    return;
  }

  logger.info("Starting post-trade review batch", { count: unreviewed.length });
  let reviewed = 0;

  for (const pos of unreviewed) {
    try {
      // Load pre-trade AI review if it exists
      const preTradeReview = await (prisma as any).aiReview.findFirst({
        where: { positionId: pos.id, kind: "PRE_TRADE_CRITIC" },
        orderBy: { createdAt: "desc" },
        select: { verdict: true, summary: true, concerns: true, suggestions: true },
      });

      // Load associated validation run
      const candidateId = await getCandidateId(pos.id);
      const validationRun = candidateId
        ? await prisma.validationRun.findFirst({
            where: { candidateId, status: "PASSED" },
            select: { winRateEstimate: true, expectancy: true, finalValidationScore: true },
            orderBy: { createdAt: "desc" },
          }).catch(() => null)
        : null;

      // Load recent lessons for context
      const recentLessons = await (prisma as any).aiLesson.findMany({
        where: { accountId: pos.accountId, active: true },
        orderBy: { updatedAt: "desc" },
        take: 5,
        select: { title: true, detail: true, tags: true },
      });

      const direction = pos.direction === "LONG" ? "BUY" : "SELL";
      const durationMinutes = pos.closedAt && pos.openedAt
        ? Math.floor((new Date(pos.closedAt).getTime() - new Date(pos.openedAt).getTime()) / 60_000)
        : 0;
      const closeReason = typeof pos.metadata === "object" && pos.metadata !== null
        ? (pos.metadata as any).closeReason ?? null
        : null;

      const aiResult = await runOllamaPostTradeJournal({
        trade: {
          positionId: pos.id,
          symbol: pos.symbol.ticker,
          direction,
          strategy: typeof pos.metadata === "object" && pos.metadata !== null
            ? (pos.metadata as any).strategy ?? null
            : null,
          openPrice: pos.avgEntryPrice,
          closePrice: (pos.metadata as any)?.closePrice ?? pos.avgEntryPrice,
          volumeLots: pos.quantity ?? 0,
          openedAt: pos.openedAt?.toISOString() ?? "",
          closedAt: pos.closedAt?.toISOString() ?? "",
          durationMinutes,
          realizedPnl: pos.realizedPnl ?? 0,
          realizedPnlPct: pos.exposurePct ?? 0,
          stopLoss: pos.stopLoss,
          takeProfit: pos.takeProfit,
          closeReason,
          maxAdversePct: 0,
          maxFavourablePct: 0,
        },
        preTradeCritique: preTradeReview ? {
          verdict: preTradeReview.verdict,
          summary: preTradeReview.summary,
          concerns: Array.isArray(preTradeReview.concerns) ? preTradeReview.concerns : [],
          suggestions: Array.isArray(preTradeReview.suggestions) ? preTradeReview.suggestions : [],
        } : null,
        validationSummary: validationRun ? {
          winRatePct: validationRun.winRateEstimate ?? 50,
          expectancy: validationRun.expectancy ?? 0,
          sampleSize: 0,
          finalScore: validationRun.finalValidationScore ?? 50,
        } : null,
        account: {
          accountId: pos.accountId ?? "unknown",
          displayName: pos.account?.displayName ?? "Unknown",
          phase: pos.account?.currentPhase?.kind ?? "UNKNOWN",
          mode: pos.account?.tradingMode ?? "PAPER",
        },
        recentLessons: recentLessons.map((l: any) => ({ title: l.title, detail: l.detail })),
      });

      // Persist AiReview
      const correlationId = randomUUID();
      const review = await (prisma as any).aiReview.create({
        data: {
          kind: "POST_TRADE_JOURNAL",
          accountId: pos.accountId,
          positionId: pos.id,
          correlationId,
          model: aiResult.model,
          promptVersion: POST_TRADE_PROMPT_VERSION,
          promptTokens: aiResult.promptTokens,
          responseTokens: aiResult.responseTokens,
          latencyMs: aiResult.latencyMs,
          contextDigest: aiResult.contextDigest,
          verdict: "NEUTRAL",
          confidence: 50,
          summary: aiResult.output.summary,
          concerns: aiResult.output.whatWentPoorly,
          suggestions: aiResult.output.whatWentWell,
          structuredOutput: {
            whatWentWell: aiResult.output.whatWentWell,
            whatWentPoorly: aiResult.output.whatWentPoorly,
            lessons: aiResult.output.lessons,
            nextSetupsToWatch: aiResult.output.nextSetupsToWatch,
          },
          safetyFiltered: false,
          safetyFilterReasons: [],
        },
      });

      // Extract AiLesson rows
      for (const lesson of aiResult.output.lessons) {
        await (prisma as any).aiLesson.create({
          data: {
            sourceKind: "POST_TRADE",
            sourceId: pos.id,
            accountId: pos.accountId,
            title: lesson.title,
            detail: lesson.detail,
            tags: lesson.tags,
            weight: 0.5,
            active: true,
          },
        }).catch(() => {}); // Non-fatal if duplicate
      }

      // Queue JournalExport for Obsidian
      await (prisma as any).journalExport.upsert({
        where: { kind_entityId_bucket: { kind: "TRADE_NOTE", entityId: pos.id, bucket: "trade" } },
        create: {
          kind: "TRADE_NOTE",
          entityId: pos.id,
          bucket: "trade",
          accountId: pos.accountId,
          relativePath: `accounts/${pos.account?.displayName ?? "default"}/trades/${pos.closedAt?.toISOString().split("T")[0] ?? "unknown"}_${pos.symbol.ticker}_${pos.id.slice(-6)}.md`,
          contentHash: correlationId,
          status: "PENDING",
        },
        update: {
          status: "PENDING",
          contentHash: correlationId,
          attempts: 0,
          lastError: null,
        },
      }).catch(() => {});

      reviewed++;
      logger.info("Post-trade review complete", {
        positionId: pos.id,
        symbol: pos.symbol.ticker,
        lessons: aiResult.output.lessons.length,
        latencyMs: aiResult.latencyMs,
      });
    } catch (err) {
      logger.warn("Post-trade review failed", {
        positionId: pos.id,
        error: (err as Error).message,
      });
    }
  }

  logger.info("Post-trade reviewer batch complete", { reviewed, total: unreviewed.length });
};

/**
 * Look up the candidateId for a given position via its order.
 */
const getCandidateId = async (positionId: string): Promise<string | null> => {
  try {
    const pos = await prisma.position.findUnique({
      where: { id: positionId },
      include: { order: { include: { decision: { include: { candidate: true } } } } },
    });
    return (pos?.order as any)?.decision?.candidate?.id ?? null;
  } catch {
    return null;
  }
};
