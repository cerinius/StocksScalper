import { z } from "zod";

/**
 * All AI review / critic kinds. Each of these maps to a distinct
 * Ollama prompt and JSON schema. AI output is ALWAYS advisory — the
 * deterministic engine remains the authority.
 */
export const aiReviewKinds = [
  "PRE_TRADE_CRITIC",
  "POSITION_SUPERVISOR",
  "POST_TRADE_JOURNAL",
  "WEEKLY_REVIEW",
  "NATURAL_LANGUAGE_QUERY",
  "NEWS_REVIEW",
  "RULE_DRIFT_REVIEW",
  "SETUP_QUALITY_REVIEW",
] as const;
export type AiReviewKind = (typeof aiReviewKinds)[number];

/**
 * Advisory verdict values. Carefully scoped — AI cannot emit "BLOCK",
 * "FORCE_CLOSE", "OVERRIDE" etc. These are reserved for the
 * deterministic engine.
 */
export const aiVerdicts = [
  "APPROVE",
  "APPROVE_WITH_CAUTION",
  "SUGGEST_REDUCE_SIZE",
  "SUGGEST_TIGHTEN_STOP",
  "SUGGEST_SCALE_OUT",
  "SUGGEST_CLOSE",
  "NEUTRAL",
  "CONCERNED",
  "OBJECT",
  "NO_ACTION",
] as const;
export type AiVerdict = (typeof aiVerdicts)[number];

/**
 * AI call audit record. Captures the prompt, response, latency, and
 * any structured fields extracted by the caller. One row per AI call.
 */
export const aiReviewSchema = z.object({
  id: z.string().optional(),
  kind: z.enum(aiReviewKinds),
  accountId: z.string().nullable(),
  candidateId: z.string().nullable(),
  decisionId: z.string().nullable(),
  positionId: z.string().nullable(),
  correlationId: z.string(),
  model: z.string(), // e.g. "qwen2.5:7b"
  promptVersion: z.string(), // e.g. "pretrade-critic@1.2.0"
  promptTokens: z.number().int().nonnegative(),
  responseTokens: z.number().int().nonnegative(),
  latencyMs: z.number().int().nonnegative(),
  contextDigest: z.string(), // sha256 of context sent (for replay/dedupe)
  rawPromptRef: z.string().nullable(), // optional blob ref for debug
  rawResponseRef: z.string().nullable(),
  verdict: z.enum(aiVerdicts),
  confidence: z.number().min(0).max(100),
  summary: z.string(),
  concerns: z.array(z.string()).default([]),
  suggestions: z.array(z.string()).default([]),
  structuredOutput: z.record(z.unknown()).nullable(),
  safetyFiltered: z.boolean().default(false),
  safetyFilterReasons: z.array(z.string()).default([]),
  createdAt: z.string(),
});
export type AiReviewRecord = z.infer<typeof aiReviewSchema>;

/**
 * Structured output expected back from the pre-trade critic prompt.
 * Constrained so the engine can ingest it safely.
 */
export const preTradeCriticOutputSchema = z.object({
  verdict: z.enum(aiVerdicts),
  confidence: z.number().min(0).max(100),
  summary: z.string().min(1).max(500).default("No summary returned."),
  concerns: z.array(z.string().max(300)).max(10).default([]),
  suggestions: z.array(z.string().max(300)).max(10).default([]),
  reduceSizeMultiplier: z.number().min(0.25).max(1.0).nullable().default(null), // bounded: AI can only reduce
  tightenStopTo: z.number().nullable().default(null), // price suggestion (not enforced)
  requestedClarifications: z.array(z.string().max(200)).max(5).default([]),
});
export type PreTradeCriticOutput = z.infer<typeof preTradeCriticOutputSchema>;

/**
 * Structured output expected back from the position supervisor prompt.
 */
export const positionSupervisorOutputSchema = z.object({
  verdict: z.enum(aiVerdicts),
  confidence: z.number().min(0).max(100),
  summary: z.string().min(1).max(500),
  concerns: z.array(z.string().max(300)).max(10).default([]),
  // advisory: these are suggestions only. Engine still decides.
  suggestedAction: z.enum([
    "HOLD",
    "TIGHTEN_STOP",
    "MOVE_TO_BREAKEVEN",
    "SCALE_OUT",
    "CLOSE",
    "NO_ACTION",
  ]),
  suggestedStop: z.number().nullable(),
  suggestedScaleOutPct: z.number().min(0).max(1).nullable(),
  observations: z.array(z.string().max(300)).max(10).default([]),
});
export type PositionSupervisorOutput = z.infer<typeof positionSupervisorOutputSchema>;

