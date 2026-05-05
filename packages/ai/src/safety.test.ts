import { describe, expect, it } from "vitest";
import type { PreTradeCriticOutput } from "@stock-radar/types";
import { filterPreTradeCritique } from "./safety";

const baseOutput: PreTradeCriticOutput = {
  verdict: "APPROVE",
  confidence: 50,
  summary: "Reasonable setup with average confluence.",
  concerns: [],
  suggestions: [],
  reduceSizeMultiplier: 1.0,
  tightenStopTo: null,
  requestedClarifications: [],
};

describe("filterPreTradeCritique", () => {
  it("passes clean output through unchanged", () => {
    const result = filterPreTradeCritique({
      ...baseOutput,
      concerns: ["Spread is elevated."],
      suggestions: ["Wait for pullback."],
    });
    expect(result.safetyFiltered).toBe(false);
    expect(result.safetyFilterReasons).toEqual([]);
    expect(result.output.concerns).toEqual(["Spread is elevated."]);
    expect(result.output.suggestions).toEqual(["Wait for pullback."]);
  });

  it("clamps reduceSizeMultiplier above 1.0 down to 1.0", () => {
    const result = filterPreTradeCritique({ ...baseOutput, reduceSizeMultiplier: 1.5 });
    expect(result.output.reduceSizeMultiplier).toBe(1.0);
    expect(result.safetyFiltered).toBe(true);
    expect(result.safetyFilterReasons.join(" ")).toMatch(/clamped to 1/);
  });

  it("clamps reduceSizeMultiplier below 0.25 up to 0.25", () => {
    const result = filterPreTradeCritique({ ...baseOutput, reduceSizeMultiplier: 0.1 });
    expect(result.output.reduceSizeMultiplier).toBe(0.25);
    expect(result.safetyFiltered).toBe(true);
    expect(result.safetyFilterReasons.join(" ")).toMatch(/clamped to 0.25/);
  });

  it("nulls out non-finite reduceSizeMultiplier", () => {
    const result = filterPreTradeCritique({
      ...baseOutput,
      reduceSizeMultiplier: Number.NaN as unknown as number,
    });
    expect(result.output.reduceSizeMultiplier).toBeNull();
  });

  it("clamps confidence outside [0,100]", () => {
    const hi = filterPreTradeCritique({ ...baseOutput, confidence: 150 });
    expect(hi.output.confidence).toBe(100);
    expect(hi.safetyFiltered).toBe(true);

    const lo = filterPreTradeCritique({ ...baseOutput, confidence: -5 });
    expect(lo.output.confidence).toBe(0);
    expect(lo.safetyFiltered).toBe(true);
  });

  it("drops invalid tightenStopTo (<=0 or non-finite)", () => {
    const zero = filterPreTradeCritique({ ...baseOutput, tightenStopTo: 0 });
    expect(zero.output.tightenStopTo).toBeNull();
    expect(zero.safetyFiltered).toBe(true);

    const neg = filterPreTradeCritique({ ...baseOutput, tightenStopTo: -1 });
    expect(neg.output.tightenStopTo).toBeNull();
    expect(neg.safetyFiltered).toBe(true);
  });

  it("preserves a valid positive tightenStopTo", () => {
    const result = filterPreTradeCritique({ ...baseOutput, tightenStopTo: 105.25 });
    expect(result.output.tightenStopTo).toBe(105.25);
    expect(result.safetyFiltered).toBe(false);
  });

  it("strips rule-breaking suggestions about stops", () => {
    const result = filterPreTradeCritique({
      ...baseOutput,
      suggestions: [
        "Widen the stop to give it more room.",
        "Remove the stop loss and hold through drawdown.",
        "Tighten stop to break-even.", // benign
      ],
    });
    expect(result.safetyFiltered).toBe(true);
    expect(result.output.suggestions).toEqual(["Tighten stop to break-even."]);
    expect(result.safetyFilterReasons.join(" ")).toMatch(/widen a stop/i);
    expect(result.safetyFilterReasons.join(" ")).toMatch(/remove a stop/i);
  });

  it("strips suggestions about increasing size", () => {
    const result = filterPreTradeCritique({
      ...baseOutput,
      suggestions: ["Consider doubling the position size if it moves favorably."],
    });
    expect(result.safetyFiltered).toBe(true);
    expect(result.output.suggestions).toEqual([]);
    expect(result.safetyFilterReasons.join(" ")).toMatch(/increase size/i);
  });

  it("strips override-kill-switch suggestions", () => {
    const result = filterPreTradeCritique({
      ...baseOutput,
      concerns: ["Consider overriding the daily loss rule this one time."],
    });
    expect(result.safetyFiltered).toBe(true);
    expect(result.output.concerns).toEqual([]);
    expect(result.safetyFilterReasons.join(" ")).toMatch(/override a deterministic rule/i);
  });

  it("strips force-close suggestions", () => {
    const result = filterPreTradeCritique({
      ...baseOutput,
      suggestions: ["Force close all correlated positions immediately."],
    });
    expect(result.safetyFiltered).toBe(true);
    expect(result.output.suggestions).toEqual([]);
    expect(result.safetyFilterReasons.join(" ")).toMatch(/force-close/i);
  });

  it("strips new-position suggestions", () => {
    const result = filterPreTradeCritique({
      ...baseOutput,
      suggestions: ["Open a new hedging position in the opposite direction."],
    });
    expect(result.safetyFiltered).toBe(true);
    expect(result.output.suggestions).toEqual([]);
    expect(result.safetyFilterReasons.join(" ")).toMatch(/opening a new position/i);
  });

  it("deduplicates repeated reasons", () => {
    const result = filterPreTradeCritique({
      ...baseOutput,
      suggestions: ["Widen the stop.", "Widen the stop a touch."],
    });
    const widenReasons = result.safetyFilterReasons.filter((r) => /widen a stop/i.test(r));
    expect(widenReasons.length).toBe(1);
  });

  it("drops empty / non-string entries", () => {
    const result = filterPreTradeCritique({
      ...baseOutput,
      suggestions: ["  ", "", "Real tip about entry timing."],
    });
    expect(result.output.suggestions).toEqual(["Real tip about entry timing."]);
    expect(result.safetyFiltered).toBe(false);
  });
});
