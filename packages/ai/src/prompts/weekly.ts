import { weeklyReviewOutputSchema } from "@stock-radar/types";
import type { WeeklyReviewOutput } from "@stock-radar/types";
import { OllamaClient } from "../client";

export const WEEKLY_REVIEW_PROMPT_VERSION = "weekly-review@1.0.0";

export interface WeeklyReviewInputs {
  weekStart: string;  // Monday UTC ISO string
  weekEnd: string;    // Sunday UTC ISO string
  account: {
    accountId: string;
    displayName: string;
    phase: string;
    initialBalance: number;
    startingEquity: number;
    endingEquity: number;
  } | null; // null = portfolio-wide review across all accounts
  kpis: {
    totalTrades: number;
    wins: number;
    losses: number;
    winRatePct: number;
    totalPnl: number;
    totalPnlPct: number;
    avgRR: number;
    largestWin: number;
    largestLoss: number;
    maxDrawdownPct: number;
    tradesPerDay: number;
  };
  tradeDigests: Array<{
    symbol: string;
    direction: string;
    strategy: string | null;
    realizedPnlPct: number;
    durationMinutes: number;
    closeReason: string | null;
    postTradeJournalSummary: string | null;
  }>;
  activeRuleViolations: Array<{
    ruleCode: string;
    severity: string;
    message: string;
  }>;
  recentLessons: Array<{
    title: string;
    detail: string;
    tags: string[];
  }>;
}

/**
 * Run the weekly synthesis AI review. This generates a structured
 * end-of-week debrief across all trades for an account (or portfolio-wide).
 * Results are persisted as a WeeklyReview record and AiLesson rows.
 */
export const runOllamaWeeklyReview = async (
  inputs: WeeklyReviewInputs,
  client = new OllamaClient(),
) => {
  const result = await client.generateJson({
    schema: weeklyReviewOutputSchema,
    system: [
      "You are a performance analyst reviewing a week of funded-account trading.",
      "Identify patterns in wins vs losses. Surface repeating mistakes brutally honestly.",
      "Praise disciplined process even on losing trades. Criticise outcome-chasing on winners.",
      "Be specific about setups, symbols, and regimes. Return compact JSON.",
    ].join(" "),
    prompt: buildPrompt(inputs),
    timeoutMs: Number(process.env.OLLAMA_WEEKLY_TIMEOUT_MS ?? 12_000),
    temperature: 0.35,
  });

  return {
    ...result,
    output: result.output as WeeklyReviewOutput,
    promptVersion: WEEKLY_REVIEW_PROMPT_VERSION,
  };
};

const buildPrompt = (inputs: WeeklyReviewInputs) => JSON.stringify({
  task: "Write a structured weekly trading debrief. Identify winning setups, repeating mistakes, and 2-3 concrete recommendations for next week.",
  requiredShape: {
    summary: "2-3 paragraph honest overview of the week",
    topWins: "string[] — what drove the best trades this week",
    topLosses: "string[] — what drove the worst trades this week",
    repeatingMistakes: "string[] — mistakes appearing more than once this week",
    setupsWorking: "string[] — setup types / regimes with positive edge this week",
    setupsFailing: "string[] — setup types / regimes to avoid next week",
    ruleAdherenceNotes: "string[] — observations on rule adherence (phase rules, drawdown, size)",
    recommendations: "string[] — 2-3 specific, actionable changes for next week",
  },
  week: { start: inputs.weekStart, end: inputs.weekEnd },
  account: inputs.account,
  kpis: inputs.kpis,
  tradeDigests: inputs.tradeDigests,
  activeRuleViolations: inputs.activeRuleViolations,
  recentLessons: inputs.recentLessons.slice(0, 10),
});