/**
 * Structured output expected back from the post-trade journal prompt.
 */
export const postTradeJournalOutputSchema = z.object({
  summary: z.string().min(1).max(1000),
  whatWentWell: z.array(z.string().max(300)).max(10).default([]),
  whatWentPoorly: z.array(z.string().max(300)).max(10).default([]),
  lessons: z.array(
    z.object({
      title: z.string().min(1).max(200),
      detail: z.string().min(1).max(500),
      tags: z.array(z.string()).max(10).default([]),
    }),
  ),
  nextSetupsToWatch: z.array(z.string().max(200)).max(10).default([]),
});
export type PostTradeJournalOutput = z.infer<typeof postTradeJournalOutputSchema>;

/**
 * Structured output expected back from the weekly review prompt.
 */
export const weeklyReviewOutputSchema = z.object({
  summary: z.string().min(1).max(2000),
  topWins: z.array(z.string().max(300)).max(10).default([]),
  topLosses: z.array(z.string().max(300)).max(10).default([]),
  repeatingMistakes: z.array(z.string().max(300)).max(10).default([]),
  setupsWorking: z.array(z.string().max(200)).max(10).default([]),
  setupsFailing: z.array(z.string().max(200)).max(10).default([]),
  ruleAdherenceNotes: z.array(z.string().max(300)).max(10).default([]),
  recommendations: z.array(z.string().max(300)).max(10).default([]),
});
export type WeeklyReviewOutput = z.infer<typeof weeklyReviewOutputSchema>;

/**
 * Natural-language query answer. Purely read-only; AI can reference
 * data but cannot cause side effects.
 */
export const naturalLanguageQueryOutputSchema = z.object({
  answer: z.string().min(1).max(4000),
  sources: z.array(
    z.object({
      type: z.enum(["candidate", "decision", "position", "order", "account", "news", "worker"]),
      id: z.string(),
      label: z.string(),
    }),
  ),
  caveats: z.array(z.string().max(300)).max(5).default([]),
});
export type NaturalLanguageQueryOutput = z.infer<typeof naturalLanguageQueryOutputSchema>;

/**
 * AI "lesson" extracted from post-trade/weekly review — persisted as
 * first-class records so they can be replayed into future prompts.
 */
export const aiLessonSchema = z.object({
  id: z.string().optional(),
  sourceKind: z.enum(["POST_TRADE", "WEEKLY", "MANUAL", "BACKTEST"]),
  sourceId: z.string().nullable(),
  accountId: z.string().nullable(),
  title: z.string().min(1),
  detail: z.string().min(1),
  tags: z.array(z.string()).default([]),
  weight: z.number().min(0).max(1).default(0.5),
  active: z.boolean().default(true),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type AiLessonRecord = z.infer<typeof aiLessonSchema>;

/**
 * Weekly review aggregate (stored record).
 */
export const weeklyReviewSchema = z.object({
  id: z.string().optional(),
  accountId: z.string().nullable(), // null = portfolio-wide
  weekStart: z.string(), // Monday UTC
  weekEnd: z.string(),
  kpis: z.record(z.number()).default({}),
  output: weeklyReviewOutputSchema,
  aiReviewId: z.string(),
  obsidianNoteRef: z.string().nullable(),
  createdAt: z.string(),
});
export type WeeklyReviewRecord = z.infer<typeof weeklyReviewSchema>;

/**
 * Bounded safety invariants enforced BEFORE any AI output is ingested.
 * These are hard guarantees: the deterministic engine checks each one
 * and strips/rejects disallowed suggestions.
 */
export const aiSafetyInvariants = {
  // An AI suggestion can ONLY reduce size, never increase it.
  maxReduceSizeMultiplier: 1.0,
  minReduceSizeMultiplier: 0.25,
  // An AI suggestion to tighten a stop MUST result in a tighter stop
  // (never wider). Deterministic check applied per-direction.
  allowStopWidening: false,
  // AI cannot propose removing a stop.
  allowStopRemoval: false,
  // AI cannot propose opening new positions (only engine can).
  allowPositionOpen: false,
  // AI cannot override hard kill switches.
  allowKillSwitchOverride: false,
  // AI cannot override phase rules.
  allowPhaseRuleOverride: false,
  // AI cannot force-close a position (only deterministic breach logic can).
  allowForceClose: false,
} as const;
export type AiSafetyInvariants = typeof aiSafetyInvariants;
