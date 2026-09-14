import { describe, expect, it } from "vitest";
import { parseCardClassification } from "./cardClassification";

describe("parseCardClassification", () => {
  it("accepts only the three approved classifier outcomes", () => {
    expect(parseCardClassification("card")).toBe("card");
    expect(parseCardClassification("NOT-CARD")).toBe("not-card");
    expect(parseCardClassification(" uncertain ")).toBe("uncertain");
  });

  it("fails closed to uncertain for prose, JSON, and malformed output", () => {
    for (const output of ["This appears to be a card", '{"kind":"card"}', "", "receipt"]) {
      expect(parseCardClassification(output)).toBe("uncertain");
    }
  });
});
