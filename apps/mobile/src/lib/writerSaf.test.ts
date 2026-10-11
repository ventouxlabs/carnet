import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * SAF (Storage Access Framework) test-parity suite.
 *
 * writer.ts has two storage backends selected by whether Settings.captureFolderPath
 * is a content://...tree/... URI (see resolveRoot in writer.ts). PRODUCTION runs the
 * SAF branch — every real install picks a SAF folder via the document picker — but
 * writer.test.ts almost exclusively exercises the file:// branch (empty
 * captureFolderPath), with only 3 bespoke SAF tests. Both writer bugs shipped this
 * month (9171376, c896d9d) were SAF-branch-only. This file mirrors writer.test.ts's
 * core behavior families against a REUSABLE in-memory SAF mock so the two backends
 * get comparable coverage.
 *
 * The harness below models the two SAF quirks that actually bit us in production:
 *   1. readDirectoryAsync returns full document URIs, never basenames — callers
 *      must run them through safLastSegment (writer.ts already does this; the mock
 *      would silently paper over a regression if it returned basenames instead).
 *   2. createFileAsync may RENAME the file: DocumentsContract appends the mime's
 *      canonical extension when the requested display name doesn't already end
 *      with it. This is the root cause of 9171376 (writeBinary's finalName
 *      contract) — the mock reproduces it for the mime types writer.ts actually
 *      creates files with.
 */

// vi.mock factories are hoisted above ordinary const/function declarations in this
// file, so everything the factories close over must live inside vi.hoisted().
const {
  SAF_ROOT,
  SAF_CANONICAL_EXT,
  _saf,
  safRelPath,
  safUri,
  safParent,
  safChildRelPath,
  assertSafDisplayName,
  clearSaf,
} = vi.hoisted(() => {
    const SAF_AUTHORITY = "com.android.externalstorage.documents";
    const TREE_ID = "primary:Carnet";
    const SAF_ROOT = `content://${SAF_AUTHORITY}/tree/${encodeURIComponent(TREE_ID)}`;

    type SafEntry = { kind: "file"; content: string } | { kind: "dir" };
    const _saf: Map<string, SafEntry> = new Map();

    /** Mime types DocumentsContract enforces a canonical extension for. Real
     * Android appends the system-registered extension for ANY well-known mime
     * whose display name lacks it, so this covers every mime writeBinary can
     * receive from the share/capture paths (mirrors writer.ts extFromMime /
     * mimeFromFilename), not just the ones current tests use — a narrower
     * allowlist would let a future test pass against the mock while real SAF
     * renames the file and breaks note↔file pairing (the 9171376 class).
     * "application/octet-stream" is deliberately absent: no registered
     * extension, real SAF leaves the name alone. */
    const SAF_CANONICAL_EXT: Record<string, string> = {
      "text/markdown": ".md",
      "text/plain": ".txt",
      "text/csv": ".csv",
      "image/jpeg": ".jpg",
      "image/png": ".png",
      "image/webp": ".webp",
      "image/gif": ".gif",
      "image/heic": ".heic",
      "audio/mpeg": ".mp3",
      "audio/mp4": ".m4a",
      "audio/wav": ".wav",
      "application/pdf": ".pdf",
      "application/zip": ".zip",
      "application/json": ".json",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
    };

    function safRelPath(uri: string): string {
      if (uri === SAF_ROOT) return "";
      const marker = "/document/";
      const idx = uri.indexOf(marker);
      if (idx < 0) throw new Error(`Not a SAF document URI: ${uri}`);
      const decoded = decodeURIComponent(uri.slice(idx + marker.length));
      return decoded === TREE_ID ? "" : decoded.slice(TREE_ID.length + 1);
    }

    function safUri(relPath: string): string {
      if (relPath === "") return SAF_ROOT;
      const id = `${TREE_ID}/${relPath}`;
      return `${SAF_ROOT}/document/${encodeURIComponent(id)}`;
    }

    function safParent(relPath: string): string {
      const slash = relPath.lastIndexOf("/");
      return slash < 0 ? "" : relPath.slice(0, slash);
    }

    function safChildRelPath(parentRelPath: string, name: string): string {
      return parentRelPath ? `${parentRelPath}/${name}` : name;
    }

    /**
     * Real SAF takes a DISPLAY NAME, never a path: makeDirectoryAsync and
     * createFileAsync each create exactly ONE child node and never walk "/"
     * segments. This mock stores into a FLAT map, so without this guard a name
     * like "processing/results" becomes one legal key and reads back fine —
     * which is precisely how a production bug (nested capture dirs silently
     * failing on content:// vaults) stayed invisible behind a green suite.
     * Keep this strict; loosening it re-blinds the SAF branch.
     */
    function assertSafDisplayName(name: string, api: string): void {
      if (name.includes("/")) {
        throw new Error(
          `[saf-mock] ${api} received a path, not a display name: "${name}". ` +
            "Real SAF creates one node per call — walk the segments instead.",
        );
      }
    }

    function clearSaf(): void {
      _saf.clear();
    }

    return {
      SAF_ROOT,
      SAF_CANONICAL_EXT,
      _saf,
      safRelPath,
      safUri,
      safParent,
      safChildRelPath,
      assertSafDisplayName,
      clearSaf,
    };
  });

