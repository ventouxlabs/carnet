import { beforeEach, describe, expect, it, vi } from "vitest";

// ── Mocks ─────────────────────────────────────────────────────────────────────
// vault.ts reads notes through ./writer (native: expo-file-system) and caches
// through AsyncStorage (native). Replace both with in-memory fakes so the index
// logic is exercised in plain Node. ./frontmatter is pure and used for real.

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
  buildTagIndex,
  getAllTodos,
  getTagIndex,
  inferNoteMode,
  invalidateTagIndex,
  loadCachedNoteIndex,
  loadCachedTagIndex,
  notesForTag,
  refreshTagIndex,
  suggestTags,
  synthesizeEntry,
  tagsForNote,
  upsertNoteInIndex,
  type NoteIndex,
  type TagIndex,
} from "./vault";
import { listNoteFiles, readNote } from "./writer";

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
}

beforeEach(reset);

// ── buildNoteIndex titles ─────────────────────────────────────────────────────

describe("buildNoteIndex titles", () => {
  it("derives the title from the body, not the frontmatter delimiter", async () => {
    // A save-first raw note: frontmatter but no H1. The regression this
    // guards: deriveTitle on the FULL file falls back to its first line,
    // which is the literal "---" delimiter.
    addNote(
      "file:///v/Ideas/raw.md",
      "Ideas",
      "---\ncreated: 2026-07-08T00:00:00.000Z\nstatus: pending-enrich\ntags: [qa-test]\n---\ndraft survival test\n",
    );
    const index = await buildNoteIndex();
    expect(index.notes[0].title).toBe("draft survival test");
    expect(index.notes[0].status).toBe("pending-enrich");
  });

  it("prefers the H1 when present", async () => {
    addNote("file:///v/Ideas/h1.md", "Ideas", "---\ntags: [x]\n---\n# Real Title\n\nbody\n");
    const index = await buildNoteIndex();
    expect(index.notes[0].title).toBe("Real Title");
  });

  it("falls back to the filename when the body is empty", async () => {
    addNote("file:///v/Ideas/empty-note.md", "Ideas", "---\ncreated: x\n---\n");
    const index = await buildNoteIndex();
    expect(index.notes[0].title.length).toBeGreaterThan(0);
    expect(index.notes[0].title).not.toBe("---");
  });

  it("strips embed markdown from excerpts, keeping link labels", async () => {
    addNote(
      "file:///v/Ideas/photo-first.md",
      "Ideas",
      "---\ncreated: x\n---\n# Jack's Baseball Team\n\n![](../Photos/pxl-1.jpg) Jack made the team. See [the roster](https://example.com/roster).\n",
    );
    const index = await buildNoteIndex();
    expect(index.notes[0].excerpt).toBe(
      "Jack made the team. See the roster.",
    );
  });
});

// ── buildNoteIndex todos ──────────────────────────────────────────────────────

describe("buildNoteIndex todos", () => {
  it("populates todos from checklist lines in the body", async () => {
    addNote(
      "file:///v/Ideas/todo.md",
      "Ideas",
      "---\ntags: [x]\n---\n# T\n\n- [ ] buy milk\n- [x] done thing\n",
    );
    const index = await buildNoteIndex();
    expect(index.notes[0].todos).toEqual([
      { text: "buy milk", checked: false },
      { text: "done thing", checked: true },
    ]);
  });

  it("omits the todos key entirely when there are no checklist lines (not an empty array)", async () => {
    addNote(
      "file:///v/Ideas/plain.md",
      "Ideas",
      "---\ntags: [x]\n---\n# T\n\nno checklist here\n",
    );
    const index = await buildNoteIndex();
    expect(index.notes[0]).not.toHaveProperty("todos");
  });
});

// ── buildTagIndex ─────────────────────────────────────────────────────────────

