import { beforeEach, describe, expect, it, vi } from "vitest";

// ── Mocks ─────────────────────────────────────────────────────────────────────
// Mirrors vault.test.ts: vault.ts reads notes through ./writer (native) and
// caches through AsyncStorage (native). Replace both with in-memory fakes so
// the note-index + search logic runs in plain Node; ./frontmatter is pure.

interface FakeNote {
  uri: string;
  name: string;
  subdir: "Ideas" | "Journal" | "People";
}

const _notes: Map<string, string> = new Map(); // uri -> markdown
let _listRefs: FakeNote[] = [];
const _unreadable: Set<string> = new Set();

vi.mock("./writer", () => ({
  listNoteFiles: vi.fn(async () => _listRefs),
  readNote: vi.fn(async (uri: string) => {
    if (_unreadable.has(uri)) throw new Error(`unreadable: ${uri}`);
    const md = _notes.get(uri);
    if (md === undefined) throw new Error(`not found: ${uri}`);
    return md;
  }),
}));

vi.mock("./settings", () => ({
  getSettings: vi.fn(async () => ({ captureFolderPath: "" })),
}));

const _store: Map<string, string> = new Map();
vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: vi.fn(async (k: string) => _store.get(k) ?? null),
    setItem: vi.fn(async (k: string, v: string) => {
      _store.set(k, v);
    }),
    removeItem: vi.fn(async (k: string) => {
      _store.delete(k);
    }),
  },
}));

import {
  buildNoteIndex,
  getNoteIndex,
  getTagIndex,
  invalidateNoteIndex,
  loadCachedNoteIndex,
  loadCachedTagIndex,
  refreshNoteIndex,
  resolveNoteEntry,
  searchNoteBodies,
  searchNotes,
  upsertNoteInIndex,
  type BodyMatch,
  type NoteIndex,
  type NoteIndexEntry,
} from "./vault";
import { listNoteFiles, readNote } from "./writer";
import { getSettings } from "./settings";

// ── Helpers ───────────────────────────────────────────────────────────────────

function addNote(uri: string, subdir: FakeNote["subdir"], markdown: string): void {
  _notes.set(uri, markdown);
  _listRefs.push({ uri, name: uri.split("/").pop()!, subdir });
}

function reset(): void {
  _notes.clear();
  _store.clear();
  _unreadable.clear();
  _listRefs = [];
  vi.clearAllMocks();
  vi.mocked(getSettings).mockResolvedValue({ captureFolderPath: "" } as Awaited<ReturnType<typeof getSettings>>);
}

beforeEach(reset);

function entryByUri(index: NoteIndex, uri: string): NoteIndexEntry {
  const found = index.notes.find((n) => n.uri === uri);
  if (!found) throw new Error(`no index entry for ${uri}`);
  return found;
}

// ── build parity ──────────────────────────────────────────────────────────────

describe("buildNoteIndex", () => {
  it("captures title, tags, excerpt, mode and subdir per note", async () => {
    addNote(
      "file:///v/Ideas/a.md",
      "Ideas",
      "---\ncreated: 2026-01-02\ntags: [work, 'My Tag']\n---\n# Alpha\n\nFirst body sentence here.\n",
    );
    addNote("file:///v/Journal/2026-05-16.md", "Journal", "Just prose, no heading.\n");

    const index = await buildNoteIndex();
    const a = entryByUri(index, "file:///v/Ideas/a.md");
    expect(a).toEqual({
      uri: "file:///v/Ideas/a.md",
      subdir: "Ideas",
      title: "Alpha",
      createdOrDate: Date.parse("2026-01-02"),
      tags: ["work", "my-tag"],
      mode: "idea",
      excerpt: "First body sentence here.",
    });

    const j = entryByUri(index, "file:///v/Journal/2026-05-16.md");
    expect(j.mode).toBe("journal");
    expect(j.subdir).toBe("Journal");
    expect(j.tags).toEqual([]);
    expect(j.createdOrDate).toBe(0); // no created:/date: frontmatter
    // No frontmatter, no H1 → title is the first body line; excerpt keeps prose.
    expect(j.title).toBe("Just prose, no heading.");
    expect(j.excerpt).toBe("Just prose, no heading.");
  });

  it("caps the excerpt at 200 chars", async () => {
    const long = "x".repeat(500);
    addNote("file:///v/Ideas/long.md", "Ideas", `---\n---\n# T\n\n${long}\n`);
    const index = await buildNoteIndex();
    expect(entryByUri(index, "file:///v/Ideas/long.md").excerpt).toHaveLength(200);
  });

  it("skips unreadable notes but keeps the rest", async () => {
    addNote("file:///v/Ideas/ok.md", "Ideas", "---\ntags: [keep]\n---\n# Ok\n");
    addNote("file:///v/Ideas/gone.md", "Ideas", "---\ntags: [lost]\n---\n# Gone\n");
    _unreadable.add("file:///v/Ideas/gone.md");
    const index = await buildNoteIndex();
    expect(index.notes.map((n) => n.uri)).toEqual(["file:///v/Ideas/ok.md"]);
  });
});

