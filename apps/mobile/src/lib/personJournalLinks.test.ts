import { describe, expect, it, vi } from "vitest";

import { findPersonJournalMatches } from "./personJournalLinks";
import type { NoteIndexEntry } from "./vault";

function journal(uri: string, createdOrDate = 0): NoteIndexEntry {
  return {
    uri,
    subdir: "Journal",
    title: "Journal",
    createdOrDate,
    tags: [],
    mode: "journal",
    excerpt: "",
  };
}

describe("findPersonJournalMatches", () => {
  it("finds Unicode full-name matches and retains same-name ambiguity as separate journal links", async () => {
    const read = vi.fn(async (uri: string) =>
      uri.endsWith("2026-09-12.md")
        ? "Met José Núñez after lunch."
        : "JOSÉ NÚÑEZ called from the train.",
    );

    await expect(
      findPersonJournalMatches("José Núñez", [
        journal("file:///vault/Journal/2026-09-12.md", 2),
        journal("file:///vault/Journal/2026-09-11.md", 1),
      ], read),
    ).resolves.toEqual([
      {
        uri: "file:///vault/Journal/2026-09-12.md",
        linkTitle: "2026-09-12",
        excerpt: "Met José Núñez after lunch.",
      },
      {
        uri: "file:///vault/Journal/2026-09-11.md",
        linkTitle: "2026-09-11",
        excerpt: "JOSÉ NÚÑEZ called from the train.",
      },
    ]);
  });

  it("rejects first-name and substring hits, malformed dates, and bounds body reads", async () => {
    const read = vi.fn(async (uri: string) => {
      if (uri.includes("2026-09-14")) return "Ada Lovelace arrived.";
      if (uri.includes("2026-09-13")) return "Ada wrote notes.";
      return "Ada Lovelacex is not the person.";
    });

    await expect(
      findPersonJournalMatches(
        "Ada Lovelace",
        [
          journal("file:///vault/Journal/2026-09-14.md", 4),
          journal("file:///vault/Journal/2026-09-13.md", 3),
          journal("file:///vault/Journal/2026-09-12.md", 2),
          journal("file:///vault/Journal/not-a-date.md", 5),
        ],
        read,
        { maxReads: 2 },
      ),
    ).resolves.toEqual([
      {
        uri: "file:///vault/Journal/2026-09-14.md",
        linkTitle: "2026-09-14",
        excerpt: "Ada Lovelace arrived.",
      },
    ]);
    expect(read).toHaveBeenCalledTimes(2);
  });
});
