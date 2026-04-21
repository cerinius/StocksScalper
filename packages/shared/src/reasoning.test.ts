import { describe, expect, it } from "vitest";
import {
  DECISION_CODES,
  buildDecisionRecord,
  describeObservation,
  getReasonCatalogEntry,
  listReasonCatalog,
  renderDecisionLine,
} from "./reasoning";

describe("reason catalog", () => {
  it("exposes every DECISION_CODES value as a catalog entry", () => {
    for (const code of Object.values(DECISION_CODES)) {
      const entry = getReasonCatalogEntry(code);
      expect(entry, `missing catalog entry for ${code}`).not.toBeNull();
      expect(entry!.title.length).toBeGreaterThan(0);
      expect(entry!.summary.length).toBeGreaterThan(0);
    }
  });

  it("never leaves internal debug jargon in a user-facing summary", () => {
    for (const entry of listReasonCatalog()) {
      if (entry.userFacing) {
        expect(entry.summary).not.toMatch(/TODO|FIXME|undefined|null|NaN/);
      }
    }
  });
});

describe("buildDecisionRecord", () => {
  it("produces a structured record that references the code's title and summary", () => {
    const record = buildDecisionRecord(DECISION_CODES.VALIDATION_FAILED_SCORE, {
      symbol: "BTCUSD",
      strategy: "mean-reversion",
      timeframe: "1h",
      observed: { score: 59.7, sampleSize: 14 },
      expected: { score: 65, sampleSize: 30 },
    });

    expect(record.code).toBe(DECISION_CODES.VALIDATION_FAILED_SCORE);
    expect(record.title).toBe("Validation score too low");
    expect(record.explanation).toContain("Historical analogs were not convincing");
    expect(record.explanation).toContain("score 59.70 (needed 65)");
    expect(record.category).toBe("validation");
    expect(record.severity).toBe("warning");
    expect(record.symbol).toBe("BTCUSD");
    expect(record.timeframe).toBe("1h");
  });

  it("lets callers override the title with a more specific, user-friendly version", () => {
    const record = buildDecisionRecord(DECISION_CODES.VALIDATION_PASSED, {
      title: "Validation passed for BTCUSD with 14 real analogs",
      symbol: "BTCUSD",
    });
    expect(record.title).toBe("Validation passed for BTCUSD with 14 real analogs");
  });

  it("throws on an unknown decision code", () => {
    expect(() => buildDecisionRecord("idea.mystery" as never)).toThrow();
  });
});

describe("describeObservation", () => {
  it("produces a readable sentence with both observed and expected values", () => {
    const sentence = describeObservation({ score: 59.7, sample: 14 }, { score: 65, sample: 30 });
    expect(sentence).toBe("score 59.70 (needed 65); sample 14 (needed 30)");
  });

  it("handles missing expected values", () => {
    expect(describeObservation({ score: 59.7 }, undefined)).toBe("score 59.70");
  });
});

describe("renderDecisionLine", () => {
  it("combines title, context, and observation into a single audit-ready line", () => {
    const record = buildDecisionRecord(DECISION_CODES.VALIDATION_FAILED_SCORE, {
      symbol: "BTCUSD",
      timeframe: "1h",
      strategy: "mean-reversion",
      observed: { score: 59.7 },
      expected: { score: 65 },
    });
    expect(renderDecisionLine(record)).toBe(
      "Validation score too low — BTCUSD · 1h · mean-reversion. score 59.70 (needed 65).",
    );
  });
});