// ── cache-first read ──────────────────────────────────────────────────────────

describe("note index cache", () => {
  it("getNoteIndex builds + caches on a cold miss, then serves the cache without rescanning", async () => {
    addNote("file:///v/Ideas/a.md", "Ideas", "---\ntags: [work]\n---\n# A\n");
    const first = await getNoteIndex();
    expect(listNoteFiles).toHaveBeenCalledOnce();

    const second = await getNoteIndex();
    expect(listNoteFiles).toHaveBeenCalledOnce(); // no second scan
    expect(second).toEqual(first);
  });

  it("loadCachedNoteIndex returns null before any build and tolerates corrupt JSON", async () => {
    expect(await loadCachedNoteIndex()).toBeNull();
    _store.set("carnet:noteindex:v1", "{not json");
    expect(await loadCachedNoteIndex()).toBeNull();
  });

  it("invalidateNoteIndex drops the cache so the next read rebuilds", async () => {
    addNote("file:///v/Ideas/a.md", "Ideas", "---\ntags: [work]\n---\n# A\n");
    await refreshNoteIndex();
    expect(await loadCachedNoteIndex()).not.toBeNull();
    await invalidateNoteIndex();
    expect(await loadCachedNoteIndex()).toBeNull();
  });
});

// ── incremental upsert ────────────────────────────────────────────────────────

describe("upsertNoteInIndex", () => {
  it("adds a freshly written note without a full vault rescan", async () => {
    addNote("file:///v/Ideas/a.md", "Ideas", "---\ntags: [work]\n---\n# A\n");
    await refreshNoteIndex();
    vi.clearAllMocks(); // forget the build's listNoteFiles call

    await upsertNoteInIndex(
      "file:///v/Ideas/new.md",
      "---\ncreated: 2026-06-01\ntags: [fresh]\n---\n# New\n\nBrand new note.\n",
    );

    expect(listNoteFiles).not.toHaveBeenCalled(); // common path never rescans
    const index = await loadCachedNoteIndex();
    const entry = entryByUri(index!, "file:///v/Ideas/new.md");
    expect(entry.title).toBe("New");
    expect(entry.tags).toEqual(["fresh"]);
    expect(entry.mode).toBe("idea");
  });

  it("replaces the existing row for a URI rather than duplicating it", async () => {
    addNote("file:///v/Ideas/a.md", "Ideas", "---\ntags: [old]\n---\n# Old title\n");
    await refreshNoteIndex();

    await upsertNoteInIndex("file:///v/Ideas/a.md", "---\ntags: [new]\n---\n# New title\n");
    const index = await loadCachedNoteIndex();
    const rows = index!.notes.filter((n) => n.uri === "file:///v/Ideas/a.md");
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe("New title");
    expect(rows[0].tags).toEqual(["new"]);
  });

  it("is a no-op when no index is cached yet (avoids a rescan)", async () => {
    await upsertNoteInIndex("file:///v/Ideas/a.md", "---\ntags: [x]\n---\n# A\n");
    expect(listNoteFiles).not.toHaveBeenCalled();
    expect(await loadCachedNoteIndex()).toBeNull();
  });
});

