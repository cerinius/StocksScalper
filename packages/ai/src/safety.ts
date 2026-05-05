import type { PreTradeCriticOutput, PositionSupervisorOutput } from "@stock-radar/types";
import { aiSafetyInvariants } from "@stock-radar/types";

export interface SafetyResult<T> {
  output: T;
  safetyFiltered: boolean;
  safetyFilterReasons: string[];
}

/**
 * Regexes that detect an AI trying to push a rule-breaking suggestion.
 * Any suggestion/concern string matching one of these is stripped and a
 * safety-filter reason is recorded. The engine will never act on these
 * strings anyway (the flow only reads `verdict` + `reduceSizeMultiplier`),
 * but this keeps the audit trail clean and flags prompt regressions.
 */
const DANGEROUS_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\b(overrid\w*|bypass\w*|disabl\w*|ignor\w*)\b.*\b(kill\s*switch|daily\s*loss|risk\s*rule|phase\s*rule|bridge\s*gate|rule)\b/i, reason: "AI attempted to override a deterministic rule." },
  { pattern: /\b(widen\w*|loosen\w*|move\s*back)\b.*\b(stop|sl)\b/i, reason: "AI attempted to widen a stop (not permitted)." },
  { pattern: /\b(remov\w*|delet\w*|drop\w*|cancel\w*)\b.*\b(stop|sl)\b/i, reason: "AI attempted to remove a stop (not permitted)." },
  { pattern: /\b(increas\w*|add\s*to|scal\w*\s*up|doubl\w*|triple\w*)\b.*\b(size|position|risk|exposure|lot\w*)\b/i, reason: "AI attempted to increase size (not permitted)." },
  { pattern: /\b(forc\w*|manual\w*)\b.*\b(clos\w*|exit\w*)\b/i, reason: "AI attempted to force-close a position (engine only)." },
  { pattern: /\b(open\w*|enter\w*|add\w*)\b.*\bnew\b.*\b(position|trade|order|hedg\w*)\b/i, reason: "AI attempted to propose opening a new position (engine only)." },
];

const { maxReduceSizeMultiplier: MAX_REDUCE, minReduceSizeMultiplier: MIN_REDUCE } = aiSafetyInvariants;

/**
 * Enforce every runtime-checkable `aiSafetyInvariants` on a pre-trade
 * critic output BEFORE it reaches the deterministic engine.
 *
 * What this does NOT enforce (and must be enforced downstream in
 * `flow/decide.ts`):
 *  - stop widening (requires trade direction + proposed stop)
 *  - phase-rule / kill-switch respect (the engine is the sole
 *    authority; an AI `APPROVE` cannot unblock a deterministic block)
 *  - position opening (the engine decides what to open; AI only
 *    critiques a candidate that the engine has already shortlisted)
 */
