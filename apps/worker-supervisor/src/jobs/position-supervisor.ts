/**
 * Position Supervisor Job
 *
 * Runs every supervisor cycle (15-20s). For each open position:
 *   1. Computes deterministic supervision (ATR trailing stop, drawdown gate, time-based tighten)
 *   2. Optionally calls Ollama for AI advisory review (max 1 call per position per 60s)
 *   3. Persists a PositionSupervisionTick + optional AiReview row
 *   4. Applies safe, deterministic actions (TIGHTEN_STOP, MOVE_TO_BREAKEVEN, SCALE_OUT, CLOSE)
 *
 * The AI is ADVISORY ONLY. The closing-guard ensures no AI action can increase risk.
 */

import { prisma } from "@stock-radar/db";
import { createLogger } from "@stock-radar/logging";
import { computeAtrTrailingStop } from "@stock-radar/core";
import { runOllamaPositionSupervisor, POSITION_PROMPT_VERSION } from "@stock-radar/ai";
import type { PriceBar } from "@stock-radar/types";
import { stableHash } from "@stock-radar/shared";
import { randomUUID } from "node:crypto";

const logger = createLogger("position-supervisor");

const AI_COOLDOWN_MS = 60_000; // max 1 AI call per position per 60s
const STALE_BRIDGE_MS = parseInt(process.env.BRIDGE_STALE_MS ?? "15000", 10);

interface OpenPosition {
  id: string;
  symbolId: string;
  accountId: string | null;
  direction: string;
  avgEntryPrice: number;
  stopLoss: number;
  takeProfit: number;
  unrealizedPnl: number;
  unrealizedPnlPct?: number;
  riskUsdAtEntry: number | null;
  currentRiskUsd: number | null;
  quantity?: number | null;
  brokerPositionId?: string | null;
  openedAt: Date;
  lastSupervisedAt: Date | null;
  metadata: unknown;
  symbol: { ticker: string };
  account: {
    id: string;
    displayName: string;
    tradingMode: string;
    currentPhase: { kind: string } | null;
  } | null;
}

/**
 * Compute how many minutes a position has been open.
 */
const minutesOpen = (openedAt: Date, now: Date) =>
  Math.floor((now.getTime() - openedAt.getTime()) / 60_000);

/**
 * Get the latest bridge snapshot for this account's integration.
 */
const getBridgeFreshness = async (accountId: string): Promise<boolean> => {
  try {
    const snap = await (prisma as any).bridgeHealthSnapshot.findFirst({
      where: { accountId },
      orderBy: { capturedAt: "desc" },
    });
    if (!snap) return false;
    const ageMs = Date.now() - new Date(snap.capturedAt).getTime();
    return ageMs < STALE_BRIDGE_MS && snap.terminalConnected && snap.brokerConnected;
  } catch {
    return false;
  }
};

/**
 * Deterministic supervision decision for a position.
 * Returns the suggested action and reason codes without side effects.
 */
