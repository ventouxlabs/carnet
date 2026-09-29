import { describe, expect, it } from "vitest";

import { isSaveFirstTextMode, saveFirstModeOf } from "./saveFirstRouting";

describe("isSaveFirstTextMode", () => {
  it("is true for the two text modes written raw first and enriched in place", () => {
    expect(isSaveFirstTextMode("idea")).toBe(true);
    expect(isSaveFirstTextMode("note")).toBe(true);
  });

  it("is false for every other capture mode", () => {
    for (const mode of ["journal", "person", "photo", "audio"] as const) {
      expect(isSaveFirstTextMode(mode)).toBe(false);
    }
  });
});

describe("saveFirstModeOf", () => {
  it("reads the input's mode", () => {
    expect(saveFirstModeOf({ mode: "note" })).toBe("note");
    expect(saveFirstModeOf({ mode: "idea" })).toBe("idea");
  });

  it("treats a missing mode as idea — every pre-Note caller builds its input without one", () => {
    expect(saveFirstModeOf({})).toBe("idea");
  });
});