// Mock ./settings so every resolveRoot() call in this file picks the SAF branch —
// this file's whole point is exercising that branch, unlike writer.test.ts where
// SAF is the exception.
vi.mock("./settings", () => ({
  getSettings: vi.fn().mockResolvedValue({
    omniRouteUrl: "",
    omniRouteApiKey: "",
    omniRouteModel: "",
    captureFolderPath: SAF_ROOT,
  }),
}));

vi.mock("expo-file-system/legacy", () => {
  return {
    documentDirectory: "file:///data/",
    EncodingType: { UTF8: "utf8", Base64: "base64" },
    // The SAF branch never calls these directly — getModificationTime
    // short-circuits to null for any content:// URI before reaching getInfoAsync —
    // but they're stubbed so the module loads without a real native binding.
    getInfoAsync: vi.fn(async () => ({ exists: false, isDirectory: false })),
    makeDirectoryAsync: vi.fn(),
    readDirectoryAsync: vi.fn(),
    readAsStringAsync: vi.fn(),
    writeAsStringAsync: vi.fn(),
    deleteAsync: vi.fn(),
    StorageAccessFramework: {
      readDirectoryAsync: vi.fn(async (parentUri: string): Promise<string[]> => {
        const parentRel = safRelPath(parentUri);
        const out: string[] = [];
        for (const relPath of _saf.keys()) {
          if (safParent(relPath) === parentRel) out.push(safUri(relPath));
        }
        return out;
      }),
      makeDirectoryAsync: vi.fn(async (parentUri: string, name: string): Promise<string> => {
        assertSafDisplayName(name, "makeDirectoryAsync");
        const relPath = safChildRelPath(safRelPath(parentUri), name);
        if (!_saf.has(relPath)) _saf.set(relPath, { kind: "dir" });
        return safUri(relPath);
      }),
      createFileAsync: vi.fn(
        async (parentUri: string, displayName: string, mimeType: string): Promise<string> => {
          assertSafDisplayName(displayName, "createFileAsync");
          const canonicalExt = SAF_CANONICAL_EXT[mimeType];
          const finalName =
            canonicalExt && !displayName.toLowerCase().endsWith(canonicalExt)
              ? `${displayName}${canonicalExt}`
              : displayName;
          const relPath = safChildRelPath(safRelPath(parentUri), finalName);
          _saf.set(relPath, { kind: "file", content: "" });
          return safUri(relPath);
        },
      ),
      readAsStringAsync: vi.fn(async (uri: string): Promise<string> => {
        const entry = _saf.get(safRelPath(uri));
        if (!entry || entry.kind !== "file") throw new Error(`SAF file not found: ${uri}`);
        return entry.content;
      }),
      writeAsStringAsync: vi.fn(async (uri: string, content: string): Promise<void> => {
        const relPath = safRelPath(uri);
        const entry = _saf.get(relPath);
        if (!entry || entry.kind !== "file") {
          throw new Error(`SAF write to missing file: ${uri}`);
        }
        entry.content = content;
      }),
      deleteAsync: vi.fn(async (uri: string): Promise<void> => {
        _saf.delete(safRelPath(uri));
      }),
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
  updateNoteIfUnchanged,
  moveToArchive,
  listNoteFiles,
  listSyncConflictFiles,
  safLastSegment,
} from "./writer";
import { vaultFsFor } from "./vaultFs";
import * as FileSystem from "expo-file-system/legacy";

const saf = FileSystem.StorageAccessFramework;

function nameOf(uri: string): string {
  return safLastSegment(uri);
}

// ── harness sanity ────────────────────────────────────────────────────────────

describe("SAF harness sanity", () => {
  beforeEach(() => {
    clearSaf();
    vi.clearAllMocks();
  });

  it("readDirectoryAsync returns full content:// document URIs, not basenames", async () => {
    const { filepath } = await writeIdea("harness-check", "# T\n");
    expect(filepath.startsWith("content://")).toBe(true);

    const children = await saf.readDirectoryAsync(safUri("Ideas"));
    expect(children).toEqual([filepath]);
    // Guard against a regression that would make the mock (and thus the tests
    // built on it) silently accept basenames — the real API never does.
    expect(children[0]).not.toBe("harness-check.md");
  });
});

// ── writeIdea ─────────────────────────────────────────────────────────────────

describe("writeIdea (SAF)", () => {
  beforeEach(() => {
    clearSaf();
    vi.clearAllMocks();
  });

  it("creates Ideas/slug.md in an empty SAF vault", async () => {
    const { filepath } = await writeIdea("my-idea", "# My Idea\n\nbody\n");
    expect(nameOf(filepath)).toBe("my-idea.md");
    await expect(readNote(filepath)).resolves.toBe("# My Idea\n\nbody\n");
  });

  it("appends -2 on collision, -3 on second collision", async () => {
    const { filepath: fp1 } = await writeIdea("test-slug", "# First\n");
    const { filepath: fp2 } = await writeIdea("test-slug", "# Second\n");
    const { filepath: fp3 } = await writeIdea("test-slug", "# Third\n");
    expect(nameOf(fp1)).toBe("test-slug.md");
    expect(nameOf(fp2)).toBe("test-slug-2.md");
    expect(nameOf(fp3)).toBe("test-slug-3.md");
  });
});

// ── updateNoteIfUnchanged (SAF divergence) ────────────────────────────────────

describe("updateNoteIfUnchanged (SAF)", () => {
  beforeEach(() => {
    clearSaf();
    vi.clearAllMocks();
  });

  it("the MTIME baseline alone is inert over content:// — a stale one still overwrites", async () => {
    // Backend-divergent by design (writer.ts getModificationTime returns null
    // for content://): an mtime baseline can never be compared over SAF, so it
    // alone detects nothing. Pin that here so the content baseline below is
    // understood as the thing actually carrying the guard on this backend.
    const { filepath } = await writeIdea("guarded", "# v1\n");
    const staleBaseline = 12345; // any non-null baseline
    const result = await updateNoteIfUnchanged(filepath, "# v2\n", staleBaseline);
    expect(result).toEqual({ ok: true });
    await expect(readNote(filepath)).resolves.toBe("# v2\n");
  });

  it("writes when the CONTENT baseline still matches the file on disk", async () => {
    const { filepath } = await writeIdea("guarded", "# v1\n");
    const result = await updateNoteIfUnchanged(filepath, "# v2\n", null, "# v1\n");
    expect(result).toEqual({ ok: true });
    await expect(readNote(filepath)).resolves.toBe("# v2\n");
  });

  it("skips the write and reports conflict when the content changed under it", async () => {
    // The whole point of the content fallback: SAF is the NORMAL Android /
    // Syncthing vault, so before this the enrich-window guard was dead code
    // exactly where the vault is shared with a workstation. A stale enrichment
    // could silently overwrite an edit made during the model call.
    const { filepath } = await writeIdea("guarded", "# v1\n");
    await updateNote(filepath, "# Workstation edit\n");
    const result = await updateNoteIfUnchanged(filepath, "# Enriched\n", null, "# v1\n");
    expect(result).toEqual({ ok: false, reason: "conflict" });
    await expect(readNote(filepath)).resolves.toBe("# Workstation edit\n");
  });

  it("proceeds when neither baseline is available", async () => {
    const { filepath } = await writeIdea("guarded", "# v1\n");
    const result = await updateNoteIfUnchanged(filepath, "# Forced\n", null, null);
    expect(result).toEqual({ ok: true });
    await expect(readNote(filepath)).resolves.toBe("# Forced\n");
  });

  it("uses known content even when a supplied mtime is unavailable", async () => {
    const { filepath } = await writeIdea("guarded", "# v1\n");
    const result = await updateNoteIfUnchanged(filepath, "# v2\n", 12345, "# stale\n");
    expect(result).toEqual({ ok: false, reason: "conflict" });
    await expect(readNote(filepath)).resolves.toBe("# v1\n");
  });

  it("refuses a guarded write when the SAF note cannot be read", async () => {
    const { filepath } = await writeIdea("guarded", "# v1\n");
    vi.mocked(FileSystem.StorageAccessFramework.readAsStringAsync).mockRejectedValueOnce(new Error("Permission revoked"));
    const write = vi.mocked(FileSystem.StorageAccessFramework.writeAsStringAsync);
    write.mockClear();
    const result = await updateNoteIfUnchanged(filepath, "# v2\n", null, "# v1\n");
    expect(result).toEqual({ ok: false, reason: "conflict" });
    expect(write).not.toHaveBeenCalled();
  });
});

// ── writePerson ───────────────────────────────────────────────────────────────

describe("writePerson (SAF)", () => {
  beforeEach(() => {
    clearSaf();
    vi.clearAllMocks();
  });

  it("writes People/First-Last.md and collision-bumps a second card", async () => {
    const md = "---\nkind: person\n---\n# Ada Lovelace\n";
    const { filepath: fp1 } = await writePerson("Ada", "Lovelace", md);
    const { filepath: fp2 } = await writePerson("Ada", "Lovelace", md);
    expect(nameOf(fp1)).toBe("Ada-Lovelace.md");
    expect(nameOf(fp2)).toBe("Ada-Lovelace-2.md");
  });
});

// ── appendJournal ─────────────────────────────────────────────────────────────

describe("appendJournal (SAF)", () => {
  beforeEach(() => {
    clearSaf();
    vi.clearAllMocks();
  });

  it("creates Journal/date.md on first call", async () => {
    const md = "---\ndate: 2026-05-16\n---\n# Entry\n\n## Notes\n- one\n";
    const { filepath } = await appendJournal("2026-05-16", md);
    expect(nameOf(filepath)).toBe("2026-05-16.md");
    await expect(readNote(filepath)).resolves.toBe(md);
  });

  it("appends with HH:MM heading on second call same day", async () => {
    const first = "---\ndate: 2026-05-16\n---\n# First entry\n\n## Notes\n- one\n";
    const second = "---\ndate: 2026-05-16\n---\n# Second entry\n\n## Notes\n- two\n";

    const { filepath } = await appendJournal("2026-05-16", first);
    await appendJournal("2026-05-16", second);

    const content = await readNote(filepath);
    expect(content).toContain("# First entry");
    expect(content).toContain("# Second entry");
    expect(content).toMatch(/## \d{2}:\d{2}/);
    expect(content.match(/^date:/gm)?.length).toBe(1);
  });

  it("merges a second same-day entry's tags into the day file", async () => {
    const first = "---\ndate: 2026-05-16\ntags: [journal, morning]\n---\n# First\n\n## Notes\n- a\n";
    const second = "---\ndate: 2026-05-16\ntags: [journal, errand]\n---\n# Second\n\n## Notes\n- b\n";

    const { filepath } = await appendJournal("2026-05-16", first);
    await appendJournal("2026-05-16", second);

    const content = await readNote(filepath);
    expect(content).toContain("tags: [journal, morning, errand]");
    expect(content.match(/^date:/gm)?.length).toBe(1);
  });

  it("carries a 2nd same-day entry's location onto the day file (latest wins)", async () => {
    const first = "---\ndate: 2026-05-16\nlocation: 38.90000,-77.00000\n---\n# First\n\n## Notes\n- a\n";
    const second = "---\ndate: 2026-05-16\nlocation: 40.00000,-74.00000\n---\n# Second\n\n## Notes\n- b\n";

    const { filepath } = await appendJournal("2026-05-16", first);
    await appendJournal("2026-05-16", second);

    const content = await readNote(filepath);
    expect(content).toContain("location: 40.00000,-74.00000");
    expect(content.match(/^location:/gm)?.length).toBe(1);
  });

  it("returns the day file's full accumulated markdown, not just the new fragment", async () => {
    // Callers (the tag index) index off the returned markdown, not the just-written
    // fragment — a SAF-branch regression here would silently drop earlier same-day
    // tags from the index without any write-path test catching it.
    const first = "---\ndate: 2026-05-16\ntags: [a]\n---\n# First\n\nbody\n";
    const second = "---\ndate: 2026-05-16\ntags: [b]\n---\n# Second\n\nbody\n";
    await appendJournal("2026-05-16", first);
    const { markdown } = await appendJournal("2026-05-16", second);
    expect(markdown).toContain("# First");
    expect(markdown).toContain("# Second");
    expect(markdown).toContain("tags: [a, b]");
  });

  it("serializes two concurrent same-day appends so neither clobbers the other", async () => {
    // The offline drain can process two journal entries for the same day
    // back-to-back; serialize() in writer.ts must queue the second read-then-write
    // behind the first even over the SAF backend's IPC round-trips.
    const first = "---\ndate: 2026-05-16\n---\n# Alpha\n\nalpha body\n";
    const second = "---\ndate: 2026-05-16\n---\n# Beta\n\nbeta body\n";

    const [r1] = await Promise.all([
      appendJournal("2026-05-16", first),
      appendJournal("2026-05-16", second),
    ]);

    const content = await readNote(r1.filepath);
    expect(content).toContain("# Alpha");
    expect(content).toContain("# Beta");
    // Both entries landed exactly once — no lost update.
    expect(content.match(/# Alpha/g)?.length).toBe(1);
    expect(content.match(/# Beta/g)?.length).toBe(1);
  });
});

// ── writeBinary ───────────────────────────────────────────────────────────────

describe("writeBinary (SAF)", () => {
  beforeEach(() => {
    clearSaf();
    vi.clearAllMocks();
  });

  it("writes a binary whose display name already carries the canonical extension unchanged", async () => {
    const { filepath, finalName } = await writeBinary("Photos", "shot.jpg", "dGVzdA==", "image/jpeg");
    expect(finalName).toBe("shot.jpg");
    expect(nameOf(filepath)).toBe("shot.jpg");
    await expect(readNote(filepath)).resolves.toBe("dGVzdA==");
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

  it("returns the SAF-renamed finalName when createFileAsync appends the mime's canonical extension", async () => {
    // The 9171376 regression: DocumentsContract appended ".docx" to a display name
    // that didn't already end with it. finalName is what gets linked in the note
    // body, so it must reflect the rename or the note<->file pairing breaks.
    const { filepath, finalName } = await writeBinary(
      "Files",
      "report.vnd.openxmlformats-officedocument.wordprocessingml.document",
      "QUFB",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );
    expect(finalName).toBe(
      "report.vnd.openxmlformats-officedocument.wordprocessingml.document.docx",
    );
    expect(nameOf(filepath)).toBe(finalName);
  });

  it("auto-creates the subdir on first write into a fresh SAF folder", async () => {
    expect(await saf.readDirectoryAsync(SAF_ROOT)).toEqual([]);
    await writeBinary("Photos", "first.jpg", "AAA", "image/jpeg");
    const rootChildren = await saf.readDirectoryAsync(SAF_ROOT);
    expect(rootChildren.map(nameOf)).toContain("Photos");
  });

  it("keeps identically-named binaries in different subdirs independent (no cross-dir collision)", async () => {
    const { finalName: photoName } = await writeBinary("Photos", "dup.jpg", "AAA", "image/jpeg");
    const { finalName: fileName } = await writeBinary("Files", "dup.jpg", "BBB", "image/jpeg");
    expect(photoName).toBe("dup.jpg");
    expect(fileName).toBe("dup.jpg");
  });
});

describe("writeTextFile (SAF)", () => {
  beforeEach(() => {
    clearSaf();
    vi.clearAllMocks();
  });

  it("writes raw OCR sidecars with a portable collision-safe filename", async () => {
    const first = await writeTextFile("processing/results", "cap_x.ocr.txt", "RAW OCR\n");
    const second = await writeTextFile("processing/results", "cap_x.ocr.txt", "second");
    expect(first.finalName).toBe("cap_x.ocr.txt");
    expect(second.finalName).toBe("cap_x.ocr-2.txt");
    await expect(readNote(first.filepath)).resolves.toBe("RAW OCR\n");
  });
});

// Regression: mdcrm capture packages are the first caller to pass a NESTED
// subdir. SAF's makeDirectoryAsync creates one node per call (no
// `intermediates: true`), so the whole path used to be handed over as a single
// display name and the capture silently never landed on a content:// vault.
describe("nested subdirs (SAF)", () => {
  beforeEach(() => {
    clearSaf();
    vi.clearAllMocks();
  });

  it("resolves an existing nested subdir through findSubdir", async () => {
    // findSubdir is the READ-side twin of findOrCreateSubdir and carried the
    // same single-segment assumption: it compared the whole "a/b" against each
    // child's last segment, which can never match. Callers saw "missing" and
    // reported a broken link instead of resolving the file.
    await writeBinary("attachments/originals", "att_a.jpg", "YWJj", "image/jpeg");

    const uri = await vaultFsFor(true).findSubdir(SAF_ROOT, "attachments/originals");
    expect(uri).not.toBeNull();
  });

  it("returns null from findSubdir when an intermediate segment is missing", async () => {
    expect(await vaultFsFor(true).findSubdir(SAF_ROOT, "attachments/originals")).toBeNull();
  });

  it("writes a .md capture record without SAF appending a second extension", async () => {
    // SAF's createFileAsync appends the canonical extension for the MIME type
    // it is handed. writeTextFile used to hardcode text/plain, so the capture
    // record landed as `cap_x.md.txt` — which mdcrm's walkMarkdown (*.md only)
    // never discovers, silently defeating the whole capture pipeline.
    const { finalName, filepath } = await writeTextFile(
      "captures",
      "cap_x.md",
      "---\ntype: capture\n---\n\n# Capture\n",
    );

    expect(finalName).toBe("cap_x.md");
    await expect(readNote(filepath)).resolves.toContain("type: capture");
  });

  it("still writes a .txt sidecar as plain text without doubling its extension", async () => {
    const { finalName } = await writeTextFile("processing/results", "cap_x.ocr.txt", "RAW\n");
    expect(finalName).toBe("cap_x.ocr.txt");
  });

  it("creates every segment of a nested subdir as its own directory node", async () => {
    const { filepath } = await writeTextFile("processing/results", "cap_y.ocr.txt", "RAW\n");

    // The intermediate must be a real node, not half of one slash-named folder.
    expect(_saf.get("processing")).toEqual({ kind: "dir" });
    expect(_saf.get("processing/results")).toEqual({ kind: "dir" });
    await expect(readNote(filepath)).resolves.toBe("RAW\n");
  });

  it("creates the nested attachment path a capture package writes its original into", async () => {
    await writeBinary("attachments/originals", "att_z.jpg", "YWJj", "image/jpeg");

    expect(_saf.get("attachments")).toEqual({ kind: "dir" });
    expect(_saf.get("attachments/originals")).toEqual({ kind: "dir" });
  });

  it("reuses existing segments instead of duplicating them across calls", async () => {
    await writeTextFile("processing/results", "one.txt", "1");
    await writeTextFile("processing/results", "two.txt", "2");

    const dirs = [..._saf.entries()].filter(([, entry]) => entry.kind === "dir").map(([rel]) => rel);
    expect(dirs.sort()).toEqual(["processing", "processing/results"]);
  });

  it("tolerates a redundant leading or doubled slash without creating empty nodes", async () => {
    await writeTextFile("/processing//results", "three.txt", "3");

    const dirs = [..._saf.entries()].filter(([, entry]) => entry.kind === "dir").map(([rel]) => rel);
    expect(dirs.sort()).toEqual(["processing", "processing/results"]);
  });
});

// ── readNote / updateNote ─────────────────────────────────────────────────────

describe("readNote / updateNote (SAF)", () => {
  beforeEach(() => {
    clearSaf();
    vi.clearAllMocks();
  });

  it("round-trips content through readNote → updateNote → readNote over a SAF URI", async () => {
    const { filepath } = await writeIdea("round-trip", "# Original\n");
    expect(filepath.startsWith("content://")).toBe(true);

    await expect(readNote(filepath)).resolves.toBe("# Original\n");
    await updateNote(filepath, "# Updated\n");
    await expect(readNote(filepath)).resolves.toBe("# Updated\n");
  });
});

// ── listNoteFiles ─────────────────────────────────────────────────────────────

describe("listNoteFiles (SAF)", () => {
  beforeEach(() => {
    clearSaf();
    vi.clearAllMocks();
  });

  it("enumerates .md notes across Ideas/Journal/People with subdir + full SAF document URI", async () => {
    await writeIdea("my-idea", "# My Idea\n");
    await appendJournal("2026-05-16", "---\ndate: 2026-05-16\n---\n# Entry\n");
    await writePerson("Jane", "Doe", "---\nname: Jane Doe\n---\n# Jane Doe\n");

    const notes = await listNoteFiles();
    const byName = Object.fromEntries(notes.map((n) => [n.name, n]));
    expect(byName["my-idea.md"].subdir).toBe("Ideas");
    expect(byName["2026-05-16.md"].subdir).toBe("Journal");
    expect(byName["Jane-Doe.md"].subdir).toBe("People");
    for (const n of notes) {
      expect(n.uri.startsWith("content://")).toBe(true);
      expect(nameOf(n.uri)).toBe(n.name);
    }
  });

  it("excludes non-markdown files sitting in a note subdir", async () => {
    await writeIdea("keeper", "# Keeper\n");
    await writeBinary("Ideas", "cover.png", "AAA", "image/png");

    const notes = await listNoteFiles();
    expect(notes.every((n) => n.name.toLowerCase().endsWith(".md"))).toBe(true);
    expect(notes.some((n) => n.name === "keeper.md")).toBe(true);
    expect(notes.some((n) => n.name === "cover.png")).toBe(false);
  });

  it("excludes Syncthing conflict copies; listSyncConflictFiles returns them", async () => {
    await writeIdea("note", "# Note\n");
    const conflictName = "note.sync-conflict-20260716-093012-ABC123X.md";
    _saf.set(`Ideas/${conflictName}`, { kind: "file", content: "# stale\n" });

    const notes = await listNoteFiles();
    expect(notes.some((n) => n.name === conflictName)).toBe(false);
    expect(notes.some((n) => n.name === "note.md")).toBe(true);

    const conflicts = await listSyncConflictFiles();
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].name).toBe(conflictName);
    expect(conflicts[0].uri.startsWith("content://")).toBe(true);
  });
});

// ── moveToArchive (soft-delete) ───────────────────────────────────────────────

describe("moveToArchive (SAF)", () => {
  beforeEach(() => {
    clearSaf();
    vi.clearAllMocks();
  });

  it("archives a standalone idea note and removes the source", async () => {
    const { filepath } = await writeIdea("standalone", "# Standalone\n\nbody\n");

    const { archivedMdPath, archivedBinaryPath } = await moveToArchive(filepath);
    expect(nameOf(archivedMdPath)).toBe("standalone.md");
    expect(archivedBinaryPath).toBeNull();
    await expect(readNote(filepath)).rejects.toThrow();
    await expect(readNote(archivedMdPath)).resolves.toBe("# Standalone\n\nbody\n");
  });

  it("archives a note under its decoded filename, not the URL-encoded document id", async () => {
    // Observed on-device 2026-07-16: the raw last URI segment on a SAF document is
    // the URL-encoded document id, not the filename — archiving verbatim produced
    // Archive/primary%3Acarnet%2FIdeas%2Fnote.md. safLastSegment must be used.
    const { filepath } = await writeIdea("pending-sync-test", "# T\n");
    const { archivedMdPath } = await moveToArchive(filepath);
    // The archive copy's display name must be the decoded filename — not the raw
    // URL-encoded document id verbatim (which is what the pre-fix bug produced).
    expect(nameOf(archivedMdPath)).toBe("pending-sync-test.md");
    expect(nameOf(archivedMdPath)).not.toContain("%2F");
    expect(nameOf(archivedMdPath)).not.toContain("%3A");
  });

  it("archives a note + its paired Audio binary", async () => {
    const { filepath: binPath } = await writeBinary("Audio", "meeting.mp3", "QkFTRTY0", "audio/mpeg");
    const md =
      "---\nkind: shared-audio\n---\n# Shared audio: meeting.mp3\n\n## File\n[meeting.mp3](../Audio/meeting.mp3)\n";
    const { filepath: mdPath } = await writeIdea("shared-audio-1", md);

    const result = await moveToArchive(mdPath);
    expect(nameOf(result.archivedMdPath)).toBe("shared-audio-1.md");
    expect(nameOf(result.archivedBinaryPath!)).toBe("meeting.mp3");
    await expect(readNote(mdPath)).rejects.toThrow();
    await expect(readNote(binPath)).rejects.toThrow();
    await expect(readNote(result.archivedBinaryPath!)).resolves.toBe("QkFTRTY0");
  });

  it("archives just the .md when the paired binary link is broken", async () => {
    const md = "---\nkind: shared-audio\n---\n# Lost\n\n## File\n[ghost.mp3](../Audio/ghost.mp3)\n";
    const { filepath: mdPath } = await writeIdea("orphan", md);

    const result = await moveToArchive(mdPath);
    expect(nameOf(result.archivedMdPath)).toBe("orphan.md");
    expect(result.archivedBinaryPath).toBeNull();
    await expect(readNote(mdPath)).rejects.toThrow();
  });

  it("collision-bumps the archive name when an entry with the same stem already exists there", async () => {
    const m1 = await writeIdea("dup", "# v1\n");
    await moveToArchive(m1.filepath);

    const m2 = await writeIdea("dup", "# v2\n");
    const result = await moveToArchive(m2.filepath);
    expect(nameOf(result.archivedMdPath)).toBe("dup-2.md");
  });

  it("archives ALL paired binaries when a note has several attachments", async () => {
    const { filepath: imgPath } = await writeBinary("Photos", "sketch.jpg", "SU1H", "image/jpeg");
    const { filepath: pdfPath } = await writeBinary("Files", "spec.pdf", "UERG", "application/pdf");
    const md =
      "---\nkind: idea\n---\n# Multi\n\n![](../Photos/sketch.jpg)\n\n## Files\n[spec.pdf](../Files/spec.pdf)\n";
    const { filepath: mdPath } = await writeIdea("multi", md);

    const result = await moveToArchive(mdPath);
    expect(result.archivedBinaryPaths).toHaveLength(2);
    expect(result.archivedBinaryPaths.map(nameOf).sort()).toEqual(["sketch.jpg", "spec.pdf"]);
    await expect(readNote(imgPath)).rejects.toThrow();
    await expect(readNote(pdfPath)).rejects.toThrow();
  });

  it("collision-bumps when two paired binaries would land on the same Archive name", async () => {
    await writeBinary("Photos", "a.jpg", "UEhP", "image/jpeg");
    await writeBinary("Files", "a.jpg", "RklM", "image/jpeg");
    const md =
      "---\nkind: idea\n---\n# Dup names\n\n![](../Photos/a.jpg)\n\n## Files\n[a.jpg](../Files/a.jpg)\n";
    const { filepath: mdPath } = await writeIdea("dupnames", md);

    const result = await moveToArchive(mdPath);
    expect(result.archivedBinaryPaths.map(nameOf).sort()).toEqual(["a-2.jpg", "a.jpg"]);
  });

  it("swallows a delete failure on the original (revoked SAF permission) and still returns archived paths", async () => {
    // deleteByUri's SAF branch is NOT idempotent — it throws on a revoked tree
    // permission or an already-gone file. moveToArchive's jsdoc guarantees the
    // archive copy is treated as canonical and the failure is swallowed.
    const { filepath } = await writeIdea("stranded", "# Stranded\n\nbody\n");
    vi.mocked(saf.deleteAsync).mockImplementationOnce(async () => {
      throw new Error("Permission denied: tree access revoked");
    });

    const { archivedMdPath } = await moveToArchive(filepath);
    expect(nameOf(archivedMdPath)).toBe("stranded.md");
    await expect(readNote(archivedMdPath)).resolves.toBe("# Stranded\n\nbody\n");
    // The original was never actually removed since deleteAsync threw.
    await expect(readNote(filepath)).resolves.toBe("# Stranded\n\nbody\n");
  });
});
