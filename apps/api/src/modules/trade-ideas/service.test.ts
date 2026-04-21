import { describe, expect, it } from "vitest";
import { normaliseStatusFilter } from "./service";

describe("normaliseStatusFilter", () => {
  it("accepts lowercase status strings and coerces them to canonical enum values", () => {
    expect(normaliseStatusFilter("new")).toEqual(["NEW"]);
    expect(normaliseStatusFilter("New")).toEqual(["NEW"]);
    expect(normaliseStatusFilter("new,validated")).toEqual(["NEW", "VALIDATED"]);
  });

  it("drops unknown values silently so a bad filter never hides every row", () => {
    expect(normaliseStatusFilter("banana")).toBeUndefined();
    expect(normaliseStatusFilter("new,banana")).toEqual(["NEW"]);
  });

  it("returns undefined when the filter is missing, so all statuses are shown", () => {
    expect(normaliseStatusFilter(undefined)).toBeUndefined();
  });

  it("accepts arrays", () => {
    expect(normaliseStatusFilter(["new", "VALIDATED"])).toEqual(["NEW", "VALIDATED"]);
  });
});