describe("buildTagIndex", () => {
  it("counts each tag once per note across the vault", async () => {
    addNote("file:///v/Ideas/a.md", "Ideas", "---\ntags: [work, idea]\n---\n# A\n");
    addNote("file:///v/Ideas/b.md", "Ideas", "---\ntags: [work]\n---\n# B\n");
    addNote("file:///v/Journal/c.md", "Journal", "---\ntags:\n  - idea\n---\n# C\n");

    const index = await buildTagIndex();
    const byTag = Object.fromEntries(index.tags.map((t) => [t.tag, t.count]));
    expect(byTag).toEqual({ work: 2, idea: 2 });
  });

  it("sorts by count desc, then tag asc", async () => {
    addNote("file:///v/Ideas/a.md", "Ideas", "---\ntags: [zebra, alpha, common]\n---\n");
    addNote("file:///v/Ideas/b.md", "Ideas", "---\ntags: [common]\n---\n");
    const index = await buildTagIndex();
    expect(index.tags.map((t) => t.tag)).toEqual(["common", "alpha", "zebra"]);
  });

  it("normalizes tags before counting (case/space folded together)", async () => {
    addNote("file:///v/Ideas/a.md", "Ideas", "---\ntags: ['My Tag']\n---\n");
    addNote("file:///v/Ideas/b.md", "Ideas", "---\ntags: [my-tag]\n---\n");
    const index = await buildTagIndex();
    expect(index.tags).toEqual([
      { tag: "my-tag", count: 2, files: ["file:///v/Ideas/a.md", "file:///v/Ideas/b.md"] },
    ]);
  });

  it("ignores notes with no frontmatter / no tags", async () => {
    addNote("file:///v/Ideas/a.md", "Ideas", "# Just a title\n\nbody\n");
    addNote("file:///v/Ideas/b.md", "Ideas", "---\nkind: idea\n---\n# B\n");
    const index = await buildTagIndex();
    expect(index.tags).toEqual([]);
  });

  it("skips unreadable notes instead of failing the whole scan", async () => {
    addNote("file:///v/Ideas/ok.md", "Ideas", "---\ntags: [keep]\n---\n");
    addNote("file:///v/Ideas/gone.md", "Ideas", "---\ntags: [lost]\n---\n");
    _unreadable.add("file:///v/Ideas/gone.md");

    const index = await buildTagIndex();
    expect(index.tags.map((t) => t.tag)).toEqual(["keep"]);
  });

  it("records the carrying note URIs per tag", async () => {
    addNote("file:///v/Ideas/a.md", "Ideas", "---\ntags: [shared]\n---\n");
    addNote("file:///v/People/b.md", "People", "---\ntags: [shared]\n---\n");
    const index = await buildTagIndex();
    expect(index.tags[0].files.sort()).toEqual([
      "file:///v/Ideas/a.md",
      "file:///v/People/b.md",
    ]);
  });

  it("reads every note even when the count exceeds the concurrency limit", async () => {
    for (let i = 0; i < 25; i++) {
      addNote(`file:///v/Ideas/n${i}.md`, "Ideas", `---\ntags: [t${i % 3}]\n---\n`);
    }
    const index = await buildTagIndex();
    expect(readNote).toHaveBeenCalledTimes(25);
    const total = index.tags.reduce((sum, t) => sum + t.count, 0);
    expect(total).toBe(25);
  });

  it("returns an empty index for an empty vault", async () => {
    const index = await buildTagIndex();
    expect(index.tags).toEqual([]);
    expect(listNoteFiles).toHaveBeenCalledOnce();
  });
});

// ── caching ───────────────────────────────────────────────────────────────────

