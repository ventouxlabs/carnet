import { describe, expect, it, vi } from "vitest";

// vault.ts pulls AsyncStorage + expo-file-system at import time; only its pure
// tagsForNote matters here, so restate it over the real frontmatter parser
// (same shape the RecentDetailScreen oracle uses). subdirForUri is pure
// (lives in ./noteSubdirs, which vault.ts merely re-exports), so it's
// imported for real rather than hand-copied.
vi.mock("./vault", async () => {
  const fm = await import("./frontmatter");
  const { subdirForUri } = await import("./noteSubdirs");
  return {
    tagsForNote: (md: string) => fm.getFrontmatterTags(md),
    subdirForUri,
  };
});

import { computeRelatedNotes } from "./noteRelated";
import type { CaptureEntry } from "./storage";
import type { NoteIndex, NoteIndexEntry } from "./vault";

const ENTRY: CaptureEntry = {
  id: "r1",
  mode: "idea",
  title: "Stale History Title",
  filepath: "file:///v/Ideas/open-note.md",
  createdAt: 1_751_975_746_000,
};

function note(over: Partial<NoteIndexEntry>): NoteIndexEntry {
  return {
    uri: "file:///v/Ideas/other.md",
    subdir: "Ideas",
    title: "Other note",
    createdOrDate: 1,
    tags: [],
    mode: "idea",
    excerpt: "",
    ...over,
  };
}

function index(...notes: NoteIndexEntry[]): NoteIndex {
  return { builtAt: 1, notes };
}

describe("computeRelatedNotes", () => {
  it("scores tags read off the live body, not the history entry", () => {
    const body = "---\ntags: [hydroponics]\n---\n# Open note\n\nProse.\n";
    const hit = note({
      uri: "file:///v/Ideas/a.md",
      title: "Alpha",
      tags: ["hydroponics"],
    });
    const miss = note({
      uri: "file:///v/Ideas/b.md",
      title: "Beta",
      tags: ["woodwork"],
    });

    expect(computeRelatedNotes(body, ENTRY, index(hit, miss))).toEqual([hit]);
  });

  it("uses the body's H1 title over the (possibly re-enriched away) entry title", () => {
    const body = "# Hydroponic lettuce rig\n\nProse.\n";
    const byBodyTitle = note({
      uri: "file:///v/Ideas/a.md",
      title: "Hydroponic notes",
    });
    const byEntryTitle = note({
      uri: "file:///v/Ideas/b.md",
      title: "Stale History Title",
    });

    expect(computeRelatedNotes(body, ENTRY, index(byBodyTitle, byEntryTitle))).toEqual([
      byBodyTitle,
    ]);
  });

  it("falls back to the entry title when the body derives no title at all", () => {
    // deriveTitle returns "" only when the first line is blank and no H1 follows.
    const body = "\n\nprose with no heading\n";
    const byEntryTitle = note({
      uri: "file:///v/Ideas/b.md",
      title: "Stale History Title",
    });

    expect(computeRelatedNotes(body, ENTRY, index(byEntryTitle))).toEqual([
      byEntryTitle,
    ]);
  });

  it("excludes the open note itself", () => {
    const body = "---\ntags: [hydroponics]\n---\n# Open note\n";
    const self = note({ uri: ENTRY.filepath, tags: ["hydroponics"] });

    expect(computeRelatedNotes(body, ENTRY, index(self))).toEqual([]);
  });

  it("derives the subdir from the uri, not the mode, for self-exclusion", () => {
    // Mode and uri deliberately DISAGREE here (mode: "person" would map to
    // "People" via relatedSubdirForMode, but the uri is actually in Journal/)
    // so this test can only pass under uri-derivation — under the old
    // mode-derived subdir, the query would carry "People", which wrongly
    // matches this same-basename People/ note's subdir + basename and
    // excludes it as "self", dropping a genuinely different, genuinely
    // related note.
    const body = "---\ntags: [hydroponics]\n---\n# Open note\n";
    const mismatchedEntry: CaptureEntry = {
      ...ENTRY,
      mode: "person",
      filepath: "file:///v/Journal/open-note.md",
    };
    const sameNameOtherSubdir = note({
      uri: "file:///v/People/open-note.md",
      subdir: "People",
      tags: ["hydroponics"],
    });

    expect(
      computeRelatedNotes(body, mismatchedEntry, index(sameNameOtherSubdir)),
    ).toEqual([sameNameOtherSubdir]);
  });

  it("excludes a Notes/ note against Notes/, not Ideas/ (mode reports idea for Notes/)", () => {
    // inferNoteMode falls back to "idea" for any uri it doesn't recognize,
    // including Notes/ — so a synthesis note's entry.mode is "idea" even
    // though it lives in Notes/. Under the OLD mode-derived subdir, the query
    // would carry subdir "Ideas" (relatedSubdirForMode("idea")), which wrongly
    // matches this same-basename Ideas/ note's subdir + basename and excludes
    // it as "self" — dropping a genuinely different, genuinely related note.
    // The uri-derived subdir ("Notes") does not match "Ideas", so the note
    // survives as a real related hit.
    const body = "---\ntags: [hydroponics]\n---\n# Synth\n";
    const synthEntry: CaptureEntry = {
      ...ENTRY,
      mode: "idea",
      filepath: "file:///v/Notes/synth.md",
    };
    const sameNameInIdeas = note({
      uri: "file:///v/Ideas/synth.md",
      subdir: "Ideas",
      tags: ["hydroponics"],
    });

    expect(computeRelatedNotes(body, synthEntry, index(sameNameInIdeas))).toEqual([
      sameNameInIdeas,
    ]);
  });

  it("returns nothing when no indexed note shares a tag or title term", () => {
    const body = "---\ntags: [alpha]\n---\n# Zzzz\n";
    expect(
      computeRelatedNotes(body, ENTRY, index(note({ title: "Beta", tags: ["beta"] }))),
    ).toEqual([]);
  });
});
