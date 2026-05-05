import type { AccountSnapshotExtended, AccountRuleProfile, PreTradeCriticOutput, TradeCandidateRecord, ValidationMetrics } from "@stock-radar/types";
import { preTradeCriticOutputSchema } from "@stock-radar/types";
import { getAIRouter } from "../router";
import { filterPreTradeCritique } from "../safety";

export interface PreTradeCritiqueInputs {
  candidate: TradeCandidateRecord;
  validation: ValidationMetrics | null;
  account: {
    accountId: string;
    displayName: string;
    mode: string;
    snapshot: AccountSnapshotExtended;
    ruleProfile: AccountRuleProfile;
    openPositions: Array<{ symbol: string; direction: string; exposurePct?: number | null }>;
  };
  market: {
    spreadPct: number | null;
    correlatedExposurePct: number;
    correlatedSymbols: string[];
  };
}

export const PRETRADE_PROMPT_VERSION = "pretrade-critic@1.0.0";

export const runOllamaPreTradeCritique = async (
  inputs: PreTradeCritiqueInputs,
) => {
  const router = getAIRouter();
  const result = await router.generateJson({
    schema: preTradeCriticOutputSchema,
    system: [
      "You are a conservative funded-trading risk critic.",
      "You are advisory only. You cannot approve rule breaches or increase trade size.",
      "Return compact JSON only. Prefer ABSTAIN-like neutral feedback when evidence is weak.",
    ].join(" "),
    prompt: buildPrompt(inputs),
    // Use AI_PRETRADE_TIMEOUT_MS for cloud providers (they need more time).
    // Falls back to legacy OLLAMA_PRETRADE_TIMEOUT_MS for backward compat.
    timeoutMs: Number(
      process.env.AI_PRETRADE_TIMEOUT_MS ??
      process.env.OLLAMA_PRETRADE_TIMEOUT_MS ??
      20_000,
    ),
    temperature: 0.2,
  }, "pretrade");

  const filtered = filterPreTradeCritique(result.output as PreTradeCriticOutput);
  return {
    ...result,
    output: filtered.output,
    safetyFiltered: filtered.safetyFiltered,
    safetyFilterReasons: filtered.safetyFilterReasons,
    promptVersion: PRETRADE_PROMPT_VERSION,
  };
};

const buildPrompt = (inputs: PreTradeCritiqueInputs) => JSON.stringify({
  task: "Review this possible trade for hidden risk, contradictions, and whether size should be reduced.",
  requiredShape: {
    verdict: "APPROVE | APPROVE_WITH_CAUTION | SUGGEST_REDUCE_SIZE | CONCERNED | OBJECT | NEUTRAL",
    confidence: "0-100",
    summary: "one short paragraph",
    concerns: "string[]",
    suggestions: "string[]",
    reduceSizeMultiplier: "number 0.25-1.0 or null; never above 1",
    tightenStopTo: "number or null",
    requestedClarifications: "string[]",
  },
  constraints: [
    "Do not suggest increasing size.",
    "Do not suggest bypassing kill switches, bridge gates, phase rules, or daily drawdown limits.",
    "If uncertain, choose NEUTRAL or CONCERNED and explain the risk.",
  ],
  context: inputs,
});