describe("tag index cache", () => {
  it("loadCachedTagIndex returns null before any build", async () => {
    expect(await loadCachedTagIndex()).toBeNull();
  });

  it("refreshTagIndex persists and is read back by loadCachedTagIndex", async () => {
    addNote("file:///v/Ideas/a.md", "Ideas", "---\ntags: [work]\n---\n");
    const built = await refreshTagIndex();
    const cached = await loadCachedTagIndex();
    expect(cached).toEqual(built);
    expect(cached!.tags[0].tag).toBe("work");
  });

  it("getTagIndex builds + caches on a cold miss, then serves the cache", async () => {
    addNote("file:///v/Ideas/a.md", "Ideas", "---\ntags: [work]\n---\n");
    const first = await getTagIndex();
    expect(listNoteFiles).toHaveBeenCalledOnce();

    // Second call should hit the cache — no further vault scan.
    const second = await getTagIndex();
    expect(listNoteFiles).toHaveBeenCalledOnce();
    expect(second).toEqual(first);
  });

  it("loadCachedTagIndex tolerates corrupt cache JSON", async () => {
    _store.set("carnet:tagindex:v1", "{not json");
    expect(await loadCachedTagIndex()).toBeNull();
  });

  it("invalidateTagIndex drops the cache so the next read rebuilds", async () => {
    addNote("file:///v/Ideas/a.md", "Ideas", "---\ntags: [work]\n---\n");
    await refreshTagIndex();
    expect(await loadCachedTagIndex()).not.toBeNull();

    await invalidateTagIndex();
    expect(await loadCachedTagIndex()).toBeNull();
  });
});

// ── suggestTags ───────────────────────────────────────────────────────────────

describe("suggestTags", () => {
  const index: TagIndex = {
    builtAt: 0,
    tags: [
      { tag: "work", count: 5, files: [] },
      { tag: "workout", count: 3, files: [] },
      { tag: "homework", count: 2, files: [] },
      { tag: "idea", count: 1, files: [] },
    ],
  };

  it("returns most-used tags for an empty query", () => {
    expect(suggestTags(index, "", 2)).toEqual(["work", "workout"]);
  });

  it("prefix matches rank ahead of substring matches", () => {
    expect(suggestTags(index, "work")).toEqual(["work", "workout", "homework"]);
  });

  it("normalizes the query before matching", () => {
    expect(suggestTags(index, "  WORK ")).toEqual(["work", "workout", "homework"]);
  });

  it("respects the limit", () => {
    expect(suggestTags(index, "work", 1)).toEqual(["work"]);
  });

  it("returns [] when nothing matches", () => {
    expect(suggestTags(index, "zzz")).toEqual([]);
  });
});

// ── tagsForNote ───────────────────────────────────────────────────────────────

describe("tagsForNote", () => {
  it("returns distinct normalized tags for a note", () => {
    expect(tagsForNote("---\ntags: ['My Tag', my-tag, Work]\n---\n# T\n")).toEqual([
      "my-tag",
      "work",
    ]);
  });

  it("returns [] for a note with no tags", () => {
    expect(tagsForNote("# Just prose\n")).toEqual([]);
  });
});

// ── inferNoteMode ─────────────────────────────────────────────────────────────

describe("inferNoteMode", () => {
  it("maps file:// subdirs to capture modes", () => {
    expect(inferNoteMode("file:///v/Ideas/a.md")).toBe("idea");
    expect(inferNoteMode("file:///v/Journal/2026-05-16.md")).toBe("journal");
    expect(inferNoteMode("file:///v/People/Jane-Doe.md")).toBe("person");
  });

  it("decodes SAF document URIs before matching the subdir", () => {
    const saf =
      "content://com.android.externalstorage.documents/tree/primary%3ACarnet/document/primary%3ACarnet%2FJournal%2F2026-05-16.md";
    expect(inferNoteMode(saf)).toBe("journal");
  });

  it("defaults to idea for an unrecognized location", () => {
    expect(inferNoteMode("file:///v/Misc/x.md")).toBe("idea");
  });

  it("matches the immediate parent dir, not any path segment", () => {
    // Vault rooted under a folder named "Journal" must not misclassify Ideas.
    expect(inferNoteMode("file:///storage/Journal/carnet/Ideas/note.md")).toBe("idea");
    expect(inferNoteMode("file:///mnt/People/vault/Journal/2026-01-01.md")).toBe("journal");
  });
});

// ── synthesizeEntry ───────────────────────────────────────────────────────────

