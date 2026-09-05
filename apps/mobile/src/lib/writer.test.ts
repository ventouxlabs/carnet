import { beforeEach, describe, expect, it, vi } from "vitest";

// ── Mock expo-file-system/legacy ─────────────────────────────────────────────
// We can't run the real native module in Node. Replace it with an in-memory
// store so we can test writer logic without device hardware.

interface FileEntry {
  content: string;
}

const _files: Map<string, FileEntry> = new Map();

// Mock ./settings before importing writer.ts so vite-node never loads
// the real settings.ts → expo-secure-store → expo-modules-core → react-native
// chain — react-native ships Flow source rollup's native parser can't handle.
vi.mock("./settings", () => ({
  getSettings: vi.fn().mockResolvedValue({
    omniRouteUrl: "",
    omniRouteApiKey: "",
    omniRouteModel: "",
    captureFolderPath: "",
  }),
}));

vi.mock("expo-file-system/legacy", () => {
  return {
    documentDirectory: "file:///data/",
    EncodingType: { UTF8: "utf8", Base64: "base64" },
    getInfoAsync: vi.fn(async (uri: string) => {
      if (_files.has(uri)) return { exists: true, uri, isDirectory: false };
      // Model directories implicitly: a path is a directory iff some tracked
      // file lives under it. Lets the read-only findSubdir resolve real subdirs
      // without us having to track dir entries separately.
      const dirPrefix = uri.replace(/\/$/, "") + "/";
      const isDir = [..._files.keys()].some((u) => u.startsWith(dirPrefix));
      return { exists: isDir, uri, isDirectory: isDir };
    }),
    makeDirectoryAsync: vi.fn(async (_uri: string, _opts?: unknown) => {
      // no-op for directories — we track files only
    }),
    readDirectoryAsync: vi.fn(async (parentUri: string) => {
      // Return the basenames of files whose URI starts with parentUri/.
      const prefix = parentUri.replace(/\/$/, "") + "/";
      const out: string[] = [];
      for (const uri of _files.keys()) {
        if (uri.startsWith(prefix)) {
          const rest = uri.slice(prefix.length);
          if (!rest.includes("/")) out.push(rest);
        }
      }
      return out;
    }),
    readAsStringAsync: vi.fn(async (uri: string) => {
      const entry = _files.get(uri);
      if (!entry) throw new Error(`File not found: ${uri}`);
      return entry.content;
    }),
    writeAsStringAsync: vi.fn(async (uri: string, content: string) => {
      _files.set(uri, { content });
    }),
    deleteAsync: vi.fn(async (uri: string) => {
      _files.delete(uri);
    }),
    // StorageAccessFramework is only touched on the SAF branch. We never
    // exercise that branch in these tests (the default capture folder is
    // empty → file:// branch), but stub it out so the property access in
    // writer.ts doesn't blow up on module load.
    StorageAccessFramework: {
      readDirectoryAsync: vi.fn(),
      makeDirectoryAsync: vi.fn(),
      createFileAsync: vi.fn(),
      readAsStringAsync: vi.fn(),
      writeAsStringAsync: vi.fn(),
    },
  };
});

import {
  writeIdea,
  writeBinary,
  writeTextFile,
  appendJournal,
  writePerson,
  readNote,
  updateNote,
  updateChecklistItem,
  moveToArchive,
  rewriteFrontmatterField,
  safLastSegment,
  stripFrontmatter,
  splitFrontmatter,
  extractFrontmatterField,
  listNoteFiles,
  listSyncConflictFiles,
} from "./writer";
import * as FileSystem from "expo-file-system/legacy";
import { getSettings } from "./settings";

// ── Helpers ───────────────────────────────────────────────────────────────────

function clearFiles(): void {
  _files.clear();
}

// ── rewriteFrontmatterField ───────────────────────────────────────────────────

describe("rewriteFrontmatterField", () => {
  it("rewrites status field without touching body", () => {
    const md = "---\ncreated: 2026-05-08\nstatus: seedling\ntags: [idea]\n---\n# Title\n\nbody\n";
    const out = rewriteFrontmatterField(md, "status", "developing");
    expect(out).toContain("status: developing");
    expect(out).not.toContain("status: seedling");
    expect(out).toContain("# Title\n\nbody\n");
  });

  it("throws when field is absent from frontmatter", () => {
    const md = "---\ncreated: 2026-05-08\n---\n# Title\n";
    expect(() => rewriteFrontmatterField(md, "status", "developing")).toThrow("not present");
  });

  it("throws when there is no frontmatter", () => {
    const md = "# Just a title\n\nbody\n";
    expect(() => rewriteFrontmatterField(md, "status", "developing")).toThrow("no YAML frontmatter");
  });

  it("preserves body with horizontal rules (does not mis-cut)", () => {
    const body = "# Title\n\nIntro.\n\n---\n\nSection after rule.\n";
    const md = `---\nstatus: seedling\n---\n${body}`;
    const out = rewriteFrontmatterField(md, "status", "mature");
    expect(out).toContain("status: mature");
    expect(out).not.toContain("status: seedling");
    expect(out).toContain("Section after rule.");
  });

  it("throws on newlines in value", () => {
    const md = "---\nstatus: seedling\n---\n# T\n";
    expect(() => rewriteFrontmatterField(md, "status", "developing\ninjected: x")).toThrow("newlines");
  });
});

