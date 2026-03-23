import { describe, expect, it } from "vitest";
import { parseLimit, parseOffset } from "./http";

describe("http parsing helpers", () => {
  it("clamps limits and offsets safely", () => {
    expect(parseLimit("999", 25, 100)).toBe(100);
    expect(parseLimit("abc", 25, 100)).toBe(25);
    expect(parseOffset("-5", 0)).toBe(0);
    expect(parseOffset("12", 0)).toBe(12);
  });
});
