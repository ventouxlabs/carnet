import { describe, expect, it } from "vitest";

import { parentSegment, subdirForUri } from "./noteSubdirs";

describe("parentSegment", () => {
  it("returns the immediate parent path segment", () => {
    expect(parentSegment("file:///v/Ideas/a.md")).toBe("Ideas");
    expect(parentSegment("file:///storage/Journal/carnet/Ideas/note.md")).toBe("Ideas");
  });

  it("returns undefined when there's no parent segment", () => {
    expect(parentSegment("a.md")).toBeUndefined();
  });

  it("decodes a percent-encoded SAF uri before splitting", () => {
    const saf =
      "content://com.android.externalstorage.documents/tree/primary%3ACarnet/document/primary%3ACarnet%2FJournal%2F2026-05-16.md";
    expect(parentSegment(saf)).toBe("Journal");
  });

  it("falls back to the raw uri when decoding throws", () => {
    // A lone "%" is not valid percent-encoding and throws in decodeURIComponent.
    expect(parentSegment("file:///v/Ideas/100%.md")).toBe("Ideas");
  });
});

describe("subdirForUri", () => {
  it("reads the subdir from the uri, including Notes", () => {
    expect(subdirForUri("file:///v/Notes/a.md")).toBe("Notes");
    expect(subdirForUri("file:///v/Ideas/a.md")).toBe("Ideas");
    expect(subdirForUri("file:///v/Journal/2026-09-07.md")).toBe("Journal");
    expect(subdirForUri("file:///v/People/x.md")).toBe("People");
  });

  it("returns null for a uri outside the known subdirs", () => {
    expect(subdirForUri("file:///v/Photos/a.png")).toBeNull();
    expect(subdirForUri("file:///v/loose.md")).toBeNull();
  });

  it("decodes a percent-encoded SAF uri", () => {
    expect(subdirForUri("content://x/tree/primary%3Av%2FNotes%2Fa.md")).toBe("Notes");
  });
});
