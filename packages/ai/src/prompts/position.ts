import { z } from "zod";
import { positionSupervisorOutputSchema } from "@stock-radar/types";
import type { PositionSupervisorOutput } from "@stock-radar/types";
import { OllamaClient } from "../client";
import { scrubSupervisorOutput } from "../safety";

export const POSITION_PROMPT_VERSION = "position-supervisor@1.0.0";

export interface PositionSupervisorInputs {
  position: {
    positionId: string;
    symbol: string;
    direction: "BUY" | "SELL";
    openPrice: number;
    currentPrice: number;
    stopLoss: number | null;
    takeProfit: number | null;
    volumeLots: number;
    unrealizedPnl: number;
    unrealizedPnlPct: number;
    maxAdversePct: number; // max adverse excursion since open
    openedAt: string;
    timeInTradeMinutes: number;
    strategy: string | null;
  };
  account: {
    accountId: string;
    displayName: string;
    phase: string;
    mode: string;
    distanceToDailyDdPct: number;
    distanceToTotalDdPct: number;
    openPositionCount: number;
  };
  market: {
    recentBarsSummary: string; // e.g. "Last 5 bars: H/L/C sequence, direction"
    regime: string | null;     // e.g. "TRENDING_UP", "RANGING", "HIGH_VOLATILITY"
    spreadPct: number | null;
    newsHeadlines: string[];   // max 3, most recent
  };
  preTradeRationale: string | null; // reasoning log digest from when trade was placed
}

/**
 * Run the position supervisor AI critique. This is ADVISORY ONLY.
 * The deterministic supervisor loop decides what action to actually take.
 * The AI may suggest HOLD, TIGHTEN_STOP, MOVE_TO_BREAKEVEN, SCALE_OUT, or CLOSE.
 * It may never suggest force-closing, opening new positions, or widening stops.
 */
export const runOllamaPositionSupervisor = async (
  inputs: PositionSupervisorInputs,
  client = new OllamaClient(),
) => {
  const result = await client.generateJson({
    schema: positionSupervisorOutputSchema,
    system: [
      "You are a conservative position supervisor for a funded trading account.",
      "Your role is advisory only. You cannot open new positions, override kill switches, or widen stops.",
      "Focus on capital preservation. Default to HOLD unless there is clear invalidation evidence.",
      "Return compact JSON matching the required schema.",
    ].join(" "),
    prompt: buildPrompt(inputs),
    timeoutMs: Number(process.env.OLLAMA_POSITION_TIMEOUT_MS ?? 4_000),
    temperature: 0.1, // Lower temperature for position management
  });

  const filtered = scrubSupervisorOutput(result.output as PositionSupervisorOutput);
  return {
    ...result,
    output: filtered.output,
    safetyFiltered: filtered.safetyFiltered,
    safetyFilterReasons: filtered.safetyFilterReasons,
    promptVersion: POSITION_PROMPT_VERSION,
  };
};

const buildPrompt = (inputs: PositionSupervisorInputs) => JSON.stringify({
  task: "Review this open position and advise whether to hold, tighten stop, scale out, or close. Default to HOLD if uncertain.",
  requiredShape: {
    verdict: "APPROVE | APPROVE_WITH_CAUTION | SUGGEST_TIGHTEN_STOP | SUGGEST_SCALE_OUT | SUGGEST_CLOSE | NEUTRAL | CONCERNED | NO_ACTION",
    confidence: "0-100",
    summary: "one short paragraph on the current thesis health",
    concerns: "string[] — reasons to be cautious about the position",
    suggestedAction: "HOLD | TIGHTEN_STOP | MOVE_TO_BREAKEVEN | SCALE_OUT | CLOSE | NO_ACTION",
    suggestedStop: "price number or null — only tighter than current, never wider",
    suggestedScaleOutPct: "0.0-1.0 or null — fraction to close if SCALE_OUT",
    observations: "string[] — factual observations about price behaviour, regime, or invalidation triggers",
  },
  constraints: [
    "You may ONLY suggest tightening or moving a stop to breakeven. Never suggest widening it.",
    "You may NOT suggest opening new positions or adding to the position.",
    "You may NOT override kill switches, phase rules, or bridge gates.",
    "Default to NO_ACTION or HOLD unless the trade thesis is clearly invalid.",
    "If distanceToDailyDdPct < 1.0 or distanceToTotalDdPct < 1.5, lean toward CLOSE.",
  ],
  position: inputs.position,
  account: inputs.account,
  market: inputs.market,
  preTradeRationale: inputs.preTradeRationale ?? "Not available.",
});