describe("synthesizeEntry", () => {
  it("derives title from the H1, mode from the subdir, date from frontmatter", () => {
    const md = "---\ncreated: 2026-05-08\n---\n# My Idea\n\nbody\n";
    const entry = synthesizeEntry("file:///v/Ideas/my-idea.md", md);
    expect(entry).toEqual({
      id: "vault:file:///v/Ideas/my-idea.md",
      mode: "idea",
      title: "My Idea",
      filepath: "file:///v/Ideas/my-idea.md",
      createdAt: Date.parse("2026-05-08"),
    });
  });

  it("falls back to the filename title and createdAt 0 for an empty note", () => {
    const entry = synthesizeEntry("file:///v/Journal/2026-05-16.md", "");
    expect(entry.title).toBe("2026-05-16");
    expect(entry.mode).toBe("journal");
    expect(entry.createdAt).toBe(0);
  });

  it("uses an unknown id no recents helper will match (no history corruption)", () => {
    const entry = synthesizeEntry("file:///v/Ideas/a.md", "# A\n");
    expect(entry.id.startsWith("vault:")).toBe(true);
  });
});

// ── notesForTag ───────────────────────────────────────────────────────────────

describe("notesForTag", () => {
  it("resolves a tag's notes into entries, newest first", async () => {
    addNote("file:///v/Ideas/a.md", "Ideas", "---\ncreated: 2026-01-01\ntags: [work]\n---\n# A\n");
    addNote("file:///v/Ideas/b.md", "Ideas", "---\ncreated: 2026-03-01\ntags: [work]\n---\n# B\n");
    const index = await buildTagIndex();

    const notes = await notesForTag(index, "work");
    expect(notes.map((n) => n.title)).toEqual(["B", "A"]); // 2026-03 before 2026-01
  });

  it("normalizes the tag argument", async () => {
    addNote("file:///v/Ideas/a.md", "Ideas", "---\ntags: [my-tag]\n---\n# A\n");
    const index = await buildTagIndex();
    expect(await notesForTag(index, "My Tag")).toHaveLength(1);
  });

  it("returns [] for an unknown tag", async () => {
    const index = await buildTagIndex();
    expect(await notesForTag(index, "nope")).toEqual([]);
  });

  it("skips notes that became unreadable after indexing", async () => {
    addNote("file:///v/Ideas/a.md", "Ideas", "---\ntags: [x]\n---\n# A\n");
    addNote("file:///v/Ideas/b.md", "Ideas", "---\ntags: [x]\n---\n# B\n");
    const index = await buildTagIndex();
    _unreadable.add("file:///v/Ideas/b.md");

    const notes = await notesForTag(index, "x");
    expect(notes.map((n) => n.title)).toEqual(["A"]);
  });
});

// ── upsertNoteInIndex + todos ─────────────────────────────────────────────────

describe("upsertNoteInIndex picks up todos with no extra wiring", () => {
  it("reflects a note's new checklist lines on an incremental upsert, without a full rescan", async () => {
    addNote("file:///v/Ideas/a.md", "Ideas", "---\ntags: [x]\n---\n# A\n\nno checklist yet\n");
    await refreshTagIndex(); // builds + persists the note index cache
    const before = await loadCachedNoteIndex();
    expect(before!.notes[0].todos).toBeUndefined();
    expect(listNoteFiles).toHaveBeenCalledOnce();

    await upsertNoteInIndex(
      "file:///v/Ideas/a.md",
      "---\ntags: [x]\n---\n# A\n\n- [ ] new task\n",
    );

    const after = await loadCachedNoteIndex();
    expect(after!.notes[0].todos).toEqual([{ text: "new task", checked: false }]);
    // Still just the one vault scan (from refreshTagIndex) — upsert never rescans.
    expect(listNoteFiles).toHaveBeenCalledOnce();
  });
});

// ── getAllTodos ───────────────────────────────────────────────────────────────

