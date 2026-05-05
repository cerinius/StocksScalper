import type { AllocationDecisionRow } from "./allocate";
import type { CandidateContext } from "./types";
import { runOllamaPreTradeCritique } from "@stock-radar/ai";
import { prisma } from "@stock-radar/db";
import { createLogger } from "@stock-radar/logging";

const logger = createLogger("worker-execution-ai");

/**
 * Result of a single pre-trade AI critic pass. `ABSTAIN` is returned
 * when the AI is disabled, unreachable, or the model returns invalid
 * JSON. AI can ONLY reduce size — the worker ignores any widening or
 * other schema violations (enforced by @stock-radar/ai safety filter
 * in Phase E).
 */
export interface PretradeCriticResult {
  verdict: "APPROVE" | "APPROVE_WITH_REDUCTION" | "REJECT" | "ABSTAIN";
  reduceSizeMultiplier: number; // 0.25–1.0
  reasons: string[];
  rawResponse?: unknown;
  aiReviewId?: string | null;
}

export interface RunCriticInputs {
  candidateContext: CandidateContext;
  allocationRow: AllocationDecisionRow;
  aiEnabled: boolean;
}

/**
 * Phase-B stub: returns ABSTAIN so the deterministic engine fully
 * controls the decision. Phase E wires this to the Ollama JSON-schema
 * pre-trade critic. The contract here is frozen:
 *   - reduceSizeMultiplier ∈ [0.25, 1.0]
 *   - AI can only REDUCE — downstream `decide.ts` enforces min(1.0, x)
 *   - reasons are appended to the decision's reasoning log
 */
export const runPretradeCritic = async (
  inputs: RunCriticInputs,
): Promise<PretradeCriticResult> => {
  if (!inputs.aiEnabled) {
    return { verdict: "ABSTAIN", reduceSizeMultiplier: 1.0, reasons: ["AI critic disabled."] };
  }

  try {
    const critique = await runOllamaPreTradeCritique({
      candidate: inputs.candidateContext.candidate,
      validation: inputs.candidateContext.validation,
      account: {
        accountId: inputs.allocationRow.account.accountId,
        displayName: inputs.allocationRow.account.displayName,
        mode: inputs.allocationRow.account.mode,
        snapshot: inputs.allocationRow.account.snapshot,
        ruleProfile: inputs.allocationRow.account.ruleProfile,
        openPositions: inputs.allocationRow.account.openPositions.map((position) => ({
          symbol: position.symbol,
          direction: position.direction,
          exposurePct: position.exposurePct,
        })),
      },
      market: inputs.candidateContext.market,
    });

    const verdict = mapVerdict(critique.output.verdict);
    const reduceSizeMultiplier =
      critique.output.reduceSizeMultiplier ??
      (critique.output.verdict === "SUGGEST_REDUCE_SIZE" ? 0.5 : 1.0);

    const aiReviewId = await persistAiReview({
      candidateId: inputs.candidateContext.dbIds.candidateId,
      accountId: inputs.allocationRow.account.accountId,
      critique,
    });

    return {
      verdict,
      reduceSizeMultiplier: Math.min(1.0, Math.max(0.25, reduceSizeMultiplier)),
      reasons: [
        critique.output.summary,
        ...critique.output.concerns,
        ...critique.safetyFilterReasons,
      ].filter(Boolean),
      rawResponse: critique.rawResponse,
      aiReviewId,
    };
  } catch (error) {
    const message = (error as Error).message;
    logger.warn("Pre-trade AI critic unavailable; continuing with deterministic rules", { message });
    return {
      verdict: "ABSTAIN",
      reduceSizeMultiplier: 1.0,
      reasons: [`AI critic unavailable: ${message}`],
    };
  }
};

const mapVerdict = (verdict: string): PretradeCriticResult["verdict"] => {
  switch (verdict) {
    case "APPROVE":
      return "APPROVE";
    case "SUGGEST_REDUCE_SIZE":
    case "APPROVE_WITH_CAUTION":
    case "CONCERNED":
      return "APPROVE_WITH_REDUCTION";
    case "OBJECT":
      return "REJECT";
    default:
      return "ABSTAIN";
  }
};

const persistAiReview = async (inputs: {
  candidateId: string;
  accountId: string;
  critique: Awaited<ReturnType<typeof runOllamaPreTradeCritique>>;
}): Promise<string | null> => {
  const delegate = (prisma as unknown as {
    aiReview?: { create?: (args: unknown) => Promise<{ id: string }> };
  }).aiReview;

  if (!delegate?.create) return null;

  const created = await delegate.create({
    data: {
      kind: "PRE_TRADE_CRITIC",
      accountId: inputs.accountId,
      candidateId: inputs.candidateId,
      correlationId: `${inputs.candidateId}:${inputs.accountId}:${Date.now()}`,
      model: inputs.critique.model,
      promptVersion: inputs.critique.promptVersion,
      promptTokens: inputs.critique.promptTokens,
      responseTokens: inputs.critique.responseTokens,
      latencyMs: inputs.critique.latencyMs,
      contextDigest: inputs.critique.contextDigest,
      verdict: inputs.critique.output.verdict,
      confidence: inputs.critique.output.confidence,
      summary: inputs.critique.output.summary,
      concerns: inputs.critique.output.concerns,
      suggestions: inputs.critique.output.suggestions,
      structuredOutput: inputs.critique.output,
      safetyFiltered: inputs.critique.safetyFiltered,
      safetyFilterReasons: inputs.critique.safetyFilterReasons,
    },
  });

  return created.id;
};