// ── writeIdea ─────────────────────────────────────────────────────────────────

describe("writeIdea", () => {
  beforeEach(clearFiles);

  it("creates Ideas/slug.md in an empty folder", async () => {
    const { filepath } = await writeIdea("my-idea", "# My Idea\n\nbody\n");
    expect(filepath).toMatch(/Ideas\/my-idea\.md$/);
    expect(_files.has(filepath)).toBe(true);
    expect(_files.get(filepath)!.content).toBe("# My Idea\n\nbody\n");
  });

  it("appends -2 on collision, -3 on second collision", async () => {
    const slug = "test-slug";
    const { filepath: fp1 } = await writeIdea(slug, "# First\n");
    expect(fp1).toMatch(/test-slug\.md$/);

    const { filepath: fp2 } = await writeIdea(slug, "# Second\n");
    expect(fp2).toMatch(/test-slug-2\.md$/);

    const { filepath: fp3 } = await writeIdea(slug, "# Third\n");
    expect(fp3).toMatch(/test-slug-3\.md$/);
  });
});

// ── appendJournal ─────────────────────────────────────────────────────────────

describe("appendJournal", () => {
  beforeEach(clearFiles);

  it("creates Journal/date.md on first call", async () => {
    const md = "---\ndate: 2026-05-16\n---\n# Entry\n\n## Notes\n- one\n";
    const { filepath } = await appendJournal("2026-05-16", md);
    expect(filepath).toMatch(/Journal\/2026-05-16\.md$/);
    expect(_files.get(filepath)!.content).toBe(md);
  });

  it("appends with HH:MM heading on second call same day", async () => {
    const first = "---\ndate: 2026-05-16\n---\n# First entry\n\n## Notes\n- one\n";
    const second = "---\ndate: 2026-05-16\n---\n# Second entry\n\n## Notes\n- two\n";

    const { filepath } = await appendJournal("2026-05-16", first);
    await appendJournal("2026-05-16", second);

    const content = _files.get(filepath)!.content;
    expect(content).toContain("# First entry");
    expect(content).toContain("- one");
    expect(content).toContain("# Second entry");
    expect(content).toContain("- two");
    // Time heading present (HH:MM pattern)
    expect(content).toMatch(/## \d{2}:\d{2}/);
    // Only one frontmatter opening block — the second entry's frontmatter is stripped
    // The first entry has opening `---` and closing `---`, so exactly 2 `---` lines
    // but the date field appears only once
    expect(content.match(/^date:/gm)?.length).toBe(1);
  });

  it("preserves a second same-day entry's tags by merging them into the day file", async () => {
    // Regression: appendJournal strips the appended entry's frontmatter, so user
    // tags on a 2nd+ same-day capture were silently lost. The day file must end
    // up carrying the union of both entries' tags.
    const first = "---\ndate: 2026-05-16\ntags: [journal, morning]\n---\n# First\n\n## Notes\n- a\n";
    const second = "---\ndate: 2026-05-16\ntags: [journal, errand]\n---\n# Second\n\n## Notes\n- b\n";

    const { filepath } = await appendJournal("2026-05-16", first);
    await appendJournal("2026-05-16", second);

    const content = _files.get(filepath)!.content;
    // Union of both entries' tags, deduped, in a single inline flow array.
    expect(content).toContain("tags: [journal, morning, errand]");
    // Still exactly one frontmatter block.
    expect(content.match(/^date:/gm)?.length).toBe(1);
    // Both bodies present.
    expect(content).toContain("- a");
    expect(content).toContain("- b");
  });

  it("carries a 2nd same-day entry's location onto the day file (latest wins)", async () => {
    const first = "---\ndate: 2026-05-16\nlocation: 38.90000,-77.00000\n---\n# First\n\n## Notes\n- a\n";
    const second = "---\ndate: 2026-05-16\nlocation: 40.00000,-74.00000\n---\n# Second\n\n## Notes\n- b\n";

    const { filepath } = await appendJournal("2026-05-16", first);
    await appendJournal("2026-05-16", second);

    const content = _files.get(filepath)!.content;
    expect(content).toContain("location: 40.00000,-74.00000"); // latest same-day wins
    expect(content.match(/^location:/gm)?.length).toBe(1); // single frontmatter block
  });
});

// ── updateChecklistItem ───────────────────────────────────────────────────────

describe("updateChecklistItem", () => {
  beforeEach(clearFiles);

  it("toggles an unchecked line to checked", async () => {
    const original = "---\ndate: 2026-05-16\n---\n# Notes\n\n- [ ] buy milk\n- [ ] call home\n";
    const { filepath } = await appendJournal("2026-05-16", original);

    const result = await updateChecklistItem(filepath, "buy milk", false);
    expect(result).toEqual({ ok: true });

    const updated = _files.get(filepath)!.content;
    expect(updated).toContain("- [x] buy milk");
    expect(updated).toContain("- [ ] call home"); // unchanged
  });

  it("toggles a checked line to unchecked", async () => {
    const original = "---\ndate: 2026-05-16\n---\n# Notes\n\n- [x] buy milk\n- [ ] call home\n";
    const { filepath } = await appendJournal("2026-05-16", original);

    const result = await updateChecklistItem(filepath, "buy milk", true);
    expect(result).toEqual({ ok: true });

    const updated = _files.get(filepath)!.content;
    expect(updated).toContain("- [ ] buy milk");
    expect(updated).toContain("- [ ] call home"); // unchanged
  });

  it("returns not_found when the line doesn't exist", async () => {
    const original = "---\ndate: 2026-05-16\n---\n# Notes\n\n- [ ] buy milk\n";
    const { filepath } = await appendJournal("2026-05-16", original);

    const result = await updateChecklistItem(filepath, "nonexistent task", false);
    expect(result).toEqual({ ok: false, reason: "not_found" });

    // File should not be modified
    const content = _files.get(filepath)!.content;
    expect(content).toBe(original);
  });

  it("returns not_found when the line's state doesn't match expectedChecked", async () => {
    const original = "---\ndate: 2026-05-16\n---\n# Notes\n\n- [x] buy milk\n";
    const { filepath } = await appendJournal("2026-05-16", original);

    // Line is checked, but we're looking for an unchecked one
    const result = await updateChecklistItem(filepath, "buy milk", false);
    expect(result).toEqual({ ok: false, reason: "not_found" });

    // File should not be modified
    const content = _files.get(filepath)!.content;
    expect(content).toBe(original);
  });

  it("returns ambiguous when two identical lines exist", async () => {
    const original =
      "---\ndate: 2026-05-16\n---\n# Notes\n\n- [ ] buy milk\n- [ ] buy milk\n";
    const { filepath } = await appendJournal("2026-05-16", original);

    const result = await updateChecklistItem(filepath, "buy milk", false);
    expect(result).toEqual({ ok: false, reason: "ambiguous" });

    // File should not be modified
    const content = _files.get(filepath)!.content;
    expect(content).toBe(original);
  });

  it("preserves frontmatter and other content when toggling", async () => {
    const original =
      "---\ndate: 2026-05-16\ntags: [todo]\nstatus: active\n---\n# Notes\n\nSome intro text.\n\n- [ ] task 1\n- [x] task 2\n\nSome outro text.\n";
    const { filepath } = await appendJournal("2026-05-16", original);

    await updateChecklistItem(filepath, "task 1", false);

    const updated = _files.get(filepath)!.content;
    // Frontmatter preserved
    expect(updated).toContain("date: 2026-05-16");
    expect(updated).toContain("tags: [todo]");
    expect(updated).toContain("status: active");
    // Body text preserved
    expect(updated).toContain("Some intro text.");
    expect(updated).toContain("Some outro text.");
    // Task 1 toggled
    expect(updated).toContain("- [x] task 1");
    // Task 2 unchanged
    expect(updated).toContain("- [x] task 2");
  });

  it("handles indented checklist items", async () => {
    const original = "---\ndate: 2026-05-16\n---\n# Notes\n\n- [ ] parent task\n  - [ ] subtask\n";
    const { filepath } = await appendJournal("2026-05-16", original);

    const result = await updateChecklistItem(filepath, "subtask", false);
    expect(result).toEqual({ ok: true });

    const updated = _files.get(filepath)!.content;
    expect(updated).toContain("  - [x] subtask");
    expect(updated).toContain("- [ ] parent task"); // parent unchanged
  });

  it("serializes concurrent toggles on the same file", async () => {
    const original =
      "---\ndate: 2026-05-16\n---\n# Notes\n\n- [ ] task A\n- [ ] task B\n";
    const { filepath } = await appendJournal("2026-05-16", original);

    // Launch two concurrent updates
    const [result1, result2] = await Promise.all([
      updateChecklistItem(filepath, "task A", false),
      updateChecklistItem(filepath, "task B", false),
    ]);

    expect(result1).toEqual({ ok: true });
    expect(result2).toEqual({ ok: true });

    const final = _files.get(filepath)!.content;
    // Both tasks should be toggled
    expect(final).toContain("- [x] task A");
    expect(final).toContain("- [x] task B");
  });
});

// ── listNoteFiles (vault enumeration backing the tag index) ──────────────────

describe("listNoteFiles", () => {
  beforeEach(clearFiles);

  it("enumerates .md notes across Ideas/Journal/People with subdir + full uri", async () => {
    await writeIdea("my-idea", "# My Idea\n");
    await appendJournal("2026-05-16", "---\ndate: 2026-05-16\n---\n# Entry\n");
    await writePerson("Jane", "Doe", "---\nname: Jane Doe\n---\n# Jane Doe\n");

    const notes = await listNoteFiles();
    const byName = Object.fromEntries(notes.map((n) => [n.name, n.subdir]));
    expect(byName["my-idea.md"]).toBe("Ideas");
    expect(byName["2026-05-16.md"]).toBe("Journal");
    expect(byName["Jane-Doe.md"]).toBe("People");
    // Every URI is a full file:// path ending in the basename (readNote-ready).
    for (const n of notes) {
      expect(n.uri.startsWith("file://")).toBe(true);
      expect(n.uri.endsWith(`/${n.name}`)).toBe(true);
    }
  });

  it("excludes non-markdown files sitting in a note subdir", async () => {
    await writeIdea("keeper", "# Keeper\n");
    // Inject stray files directly into Ideas/ via the FS mock.
    _files.set("file:///data/carnet/Ideas/.DS_Store", { content: "junk" });
    _files.set("file:///data/carnet/Ideas/notes.txt", { content: "text" });

    const notes = await listNoteFiles();
    expect(notes.every((n) => n.name.toLowerCase().endsWith(".md"))).toBe(true);
    expect(notes.some((n) => n.name === "keeper.md")).toBe(true);
  });

  it("excludes Syncthing conflict copies; listSyncConflictFiles returns them instead", async () => {
    await writeIdea("note", "# Note\n");
    const conflictName = "note.sync-conflict-20260716-093012-ABC123X.md";
    _files.set(`file:///data/carnet/Ideas/${conflictName}`, { content: "# stale\n" });

    // Before this filter the copy was indexed as a regular note — visible in
    // Search and inflating tag counts.
    const notes = await listNoteFiles();
    expect(notes.some((n) => n.name === conflictName)).toBe(false);
    expect(notes.some((n) => n.name === "note.md")).toBe(true);

    const conflicts = await listSyncConflictFiles();
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({ name: conflictName, subdir: "Ideas" });
  });

  it("lists notes over a SAF (content://) vault, preserving document URIs", async () => {
    const ROOT = "content://auth/tree/primary%3ACarnet";
    const doc = (rel: string) =>
      `${ROOT}/document/primary%3ACarnet%2F${rel.split("/").join("%2F")}`;
    // content:// root → resolveRoot returns isSaf:true (one getSettings call).
    vi.mocked(getSettings).mockResolvedValueOnce({
      captureFolderPath: ROOT,
    } as unknown as Awaited<ReturnType<typeof getSettings>>);
    vi.mocked(FileSystem.StorageAccessFramework.readDirectoryAsync).mockImplementation(
      async (uri: string) => {
        if (uri === ROOT) return [doc("Ideas"), doc("Journal"), doc("People")];
        if (uri === doc("Ideas")) return [doc("Ideas/spark.md"), doc("Ideas/cover.png")];
        if (uri === doc("Journal")) return [doc("Journal/2026-05-16.md")];
        return [];
      },
    );

    const notes = await listNoteFiles();
    const byName = Object.fromEntries(notes.map((n) => [n.name, n]));
    expect(byName["cover.png"]).toBeUndefined(); // non-md excluded
    expect(byName["spark.md"].subdir).toBe("Ideas");
    expect(byName["spark.md"].uri).toBe(doc("Ideas/spark.md")); // full doc URI preserved
    expect(byName["2026-05-16.md"].subdir).toBe("Journal");

    vi.mocked(FileSystem.StorageAccessFramework.readDirectoryAsync).mockReset();
  });
});

// ── writePerson ───────────────────────────────────────────────────────────────

describe("writePerson", () => {
  beforeEach(clearFiles);

  it("creates People/Firstname-Lastname.md", async () => {
    const md = "---\nname: Jane Doe\n---\n# Jane Doe\n";
    const { filepath } = await writePerson("Jane", "Doe", md);
    expect(filepath).toMatch(/People\/Jane-Doe\.md$/);
    expect(_files.get(filepath)!.content).toBe(md);
  });

  it("falls back to markdown name when first/last are empty", async () => {
    const md = "---\nname: Alice Smith\n---\n# Alice Smith\n";
    const { filepath } = await writePerson("", "", md);
    expect(filepath).toMatch(/People\/Alice-Smith\.md$/);
  });

  it("appends -2 on collision instead of overwriting", async () => {
    // Two captures of the same person must NOT silently overwrite — Obsidian
    // may have desktop edits to the existing note that Syncthing already
    // replicated to the phone.
    const md1 = "---\nname: Jane Doe\n---\n# Jane Doe\n\noriginal\n";
    const md2 = "---\nname: Jane Doe\n---\n# Jane Doe\n\nsecond capture\n";

    const { filepath: fp1 } = await writePerson("Jane", "Doe", md1);
    expect(fp1).toMatch(/Jane-Doe\.md$/);

    const { filepath: fp2 } = await writePerson("Jane", "Doe", md2);
    expect(fp2).toMatch(/Jane-Doe-2\.md$/);

    // Original file should still contain the first capture, not the second
    expect(_files.get(fp1)!.content).toContain("original");
    expect(_files.get(fp2)!.content).toContain("second capture");
  });
});

// ── safLastSegment ────────────────────────────────────────────────────────────

describe("safLastSegment", () => {
  it("extracts the filename from a typical SAF document URI", () => {
    const uri =
      "content://com.android.externalstorage.documents/tree/primary%3ADownload%2FCarnet/document/primary%3ADownload%2FCarnet%2FIdeas%2Fmyidea.md";
    expect(safLastSegment(uri)).toBe("myidea.md");
  });

  it("extracts the leaf from a tree URI (no document segment)", () => {
    const uri =
      "content://com.android.externalstorage.documents/tree/primary%3ADownload%2FCarnet";
    expect(safLastSegment(uri)).toBe("Carnet");
  });

  it("handles a root-of-volume tree URI (no slash inside id)", () => {
    const uri =
      "content://com.android.externalstorage.documents/tree/primary%3ACarnet";
    expect(safLastSegment(uri)).toBe("Carnet");
  });

  it("does not split the URL authority's slashes", () => {
    // A naive decode-then-lastIndexOf would split on the //com.android slash
    // because decode preserves /. The marker-aware impl skips that.
    const uri =
      "content://some-authority-with/slashes/tree/primary%3AVault/document/primary%3AVault%2Fnote.md";
    expect(safLastSegment(uri)).toBe("note.md");
  });

  it("returns the input verbatim when no SAF marker is present", () => {
    expect(safLastSegment("file:///data/carnet/Ideas/foo.md")).toBe(
      "file:///data/carnet/Ideas/foo.md",
    );
  });
});

// ── writeBinary collision logic ───────────────────────────────────────────────

describe("writeBinary", () => {
  beforeEach(clearFiles);

  it("writes a single binary file to the chosen subdir with the given name", async () => {
    const { filepath, finalName } = await writeBinary(
      "Photos",
      "shot.jpg",
      "dGVzdA==",
      "image/jpeg",
    );
    expect(filepath).toMatch(/Photos\/shot\.jpg$/);
    expect(finalName).toBe("shot.jpg");
    expect(_files.has(filepath)).toBe(true);
    expect(_files.get(filepath)!.content).toBe("dGVzdA==");
  });

  it("bumps -2, -3 on collision, preserving the extension", async () => {
    const { finalName: n1 } = await writeBinary("Photos", "p.jpg", "AAA", "image/jpeg");
    const { finalName: n2 } = await writeBinary("Photos", "p.jpg", "BBB", "image/jpeg");
    const { finalName: n3 } = await writeBinary("Photos", "p.jpg", "CCC", "image/jpeg");
    expect(n1).toBe("p.jpg");
    expect(n2).toBe("p-2.jpg");
    expect(n3).toBe("p-3.jpg");
  });

  it("handles extensionless input by bumping the bare stem", async () => {
    const { finalName: n1 } = await writeBinary("Photos", "raw", "X", "application/octet-stream");
    const { finalName: n2 } = await writeBinary("Photos", "raw", "Y", "application/octet-stream");
    expect(n1).toBe("raw");
    expect(n2).toBe("raw-2");
  });

  it("returns the name SAF actually created when createFileAsync renames the file", async () => {
    // DocumentsContract appends the mime-canonical extension when the display
    // name doesn't end with it (observed on-device 2026-07-14: requested
    // `agenda-test.vnd.…document`, created `agenda-test.vnd.…document.docx`).
    // finalName is what gets linked in the note body, so it must reflect the
    // rename or the note<->file pairing silently breaks.
    const ROOT = "content://auth/tree/primary%3ACarnet";
    const doc = (rel: string) =>
      `${ROOT}/document/primary%3ACarnet%2F${rel.split("/").join("%2F")}`;
    vi.mocked(getSettings).mockResolvedValueOnce({
      captureFolderPath: ROOT,
    } as unknown as Awaited<ReturnType<typeof getSettings>>);
    const saf = FileSystem.StorageAccessFramework;
    vi.mocked(saf.readDirectoryAsync).mockImplementation(async (uri: string) => {
      if (uri === ROOT) return [doc("Files")];
      return []; // empty Files/ -> no collision bump
    });
    vi.mocked(saf.createFileAsync).mockImplementation(
      async (_dir: string, name: string) => doc(`Files/${name}.docx`),
    );
    vi.mocked(saf.writeAsStringAsync).mockResolvedValue(undefined as never);

    const { filepath, finalName } = await writeBinary(
      "Files",
      "report.vnd.openxmlformats-officedocument.wordprocessingml.document",
      "QUFB",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );

    expect(finalName).toBe(
      "report.vnd.openxmlformats-officedocument.wordprocessingml.document.docx",
    );
    expect(filepath).toBe(
      doc("Files/report.vnd.openxmlformats-officedocument.wordprocessingml.document.docx"),
    );

    vi.mocked(saf.readDirectoryAsync).mockReset();
    vi.mocked(saf.createFileAsync).mockReset();
    vi.mocked(saf.writeAsStringAsync).mockReset();
  });
});

describe("writeTextFile", () => {
  beforeEach(clearFiles);

  it("writes a UTF-8 source sidecar and collision-bumps instead of overwriting it", async () => {
    const first = await writeTextFile("processing/results", "cap_x.ocr.txt", "RAW OCR\n");
    const second = await writeTextFile("processing/results", "cap_x.ocr.txt", "second");
    expect(first.finalName).toBe("cap_x.ocr.txt");
    expect(second.finalName).toBe("cap_x.ocr-2.txt");
    expect(await readNote(first.filepath)).toBe("RAW OCR\n");
  });
});

// ── readNote / updateNote ─────────────────────────────────────────────────────

describe("readNote / updateNote", () => {
  beforeEach(clearFiles);

  it("round-trips content through readNote → updateNote → readNote", async () => {
    const { filepath } = await writeIdea("round-trip", "# Original\n");
    const original = await readNote(filepath);
    expect(original).toBe("# Original\n");

    await updateNote(filepath, "# Updated\n");
    const updated = await readNote(filepath);
    expect(updated).toBe("# Updated\n");
  });
});

// ── stripFrontmatter (exported helper used by RecentDetail render path) ──────

describe("stripFrontmatter", () => {
  it("removes a YAML frontmatter block at the head of the document", () => {
    const md = "---\nkind: idea\ntags: [a, b]\n---\n# Title\n\nbody\n";
    expect(stripFrontmatter(md)).toBe("# Title\n\nbody\n");
  });

  it("returns input unchanged when there is no frontmatter", () => {
    expect(stripFrontmatter("# Title\n\nbody\n")).toBe("# Title\n\nbody\n");
  });

  it("returns input unchanged on an unterminated frontmatter block", () => {
    const md = "---\nkind: idea\n\nno closing fence\n";
    expect(stripFrontmatter(md)).toBe(md);
  });
});

// ── splitFrontmatter (byte-exact header/body split for the WYSIWYG edit path) ─

describe("splitFrontmatter", () => {
  it("reassembles byte-for-byte: header + body === input", () => {
    const md = "---\nkind: idea\ntags: [a, b]\n---\n\n# Title\n\nbody\n";
    const { header, body } = splitFrontmatter(md);
    expect(header + body).toBe(md);
  });

  it("keeps the closing fence + its newline in the header (never merges into body)", () => {
    const md = "---\nkind: idea\n---\n\n# Title\n";
    const { header, body } = splitFrontmatter(md);
    expect(header).toBe("---\nkind: idea\n---\n");
    expect(header.endsWith("---\n")).toBe(true);
    expect(body).toBe("\n# Title\n");
  });

  it("returns empty header + whole input when there is no frontmatter", () => {
    const md = "# Title\n\nbody\n";
    expect(splitFrontmatter(md)).toEqual({ header: "", body: md });
  });

  it("treats an unterminated frontmatter block as no frontmatter", () => {
    const md = "---\nkind: idea\n\nno closing fence\n";
    expect(splitFrontmatter(md)).toEqual({ header: "", body: md });
  });

  it("handles a frontmatter-only note (empty body)", () => {
    const md = "---\nkind: idea\n---\n";
    const { header, body } = splitFrontmatter(md);
    expect(header).toBe(md);
    expect(body).toBe("");
    expect(header + body).toBe(md);
  });

  it("round-trips reattach with an editor-normalized body (no leading blank line)", () => {
    // Simulates the WYSIWYG save: the editor drops the blank line after the
    // fence; the header's trailing newline still keeps the fence on its own line.
    const md = "---\nkind: idea\n---\n\nold body\n";
    const { header } = splitFrontmatter(md);
    const reattached = header + "new body\n";
    expect(reattached).toBe("---\nkind: idea\n---\nnew body\n");
    expect(reattached.startsWith("---\nkind: idea\n---\n")).toBe(true);
  });
});

// ── moveToArchive (soft-delete) ──────────────────────────────────────────────

describe("moveToArchive", () => {
  beforeEach(clearFiles);

  it("archives a standalone idea note and removes the source", async () => {
    const { filepath } = await writeIdea("standalone", "# Standalone\n\nbody\n");
    expect(_files.has(filepath)).toBe(true);

    const { archivedMdPath, archivedBinaryPath } = await moveToArchive(filepath);
    expect(archivedMdPath).toMatch(/\/Archive\/standalone\.md$/);
    expect(archivedBinaryPath).toBeNull();
    // Source removed
    expect(_files.has(filepath)).toBe(false);
    // Archive copy contains the content
    expect(_files.get(archivedMdPath)!.content).toBe("# Standalone\n\nbody\n");
  });

  it("archives a note + its paired Audio binary (referenced via ../Audio/)", async () => {
    // Pre-populate the binary
    const { filepath: binPath } = await writeBinary(
      "Audio",
      "meeting.mp3",
      "QkFTRTY0",
      "audio/mpeg",
    );
    const md =
      "---\nkind: shared-audio\n---\n# Shared audio: meeting.mp3\n\n## File\n[meeting.mp3](../Audio/meeting.mp3)\n";
    const { filepath: mdPath } = await writeIdea("shared-audio-1", md);

    const result = await moveToArchive(mdPath);
    expect(result.archivedMdPath).toMatch(/\/Archive\/shared-audio-1\.md$/);
    expect(result.archivedBinaryPath).toMatch(/\/Archive\/meeting\.mp3$/);

    // Originals removed
    expect(_files.has(mdPath)).toBe(false);
    expect(_files.has(binPath)).toBe(false);
    // Archive binary copy preserved bytes
    expect(_files.get(result.archivedBinaryPath!)!.content).toBe("QkFTRTY0");
  });

  it("archives just the .md when the paired binary link is broken", async () => {
    // Note body references a binary that was never written
    const md =
      "---\nkind: shared-audio\n---\n# Lost\n\n## File\n[ghost.mp3](../Audio/ghost.mp3)\n";
    const { filepath: mdPath } = await writeIdea("orphan", md);

    const result = await moveToArchive(mdPath);
    expect(result.archivedMdPath).toMatch(/\/Archive\/orphan\.md$/);
    expect(result.archivedBinaryPath).toBeNull();
    expect(_files.has(mdPath)).toBe(false);
  });

  it("archives a SAF note under its decoded filename, not the URL-encoded document id", async () => {
    // Observed on-device 2026-07-16: archive-deleting a SAF-vault note landed
    // the .md in Archive/ as `primary%3Acarnet%2FIdeas%2Fpending-sync-test.md`
    // — the raw last URI segment is the encoded document id, not the filename.
    const ROOT = "content://auth/tree/primary%3Acarnet";
    const doc = (rel: string) =>
      `${ROOT}/document/primary%3Acarnet%2F${rel.split("/").join("%2F")}`;
    vi.mocked(getSettings).mockResolvedValueOnce({
      captureFolderPath: ROOT,
    } as unknown as Awaited<ReturnType<typeof getSettings>>);
    const saf = FileSystem.StorageAccessFramework;
    vi.mocked(saf.readDirectoryAsync).mockImplementation(async (uri: string) => {
      if (uri === ROOT) return [doc("Archive")];
      return []; // Archive/ empty → no collision bump
    });
    vi.mocked(saf.readAsStringAsync).mockResolvedValue(
      "---\nkind: shared-file\n---\n# T\n",
    );
    const createdNames: string[] = [];
    vi.mocked(saf.createFileAsync).mockImplementation(
      async (_dir: string, name: string) => {
        createdNames.push(name);
        return doc(`Archive/${name}`);
      },
    );
    vi.mocked(saf.writeAsStringAsync).mockResolvedValue(undefined as never);

    const { archivedMdPath } = await moveToArchive(
      doc("Ideas/pending-sync-test.md"),
    );

    expect(createdNames).toEqual(["pending-sync-test.md"]);
    expect(archivedMdPath).toBe(doc("Archive/pending-sync-test.md"));

    vi.mocked(saf.readDirectoryAsync).mockReset();
    vi.mocked(saf.readAsStringAsync).mockReset();
    vi.mocked(saf.createFileAsync).mockReset();
    vi.mocked(saf.writeAsStringAsync).mockReset();
  });

  it("collision-bumps the archive name when an entry with the same stem already exists there", async () => {
    const m1 = await writeIdea("dup", "# v1\n");
    await moveToArchive(m1.filepath);

    const m2 = await writeIdea("dup", "# v2\n");
    const result = await moveToArchive(m2.filepath);
    expect(result.archivedMdPath).toMatch(/\/Archive\/dup-2\.md$/);
    // First archive copy still intact
    expect(_files.get(result.archivedMdPath.replace("dup-2", "dup"))!.content).toBe("# v1\n");
  });

  it("archives ALL paired binaries when a note has several attachments", async () => {
    // A capture-with-attachments note: one image + one file, both on disk.
    const { filepath: imgPath } = await writeBinary(
      "Photos",
      "sketch.jpg",
      "SU1H",
      "image/jpeg",
    );
    const { filepath: pdfPath } = await writeBinary(
      "Files",
      "spec.pdf",
      "UERG",
      "application/pdf",
    );
    const md =
      "---\nkind: idea\n---\n# Multi\n\n![](../Photos/sketch.jpg)\n\n## Files\n[spec.pdf](../Files/spec.pdf)\n";
    const { filepath: mdPath } = await writeIdea("multi", md);

    const result = await moveToArchive(mdPath);
    // Both binaries archived; archivedBinaryPath keeps the first for back-compat.
    expect(result.archivedBinaryPaths).toHaveLength(2);
    expect(result.archivedBinaryPath).toMatch(/\/Archive\/sketch\.jpg$/);
    expect(result.archivedBinaryPaths.some((p) => /\/Archive\/spec\.pdf$/.test(p))).toBe(true);
    // Originals (md + both binaries) removed.
    expect(_files.has(mdPath)).toBe(false);
    expect(_files.has(imgPath)).toBe(false);
    expect(_files.has(pdfPath)).toBe(false);
    // Bytes preserved in the archive copies.
    expect(_files.get(result.archivedBinaryPath!)!.content).toBe("SU1H");
  });

  it("collision-bumps when two paired binaries would land on the same Archive name", async () => {
    // Same filename in two subdirs → both want Archive/a.jpg; the second must
    // bump. Guards the "await each write before re-listing the dir" invariant.
    await writeBinary("Photos", "a.jpg", "UEhP", "image/jpeg");
    await writeBinary("Files", "a.jpg", "RklM", "image/jpeg");
    const md =
      "---\nkind: idea\n---\n# Dup names\n\n![](../Photos/a.jpg)\n\n## Files\n[a.jpg](../Files/a.jpg)\n";
    const { filepath: mdPath } = await writeIdea("dupnames", md);

    const result = await moveToArchive(mdPath);
    expect(result.archivedBinaryPaths).toHaveLength(2);
    // Two distinct archive names: a.jpg and a-2.jpg.
    const names = result.archivedBinaryPaths.map((p) => p.split("/").pop()).sort();
    expect(names).toEqual(["a-2.jpg", "a.jpg"]);
  });
});

// ── extractFrontmatterField (exported for the retro-enrich routing key) ──────

describe("extractFrontmatterField", () => {
  it("reads a simple ASCII value", () => {
    const md = "---\nkind: shared-image\n---\n# T\n";
    expect(extractFrontmatterField(md, "kind")).toBe("shared-image");
  });

  it("returns null when the field is absent", () => {
    const md = "---\nkind: photo\n---\n# T\n";
    expect(extractFrontmatterField(md, "source")).toBeNull();
  });

  it("returns null when there is no frontmatter", () => {
    expect(extractFrontmatterField("# T\n\nbody\n", "kind")).toBeNull();
  });

  it("strips surrounding single and double quotes", () => {
    const md1 = "---\nkind: 'shared-link'\n---\n# T\n";
    expect(extractFrontmatterField(md1, "kind")).toBe("shared-link");
    const md2 = '---\nkind: "shared-text"\n---\n# T\n';
    expect(extractFrontmatterField(md2, "kind")).toBe("shared-text");
  });
});