const determineAction = (
  pos: OpenPosition,
  bars: PriceBar[],
  now: Date,
): {
  action: "HOLD" | "TIGHTEN_STOP" | "MOVE_TO_BREAKEVEN" | "SCALE_OUT" | "CLOSE";
  newStop: number | null;
  reasonCodes: string[];
  reasonSummary: string;
} => {
  const direction = pos.direction as "LONG" | "SHORT";
  const reasons: string[] = [];

  // 1. Account health gate — if the account snapshot shows critical drawdown, lean to close
  // (Actual bridge check is done before executing the action)

  // 2. ATR-based trailing stop
  let newStop: number | null = null;
  if (bars.length >= 10) {
    try {
      const trail = computeAtrTrailingStop(bars, direction, pos.stopLoss, pos.avgEntryPrice, 2.0);
      if (trail.moved) {
        const improved =
          direction === "LONG"
            ? trail.newStopLoss > pos.stopLoss
            : trail.newStopLoss < pos.stopLoss;
        if (improved) {
          newStop = trail.newStopLoss;
          reasons.push("ATR_TRAIL_MOVED");
        }
      }
    } catch {
      // Non-fatal — bars may be insufficient
    }
  }

  // 3. Move to breakeven if favourable excursion > 1.5× initial risk and stop still at loss
  const isBelowEntry = direction === "LONG"
    ? pos.stopLoss < pos.avgEntryPrice
    : pos.stopLoss > pos.avgEntryPrice;
  if (isBelowEntry && pos.unrealizedPnl > 0) {
    const excursionRatio =
      pos.riskUsdAtEntry && pos.riskUsdAtEntry > 0
        ? pos.unrealizedPnl / pos.riskUsdAtEntry
        : 0;
    if (excursionRatio >= 1.5) {
      newStop = pos.avgEntryPrice;
      reasons.push("MOVE_TO_BREAKEVEN_ELIGIBLE");
      return {
        action: "MOVE_TO_BREAKEVEN",
        newStop: pos.avgEntryPrice,
        reasonCodes: reasons,
        reasonSummary: `Position at ${excursionRatio.toFixed(1)}R — moving stop to breakeven.`,
      };
    }
  }

  // 4. Time-based tighten: if open > 4h with no favourable excursion, tighten to 75% of current risk
  const timeOpen = minutesOpen(pos.openedAt, now);
  if (timeOpen > 240 && pos.unrealizedPnl < 0 && newStop === null && bars.length >= 5) {
    // Tighten stop by moving it 25% toward entry (reduces risk without closing)
    const entryToStop = Math.abs(pos.avgEntryPrice - pos.stopLoss);
    const tightenedDistance = entryToStop * 0.75;
    const tightenedStop = direction === "LONG"
      ? pos.avgEntryPrice - tightenedDistance
      : pos.avgEntryPrice + tightenedDistance;
    // Only tighten if it improves (moves stop toward entry)
    const improves = direction === "LONG"
      ? tightenedStop > pos.stopLoss
      : tightenedStop < pos.stopLoss;
    if (improves) {
      newStop = tightenedStop;
      reasons.push("TIME_BASED_TIGHTEN");
    }
  }

  if (newStop !== null) {
    return {
      action: "TIGHTEN_STOP",
      newStop,
      reasonCodes: reasons,
      reasonSummary: `Stop tightened to ${newStop.toFixed(5)} (${reasons.join(", ")}).`,
    };
  }

  return {
    action: "HOLD",
    newStop: null,
    reasonCodes: ["HOLD_NO_ACTION"],
    reasonSummary: "No supervision action warranted.",
  };
};

/**
 * Apply the supervision action via the MT5 adapter.
 * Returns true if the adapter call succeeded or was not needed.
 */
const applyAction = async (
  pos: OpenPosition,
  action: "HOLD" | "TIGHTEN_STOP" | "MOVE_TO_BREAKEVEN" | "SCALE_OUT" | "CLOSE",
  newStop: number | null,
  mt5AdapterUrl: string,
): Promise<{ applied: boolean; error?: string }> => {
  if (action === "HOLD") return { applied: false };

  if ((action === "TIGHTEN_STOP" || action === "MOVE_TO_BREAKEVEN") && newStop !== null) {
    try {
      const resp = await fetch(`${mt5AdapterUrl}/positions/${pos.id}/modify`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ stopLoss: newStop }),
        signal: AbortSignal.timeout(5_000),
      });
      if (resp.ok) {
        await prisma.position.update({
          where: { id: pos.id },
          data: { stopLoss: newStop },
        });
        return { applied: true };
      }
      return { applied: false, error: `Adapter returned ${resp.status}` };
    } catch (err) {
      return { applied: false, error: (err as Error).message };
    }
  }

  if (action === "CLOSE") {
    try {
      const resp = await fetch(
        `${mt5AdapterUrl}/positions/${pos.brokerPositionId ?? pos.id}/close`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "X-Command-Id": `supervision-close-${pos.id}-${Date.now()}`,
          },
          body: JSON.stringify({ reason: "SUPERVISION_CLOSE" }),
          signal: AbortSignal.timeout(8_000),
        },
      );
      return { applied: resp.ok, error: resp.ok ? undefined : `Adapter returned ${resp.status}` };
    } catch (err) {
      return { applied: false, error: (err as Error).message };
    }
  }

  return { applied: false };
};