describe("getAllTodos", () => {
  it("flattens every note's todos, newest-note-first, ties broken by note title", () => {
    const index: NoteIndex = {
      builtAt: 0,
      notes: [
        {
          uri: "file:///v/Ideas/b.md",
          subdir: "Ideas",
          title: "B Note",
          createdOrDate: 100,
          tags: [],
          mode: "idea",
          excerpt: "",
          todos: [{ text: "t1", checked: false }],
        },
        {
          uri: "file:///v/Ideas/a.md",
          subdir: "Ideas",
          title: "A Note",
          createdOrDate: 100,
          tags: [],
          mode: "idea",
          excerpt: "",
          todos: [{ text: "t2", checked: true }],
        },
        {
          uri: "file:///v/Journal/c.md",
          subdir: "Journal",
          title: "C Note",
          createdOrDate: 200,
          tags: [],
          mode: "journal",
          excerpt: "",
          todos: [
            { text: "t3", checked: false },
            { text: "t4", checked: false },
          ],
        },
        {
          uri: "file:///v/Ideas/d.md",
          subdir: "Ideas",
          title: "D Note",
          createdOrDate: 50,
          tags: [],
          mode: "idea",
          excerpt: "",
          // no `todos` key at all — must contribute nothing, not throw.
        },
      ],
    };

    expect(getAllTodos(index)).toEqual([
      { text: "t3", checked: false, uri: "file:///v/Journal/c.md", noteTitle: "C Note", subdir: "Journal", mode: "journal", createdOrDate: 200, ordinal: 0 },
      { text: "t4", checked: false, uri: "file:///v/Journal/c.md", noteTitle: "C Note", subdir: "Journal", mode: "journal", createdOrDate: 200, ordinal: 1 },
      { text: "t2", checked: true, uri: "file:///v/Ideas/a.md", noteTitle: "A Note", subdir: "Ideas", mode: "idea", createdOrDate: 100, ordinal: 0 },
      { text: "t1", checked: false, uri: "file:///v/Ideas/b.md", noteTitle: "B Note", subdir: "Ideas", mode: "idea", createdOrDate: 100, ordinal: 0 },
    ]);
  });

  it("getAllTodos > assigns ordinal by position within each note's own todos array", () => {
    const index: NoteIndex = {
      builtAt: 1,
      notes: [
        {
          uri: "file:///v/Ideas/dup.md",
          subdir: "Ideas",
          title: "Dup Note",
          createdOrDate: 100,
          tags: [],
          mode: "idea",
          excerpt: "",
          todos: [
            { text: "same text", checked: false },
            { text: "same text", checked: false },
          ],
        },
      ],
    };

    const todos = getAllTodos(index);
    expect(todos.map((t) => t.ordinal)).toEqual([0, 1]);
    // Ordinal is what makes these two otherwise-identical rows addressable
    // independently (e.g. TodosScreen's flipInIndex) without touching text.
    expect(todos[0].text).toBe(todos[1].text);
  });

  it("returns [] and doesn't throw for an index with no todos at all", () => {
    const index: NoteIndex = {
      builtAt: 0,
      notes: [
        {
          uri: "file:///v/Ideas/a.md",
          subdir: "Ideas",
          title: "A",
          createdOrDate: 1,
          tags: [],
          mode: "idea",
          excerpt: "",
        },
      ],
    };
    expect(() => getAllTodos(index)).not.toThrow();
    expect(getAllTodos(index)).toEqual([]);
  });

  it("doesn't throw on a cached index loaded from a pre-todos blob (no todos key on any entry)", async () => {
    _store.set(
      "carnet:noteindex:v1",
      JSON.stringify({
        builtAt: 0,
        notes: [
          {
            uri: "file:///v/Ideas/old.md",
            subdir: "Ideas",
            title: "Old",
            createdOrDate: 1,
            tags: [],
            mode: "idea",
            excerpt: "old note",
            // pre-todos v1 blob: no `todos` key.
          },
        ],
      }),
    );
    const cached = await loadCachedNoteIndex();
    expect(() => getAllTodos(cached!)).not.toThrow();
    expect(getAllTodos(cached!)).toEqual([]);
  });
});