export const filterPreTradeCritique = (
  output: PreTradeCriticOutput,
): SafetyResult<PreTradeCriticOutput> => {
  const reasons: string[] = [];

  // 1) Size multiplier — defense-in-depth. Zod already clamps to
  //    [0.25, 1.0] at schema parse time, but if the schema is ever
  //    loosened we still enforce the invariant here.
  let reduceSizeMultiplier = output.reduceSizeMultiplier;
  if (reduceSizeMultiplier != null && Number.isFinite(reduceSizeMultiplier)) {
    if (reduceSizeMultiplier > MAX_REDUCE) {
      reduceSizeMultiplier = MAX_REDUCE;
      reasons.push(`AI attempted to increase size (>${MAX_REDUCE}); clamped to ${MAX_REDUCE}.`);
    }
    if (reduceSizeMultiplier < MIN_REDUCE) {
      reduceSizeMultiplier = MIN_REDUCE;
      reasons.push(`AI attempted to reduce below floor (<${MIN_REDUCE}); clamped to ${MIN_REDUCE}.`);
    }
  } else {
    reduceSizeMultiplier = null;
  }

  // 2) Confidence — clamp to [0, 100]. Also coerce verdict to NEUTRAL
  //    if confidence is trivially low so downstream weighting is sane.
  let confidence = output.confidence;
  if (!Number.isFinite(confidence)) {
    confidence = 0;
    reasons.push("AI returned non-numeric confidence; coerced to 0.");
  }
  if (confidence < 0) {
    confidence = 0;
    reasons.push("AI returned negative confidence; clamped to 0.");
  }
  if (confidence > 100) {
    confidence = 100;
    reasons.push("AI returned confidence >100; clamped to 100.");
  }

  // 3) tightenStopTo — must be a positive price or null. The flow layer
  //    doesn't act on this yet (stop tightening is engine-decided), but
  //    we null out invalid values so downstream code can trust the type.
  let tightenStopTo = output.tightenStopTo;
  if (tightenStopTo != null && (!Number.isFinite(tightenStopTo) || tightenStopTo <= 0)) {
    tightenStopTo = null;
    reasons.push("AI returned invalid tightenStopTo (<=0 or non-finite); dropped.");
  }

  // 4) Scrub rule-breaking language from concerns / suggestions. The
  //    deterministic engine ignores these fields operationally, but we
  //    still strip them so the audit trail + Obsidian journal don't
  //    preserve noise that could mislead a human reviewer.
  const scrubbedConcerns = scrubStrings(output.concerns, reasons);
  const scrubbedSuggestions = scrubStrings(output.suggestions, reasons);

  const deduped = Array.from(new Set(reasons));

  return {
    output: {
      ...output,
      reduceSizeMultiplier,
      confidence,
      tightenStopTo,
      concerns: scrubbedConcerns,
      suggestions: scrubbedSuggestions,
    },
    safetyFiltered: deduped.length > 0,
    safetyFilterReasons: deduped,
  };
};

/**
 * Safety filter for position supervisor output.
 * Strips any suggestion that attempts to widen stops, open new positions, or override rules.
 * Clamps suggestedScaleOutPct to [0, 1].
 */
export const scrubSupervisorOutput = (
  output: PositionSupervisorOutput,
): SafetyResult<PositionSupervisorOutput> => {
  const reasons: string[] = [];

  // Clamp scale-out pct
  let suggestedScaleOutPct = output.suggestedScaleOutPct;
  if (suggestedScaleOutPct != null) {
    if (!Number.isFinite(suggestedScaleOutPct) || suggestedScaleOutPct < 0) {
      suggestedScaleOutPct = null;
      reasons.push("AI returned invalid suggestedScaleOutPct; dropped.");
    } else if (suggestedScaleOutPct > 1) {
      suggestedScaleOutPct = 1;
      reasons.push("AI returned suggestedScaleOutPct > 1; clamped to 1.");
    }
  }

  // suggestedStop must be positive (actual direction validation happens in the supervisor)
  let suggestedStop = output.suggestedStop;
  if (suggestedStop != null && (!Number.isFinite(suggestedStop) || suggestedStop <= 0)) {
    suggestedStop = null;
    reasons.push("AI returned invalid suggestedStop (<=0 or non-finite); dropped.");
  }

  // Clamp confidence
  let confidence = output.confidence;
  if (!Number.isFinite(confidence)) { confidence = 0; reasons.push("Non-finite confidence coerced to 0."); }
  if (confidence < 0) { confidence = 0; }
  if (confidence > 100) { confidence = 100; }

  const scrubbedConcerns = scrubStrings(output.concerns, reasons);
  const scrubbedObservations = scrubStrings(output.observations, reasons);

  const deduped = Array.from(new Set(reasons));
  return {
    output: {
      ...output,
      confidence,
      suggestedStop,
      suggestedScaleOutPct,
      concerns: scrubbedConcerns,
      observations: scrubbedObservations,
    },
    safetyFiltered: deduped.length > 0,
    safetyFilterReasons: deduped,
  };
};

const scrubStrings = (values: string[], reasons: string[]): string[] => {
  const kept: string[] = [];
  for (const raw of values) {
    const value = typeof raw === "string" ? raw.trim() : "";
    if (!value) continue;
    const hit = DANGEROUS_PATTERNS.find((p) => p.pattern.test(value));
    if (hit) {
      reasons.push(hit.reason);
      continue;
    }
    kept.push(value);
  }
  return kept;
};