// ── ranking ───────────────────────────────────────────────────────────────────

describe("searchNotes ranking", () => {
  function idx(notes: NoteIndexEntry[]): NoteIndex {
    return { builtAt: 0, notes };
  }
  function note(over: Partial<NoteIndexEntry>): NoteIndexEntry {
    return {
      uri: over.uri ?? "file:///v/Ideas/x.md",
      subdir: over.subdir ?? "Ideas",
      title: over.title ?? "",
      createdOrDate: over.createdOrDate ?? 0,
      tags: over.tags ?? [],
      mode: over.mode ?? "idea",
      excerpt: over.excerpt ?? "",
    };
  }

  it("ranks title matches above tag matches above excerpt matches", async () => {
    const index = idx([
      note({ uri: "e", excerpt: "mentions carnet in the body" }),
      note({ uri: "t", tags: ["carnet"] }),
      note({ uri: "ti", title: "carnet roadmap" }),
    ]);
    expect(searchNotes(index, "carnet").map((n) => n.uri)).toEqual(["ti", "t", "e"]);
  });

  it("ranks a title prefix ahead of a title substring", async () => {
    const index = idx([
      note({ uri: "sub", title: "my carnet notes" }),
      note({ uri: "pre", title: "carnet notes" }),
    ]);
    expect(searchNotes(index, "carnet").map((n) => n.uri)).toEqual(["pre", "sub"]);
  });

  it("breaks ties newest-first", async () => {
    const index = idx([
      note({ uri: "old", title: "carnet a", createdOrDate: 100 }),
      note({ uri: "new", title: "carnet b", createdOrDate: 200 }),
    ]);
    expect(searchNotes(index, "carnet").map((n) => n.uri)).toEqual(["new", "old"]);
  });

  it("filters by mode before ranking", async () => {
    const index = idx([
      note({ uri: "idea", title: "carnet idea", mode: "idea" }),
      note({ uri: "journal", title: "carnet journal", mode: "journal" }),
    ]);
    expect(searchNotes(index, "carnet", { mode: "journal" }).map((n) => n.uri)).toEqual(["journal"]);
  });

  it("returns every filtered note newest-first for an empty query (browse)", async () => {
    const index = idx([
      note({ uri: "a", title: "a", createdOrDate: 1 }),
      note({ uri: "b", title: "b", createdOrDate: 2 }),
    ]);
    expect(searchNotes(index, "  ").map((n) => n.uri)).toEqual(["b", "a"]);
  });

  it("excludes non-matching notes", async () => {
    const index = idx([note({ uri: "a", title: "unrelated", excerpt: "nothing here" })]);
    expect(searchNotes(index, "carnet")).toEqual([]);
  });
});

// ── result navigation ─────────────────────────────────────────────────────────

describe("resolveNoteEntry", () => {
  it("adapts an indexed note URI into the CaptureEntry RecentDetail expects", async () => {
    addNote("file:///v/Ideas/my-idea.md", "Ideas", "---\ncreated: 2026-05-08\n---\n# My Idea\n\nbody\n");
    const index = await buildNoteIndex();
    const hit = searchNotes(index, "my idea")[0];

    const entry = await resolveNoteEntry(hit.uri);
    expect(entry).toEqual({
      id: "vault:file:///v/Ideas/my-idea.md",
      mode: "idea",
      title: "My Idea",
      filepath: "file:///v/Ideas/my-idea.md",
      createdAt: Date.parse("2026-05-08"),
    });
  });

  it("returns null when the note became unreadable since indexing", async () => {
    addNote("file:///v/Ideas/a.md", "Ideas", "---\n---\n# A\n");
    await buildNoteIndex();
    _unreadable.add("file:///v/Ideas/a.md");
    expect(await resolveNoteEntry("file:///v/Ideas/a.md")).toBeNull();
  });
});

// ── fold-in regression: tag index derived from the note index ─────────────────