export const runPositionSupervisor = async (mt5AdapterUrl: string): Promise<void> => {
  const now = new Date();

  const openPositions = await prisma.position.findMany({
    where: { status: "OPEN" },
    include: {
      symbol: true,
      account: {
        include: { currentPhase: true },
      },
    },
  }) as unknown as OpenPosition[];

  if (openPositions.length === 0) return;

  let processed = 0;
  let aiCalls = 0;

  for (const pos of openPositions) {
    try {
      // Fetch recent bars for ATR computation
      const bars = await prisma.priceBar.findMany({
        where: { symbolId: pos.symbolId, timeframe: "15m" },
        orderBy: { timestamp: "asc" },
        take: 30,
        select: { open: true, high: true, low: true, close: true, volume: true, timestamp: true },
      });
      const priceBars: PriceBar[] = bars.map((b: any) => ({
        symbol: pos.symbolId,
        timeframe: "15m",
        timestamp: b.timestamp.toISOString(),
        open: b.open,
        high: b.high,
        low: b.low,
        close: b.close,
        volume: b.volume,
      }));

      // Deterministic supervision decision
      const { action, newStop, reasonCodes, reasonSummary } = determineAction(pos, priceBars, now);

      // AI advisory review (rate-limited per position per 60s)
      let aiReviewId: string | null = null;
      let aiVerdict: string | null = null;
      let aiReasoning: string | null = null;
      const aiEnabled = process.env.OLLAMA_ENABLED !== "false";

      const lastSupervised = pos.lastSupervisedAt ? pos.lastSupervisedAt.getTime() : 0;
      const shouldCallAi = aiEnabled && (now.getTime() - lastSupervised >= AI_COOLDOWN_MS);

      if (shouldCallAi) {
        try {
          const lastBar = priceBars[priceBars.length - 1];
          const currentPrice = lastBar?.close ?? pos.avgEntryPrice;

          const aiResult = await runOllamaPositionSupervisor({
            position: {
              positionId: pos.id,
              symbol: pos.symbol.ticker,
              direction: pos.direction as "BUY" | "SELL",
              openPrice: pos.avgEntryPrice,
              currentPrice,
              stopLoss: pos.stopLoss,
              takeProfit: pos.takeProfit,
              volumeLots: pos.quantity ?? 0,
              unrealizedPnl: pos.unrealizedPnl ?? 0,
              unrealizedPnlPct: pos.unrealizedPnlPct ?? 0,
              maxAdversePct: 0, // TODO: compute from tick history
              openedAt: pos.openedAt.toISOString(),
              timeInTradeMinutes: minutesOpen(pos.openedAt, now),
              strategy: typeof pos.metadata === "object" && pos.metadata !== null
                ? (pos.metadata as any).strategy ?? null
                : null,
            },
            account: {
              accountId: pos.accountId ?? "unknown",
              displayName: pos.account?.displayName ?? "Unknown",
              phase: pos.account?.currentPhase?.kind ?? "UNKNOWN",
              mode: pos.account?.tradingMode ?? "PAPER",
              distanceToDailyDdPct: 5, // TODO: pull from latest account snapshot
              distanceToTotalDdPct: 10,
              openPositionCount: openPositions.length,
            },
            market: {
              recentBarsSummary: priceBars.slice(-5).map(b => `H:${b.high.toFixed(5)} L:${b.low.toFixed(5)} C:${b.close.toFixed(5)}`).join(" | "),
              regime: null,
              spreadPct: null,
              newsHeadlines: [],
            },
            preTradeRationale: null,
          });

          const correlationId = randomUUID();
          const aiReview = await (prisma as any).aiReview.create({
            data: {
              kind: "POSITION_SUPERVISOR",
              accountId: pos.accountId,
              positionId: pos.id,
              correlationId,
              model: aiResult.model,
              promptVersion: POSITION_PROMPT_VERSION,
              promptTokens: aiResult.promptTokens,
              responseTokens: aiResult.responseTokens,
              latencyMs: aiResult.latencyMs,
              contextDigest: aiResult.contextDigest,
              verdict: aiResult.output.verdict,
              confidence: aiResult.output.confidence,
              summary: aiResult.output.summary,
              concerns: aiResult.output.concerns,
              suggestions: aiResult.output.observations,
              structuredOutput: {
                suggestedAction: aiResult.output.suggestedAction,
                suggestedStop: aiResult.output.suggestedStop,
                suggestedScaleOutPct: aiResult.output.suggestedScaleOutPct,
              },
              safetyFiltered: aiResult.safetyFiltered,
              safetyFilterReasons: aiResult.safetyFilterReasons,
            },
          });

          aiReviewId = aiReview.id;
          aiVerdict = aiResult.output.verdict;
          aiReasoning = aiResult.output.summary;
          aiCalls++;
        } catch (err) {
          logger.warn("AI position review failed — falling back to deterministic", {
            positionId: pos.id,
            error: (err as Error).message,
          });
        }
      }

      // Bridge safety gate — don't execute changes if bridge is stale
      const bridgeFresh = pos.accountId
        ? await getBridgeFreshness(pos.accountId)
        : false;

      // Persist supervision tick
      const tickHash = stableHash(`${pos.id}:${action}:${newStop}:${now.toISOString()}`);
      await (prisma as any).positionSupervisionTick.create({
        data: {
          positionId: pos.id,
          accountId: pos.accountId ?? "unknown",
          asOf: now,
          unrealizedPnlPct: (pos as any).unrealizedPnlPct ?? 0,
          adversePct: 0,
          timeInTradeMinutes: minutesOpen(pos.openedAt, now),
          invalidationTriggered: action === "CLOSE",
          suggestedAction: action,
          origin: aiVerdict ? "AI_SUGGESTED" : "DETERMINISTIC",
          reasonCodes,
          reasonSummary,
          aiReviewId,
          aiAdvisoryVerdict: aiVerdict,
          aiAdvisoryReasoning: aiReasoning,
          executed: false,
          executedAt: null,
        },
      });

      // Apply the action if bridge is fresh
      if (action !== "HOLD" && bridgeFresh) {
        const { applied, error } = await applyAction(pos, action, newStop, mt5AdapterUrl);
        if (applied) {
          await (prisma as any).positionSupervisionTick.updateMany({
            where: { positionId: pos.id, asOf: now },
            data: { executed: true, executedAt: now },
          });
          logger.info("Supervision action applied", {
            positionId: pos.id,
            symbol: pos.symbol.ticker,
            action,
            newStop,
          });
        } else if (error) {
          logger.warn("Supervision action failed", { positionId: pos.id, action, error });
        }
      } else if (action !== "HOLD" && !bridgeFresh) {
        logger.warn("Supervision action skipped — bridge stale", {
          positionId: pos.id,
          action,
          accountId: pos.accountId,
        });
      }

      // Update lastSupervisedAt on the position
      await prisma.position.update({
        where: { id: pos.id },
        data: { lastSupervisedAt: now },
      });

      processed++;
    } catch (err) {
      logger.warn("Position supervision failed", {
        positionId: pos.id,
        error: (err as Error).message,
      });
    }
  }

  logger.info("Position supervisor cycle complete", { processed, aiCalls, total: openPositions.length });
};
