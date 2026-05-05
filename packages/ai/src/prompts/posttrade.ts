import { postTradeJournalOutputSchema } from "@stock-radar/types";
import type { PostTradeJournalOutput } from "@stock-radar/types";
import { OllamaClient } from "../client";

export const POST_TRADE_PROMPT_VERSION = "post-trade-journal@1.0.0";

export interface PostTradeJournalInputs {
  trade: {
    positionId: string;
    symbol: string;
    direction: "BUY" | "SELL";
    strategy: string | null;
    openPrice: number;
    closePrice: number;
    volumeLots: number;
    openedAt: string;
    closedAt: string;
    durationMinutes: number;
    realizedPnl: number;
    realizedPnlPct: number;
    stopLoss: number | null;
    takeProfit: number | null;
    closeReason: string | null; // e.g. "TAKE_PROFIT", "STOP_LOSS", "MANUAL", "TIGHTEN_STOP"
    maxAdversePct: number;       // max adverse excursion while open
    maxFavourablePct: number;    // max favourable excursion while open
  };
  preTradeCritique: {
    verdict: string;
    summary: string;
    concerns: string[];
    suggestions: string[];
  } | null;
  validationSummary: {
    winRatePct: number;
    expectancy: number;
    sampleSize: number;
    finalScore: number;
  } | null;
  account: {
    accountId: string;
    displayName: string;
    phase: string;
    mode: string;
  };
  recentLessons: Array<{
    title: string;
    detail: string;
  }>;
}

/**
 * Run the post-trade journal AI review. This generates a structured
 * debrief that is persisted as an AiReview row and optionally exported
 * to the Obsidian vault. It also proposes lessons to be extracted as
 * AiLesson records for future trade critique context.
 */
export const runOllamaPostTradeJournal = async (
  inputs: PostTradeJournalInputs,
  client = new OllamaClient(),
) => {
  const result = await client.generateJson({
    schema: postTradeJournalOutputSchema,
    system: [
      "You are a trading journal analyst reviewing a completed funded-account trade.",
      "Your goal is honest debrief, not rationalisation. Focus on process, not outcome.",
      "Extract actionable lessons. Be specific. Return compact JSON matching the schema.",
    ].join(" "),
    prompt: buildPrompt(inputs),
    timeoutMs: Number(process.env.OLLAMA_POST_TRADE_TIMEOUT_MS ?? 8_000),
    temperature: 0.3,
  });

  return {
    ...result,
    output: result.output as PostTradeJournalOutput,
    promptVersion: POST_TRADE_PROMPT_VERSION,
  };
};

const buildPrompt = (inputs: PostTradeJournalInputs) => JSON.stringify({
  task: "Write a structured post-trade debrief. Identify what went well, what went poorly, and extract concrete lessons.",
  requiredShape: {
    summary: "1-2 paragraph overall assessment of the trade",
    whatWentWell: "string[] — process strengths (entry timing, stop placement, thesis adherence)",
    whatWentPoorly: "string[] — process weaknesses (early exit, wide stop, oversize, thesis drift)",
    lessons: "Array<{title, detail, tags}> — 1-3 actionable lessons, not outcome-based platitudes",
    nextSetupsToWatch: "string[] — specific follow-up setups or regimes to monitor",
  },
  trade: inputs.trade,
  preTradeCritique: inputs.preTradeCritique,
  validationSummary: inputs.validationSummary,
  account: inputs.account,
  recentLessons: inputs.recentLessons.slice(0, 5), // last 5 lessons for context
});