describe("tag index derived from note index (fold-in)", () => {
  it("getTagIndex reflects the same notes/tags as the note index", async () => {
    addNote("file:///v/Ideas/a.md", "Ideas", "---\ntags: [work, idea]\n---\n# A\n");
    addNote("file:///v/Ideas/b.md", "Ideas", "---\ntags: [work]\n---\n# B\n");
    addNote("file:///v/Journal/c.md", "Journal", "---\ntags:\n  - idea\n---\n# C\n");

    const tagIndex = await getTagIndex();
    expect(Object.fromEntries(tagIndex.tags.map((t) => [t.tag, t.count]))).toEqual({
      work: 2,
      idea: 2,
    });
  });

  it("upsert keeps the derived tag index fresh without a separate scan", async () => {
    addNote("file:///v/Ideas/a.md", "Ideas", "---\ntags: [work]\n---\n# A\n");
    await refreshNoteIndex();
    await upsertNoteInIndex("file:///v/Ideas/b.md", "---\ntags: [work, new]\n---\n# B\n");

    const tagIndex = await loadCachedTagIndex();
    expect(tagIndex).not.toBeNull();
    expect(Object.fromEntries(tagIndex!.tags.map((t) => [t.tag, t.count]))).toEqual({
      work: 2,
      new: 1,
    });
  });
});

// ── searchNoteBodies ─────────────────────────────────────────────────────────

