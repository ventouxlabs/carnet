import { describe, expect, it } from "vitest";

import { buildSaveFirstRetryPayload, isSaveFirstTextMode, saveFirstModeOf, usesSaveFirst } from "./saveFirstRouting";

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

describe("usesSaveFirst", () => {
  it("keeps Idea's opt-in blocking preview", () => {
    expect(usesSaveFirst(false, "idea")).toBe(true);
    expect(usesSaveFirst(true, "idea")).toBe(false);
  });

  it("always saves a Note first — 'Preview ideas before saving' gates ideas only", () => {
    expect(usesSaveFirst(false, "note")).toBe(true);
    expect(usesSaveFirst(true, "note")).toBe(true);
  });
});

describe("buildSaveFirstRetryPayload", () => {
  const retry = {
    filepath: "file:///v/Notes/errands.md",
    baselineMtime: 7,
    baselineContent: "RAW",
    vaultContext: { profileId: "work", rootUri: "file:///work" },
  };

  it("queues a note as a note row, so the drain uses the note prompt", () => {
    expect(
      buildSaveFirstRetryPayload({ mode: "note", text: "- [ ] call the dentist", tags: ["errands"] }, retry),
    ).toEqual({
      mode: "note",
      text: "- [ ] call the dentist",
      tags: ["errands"],
      filepath: "file:///v/Notes/errands.md",
      baselineMtime: 7,
      baselineContent: "RAW",
      vaultContext: { profileId: "work", rootUri: "file:///work" },
    });
  });

  it("queues an input with no mode as an idea row (pre-Note callers)", () => {
    expect(buildSaveFirstRetryPayload({ text: "kite", tags: [] }, retry).mode).toBe("idea");
  });
});