describe("searchNoteBodies", () => {
  it("finds a match beyond the indexed excerpt window (200 chars)", async () => {
    const long = "x".repeat(250) + " findme here";
    addNote("file:///v/Ideas/deep.md", "Ideas", `---\n---\n# T\n\n${long}\n`);

    const matches: BodyMatch[] = [];
    const result = await searchNoteBodies(
      "findme",
      (m) => matches.push(m),
      () => {},
      new AbortController().signal,
    );

    expect(matches).toHaveLength(1);
    expect(matches[0].uri).toBe("file:///v/Ideas/deep.md");
    expect(matches[0].snippet).toContain("findme");
    expect(result).toEqual({ scanned: 1, total: 1 });
  });

  it("matches case-insensitively", async () => {
    addNote("file:///v/Ideas/a.md", "Ideas", "---\n---\n# T\n\nHello WORLD\n");

    const matches: BodyMatch[] = [];
    await searchNoteBodies("world", (m) => matches.push(m), () => {}, new AbortController().signal);

    expect(matches).toHaveLength(1);
  });

  it("skips unreadable notes without failing the whole scan", async () => {
    addNote("file:///v/Ideas/ok.md", "Ideas", "---\n---\n# T\n\nneedle good\n");
    _listRefs.push({ uri: "file:///v/Ideas/bad.md", name: "bad.md", subdir: "Ideas" });
    _unreadable.add("file:///v/Ideas/bad.md");

    const matches: BodyMatch[] = [];
    const result = await searchNoteBodies(
      "needle",
      (m) => matches.push(m),
      () => {},
      new AbortController().signal,
    );

    expect(matches).toEqual([
      { uri: "file:///v/Ideas/ok.md", snippet: expect.stringContaining("needle") },
    ]);
    expect(result).toEqual({ scanned: 2, total: 2 });
  });

  it("reports incremental progress via onProgress as each note is scanned", async () => {
    addNote("file:///v/Ideas/a.md", "Ideas", "---\n---\n# T\n\nneedle a\n");
    addNote("file:///v/Ideas/b.md", "Ideas", "---\n---\n# T\n\nneedle b\n");

    const progressCalls: Array<{ scanned: number; total: number }> = [];
    await searchNoteBodies(
      "needle",
      () => {},
      (p) => progressCalls.push(p),
      new AbortController().signal,
    );

    expect(progressCalls).toEqual([
      { scanned: 1, total: 2 },
      { scanned: 2, total: 2 },
    ]);
  });

  it("delivers a fast match before a concurrently-scanning slow note resolves", async () => {
    addNote("file:///v/Ideas/fast.md", "Ideas", "---\n---\n# T\n\nneedle fast\n");
    addNote("file:///v/Ideas/slow.md", "Ideas", "---\n---\n# T\n\nneedle slow\n");

    let resolveSlow!: (v: string) => void;
    const slowPromise = new Promise<string>((res) => {
      resolveSlow = res;
    });

    vi.mocked(readNote)
      .mockImplementationOnce(async () => _notes.get("file:///v/Ideas/fast.md")!)
      .mockImplementationOnce(() => slowPromise);

    const matches: string[] = [];
    const done = searchNoteBodies(
      "needle",
      (m) => matches.push(m.uri),
      () => {},
      new AbortController().signal,
    );

    await Promise.resolve();
    await Promise.resolve();
    expect(matches).toEqual(["file:///v/Ideas/fast.md"]);

    resolveSlow("---\n---\n# T\n\nneedle slow\n");
    await done;
    expect(matches).toEqual(["file:///v/Ideas/fast.md", "file:///v/Ideas/slow.md"]);
  });

  it("never splits a surrogate pair (emoji) when the naive snippet boundary lands mid-character", async () => {
    // Construct the body so the naive `idx - SNIPPET_WINDOW` (40) start
    // boundary lands exactly on the low-surrogate half of "🎉" (U+1F389,
    // a 2-code-unit surrogate pair): 5 "A"s (0-4), then the emoji at
    // indices 5 (high surrogate) and 6 (low surrogate), then 39 "B"s
    // (7-45), then "findme" at 46-51, then 40 "C"s as trailing context so
    // the end boundary lands exactly at the string's length (no clamp
    // needed there). idx=46, so naive start = 46-40 = 6 — the low
    // surrogate's own index.
    const prefix = "A".repeat(5) + "\u{1F389}" + "B".repeat(39);
    const body = prefix + "findme" + "C".repeat(40);
    addNote("file:///v/Ideas/emoji.md", "Ideas", `---\n---\n${body}`);

    const matches: BodyMatch[] = [];
    await searchNoteBodies(
      "findme",
      (m) => matches.push(m),
      () => {},
      new AbortController().signal,
    );

    expect(matches).toHaveLength(1);
    const snippet = matches[0].snippet;

    // The naive boundary (index 6) is a lone low surrogate — slicing there
    // would produce a snippet starting with an unpaired low surrogate. The
    // fix must nudge the start back to index 5 so the whole emoji is kept.
    expect(snippet).toBe(
      "…" + "\u{1F389}" + "B".repeat(39) + "findme" + "C".repeat(40),
    );
    // Belt-and-suspenders: the code UNIT immediately after the "…" prefix
    // (index 1, the raw UTF-16 unit — not codePointAt, which would already
    // combine a valid pair) must be a high surrogate (paired), never a lone
    // low surrogate, confirming the boundary wasn't split mid-character.
    const firstUnit = snippet.charCodeAt(1);
    expect(firstUnit).toBeGreaterThanOrEqual(0xd800);
    expect(firstUnit).toBeLessThanOrEqual(0xdbff);
  });

  it("stops issuing new reads once aborted, keeping only already-issued results", async () => {
    const uris = Array.from({ length: 9 }, (_, i) => `file:///v/Ideas/n${i}.md`);
    for (const uri of uris) addNote(uri, "Ideas", "---\n---\n# T\n\nneedle here\n");

    const resolvers: Array<() => void> = [];
    const calledUris: string[] = [];
    vi.mocked(readNote).mockImplementation((uri: string) => {
      calledUris.push(uri);
      return new Promise<string>((res) => resolvers.push(() => res(_notes.get(uri)!)));
    });

    const controller = new AbortController();
    const matches: string[] = [];
    const done = searchNoteBodies(
      "needle",
      (m) => matches.push(m.uri),
      () => {},
      controller.signal,
    );

    await Promise.resolve();
    await Promise.resolve();
    expect(calledUris).toHaveLength(8); // SCAN_CONCURRENCY — item 9 (index 8) is queued, not issued

    controller.abort();
    resolvers[0]();
    await Promise.resolve();
    await Promise.resolve();
    expect(calledUris).toHaveLength(8); // no 9th read issued after abort

    resolvers.slice(1).forEach((r) => r());
    const result = await done;
    expect(result).toEqual({ scanned: 8, total: 9 });
  });
});
