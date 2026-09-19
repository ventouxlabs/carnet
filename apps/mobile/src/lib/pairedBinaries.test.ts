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
  listPairedBinaries,
  stripPairedBinaryLinks,
  resolvePairedUri,
  readPairedBinaryFromNote,
} from "./pairedBinaries";
// writeBinary lives in writer.ts (the WRITE side of the paired-binary
// convention) — used here only to set up on-disk fixtures for the readers
// under test.
import { writeBinary } from "./writer";
import * as FileSystem from "expo-file-system/legacy";
import { resolveProfileRoot } from "./vaultRoot";

// ── Helpers ───────────────────────────────────────────────────────────────────

function clearFiles(): void {
  _files.clear();
}

// ── listPairedBinaries ────────────────────────────────────────────────────────

describe("listPairedBinaries", () => {
  it("returns an empty array when there are no paired-binary links", () => {
    expect(listPairedBinaries("# T\n\nplain prose only\n")).toEqual([]);
  });

  it("finds Photos, Audio, and Files links with subdir + filename + rel", () => {
    const body =
      "# T\n\n![](../Photos/a.jpg)\n\n## Files\n[s.pdf](../Files/s.pdf)\n\n[m.mp3](../Audio/m.mp3)\n";
    const found = listPairedBinaries(body);
    expect(found).toEqual([
      { subdir: "Photos", filename: "a.jpg", rel: "../Photos/a.jpg" },
      { subdir: "Files", filename: "s.pdf", rel: "../Files/s.pdf" },
      { subdir: "Audio", filename: "m.mp3", rel: "../Audio/m.mp3" },
    ]);
  });

  it("de-duplicates a link that appears more than once", () => {
    const body =
      "![](../Photos/a.jpg)\n\nsee [the image](../Photos/a.jpg) again\n";
    expect(listPairedBinaries(body)).toHaveLength(1);
  });
});

// ── stripPairedBinaryLinks (RecentDetail display) ────────────────────────────

describe("stripPairedBinaryLinks", () => {
  it("removes a standalone image embed but keeps the prose", () => {
    const body = "# T\n\n![](../Photos/shot.jpg)\n\nWhat's in this.\n";
    expect(stripPairedBinaryLinks(body)).toBe("# T\n\nWhat's in this.\n");
  });

  it("removes a file link AND its now-empty ## File heading (shared-audio)", () => {
    const body =
      "# Shared audio: m.mp3\n\n## File\n[m.mp3](../Audio/m.mp3)\n\n## Context\n(none)\n";
    expect(stripPairedBinaryLinks(body)).toBe(
      "# Shared audio: m.mp3\n\n## Context\n(none)\n",
    );
  });

  it("removes a ## Files section that only held attachment links", () => {
    const body =
      "# T\n\n![](../Photos/a.jpg)\n\nbody text\n\n## Files\n[spec.pdf](../Files/spec.pdf)\n";
    expect(stripPairedBinaryLinks(body)).toBe("# T\n\nbody text\n");
  });

  it("leaves an inline link inside a sentence intact", () => {
    const body = "# T\n\nsee [the file](../Files/x.pdf) for details\n";
    expect(stripPairedBinaryLinks(body)).toBe(body);
  });

  it("is a no-op for a note with no paired binaries", () => {
    const body = "# T\n\njust prose\n\n## Notes\n- a\n- b\n";
    expect(stripPairedBinaryLinks(body)).toBe(body);
  });

  // keepImages: the detail view leaves `../Photos/` embeds in the prose so they
  // render INLINE via the custom markdown image rule, while Audio + Files are
  // still pulled out (player / files card).
  it("keepImages: keeps a Photos embed but still strips Audio", () => {
    const body =
      "# T\n\n![](../Photos/shot.jpg)\n\nprose\n\n[m.mp3](../Audio/m.mp3)\n";
    expect(stripPairedBinaryLinks(body, { keepImages: true })).toBe(
      "# T\n\n![](../Photos/shot.jpg)\n\nprose\n",
    );
  });

  it("keepImages: keeps a Photos embed but strips a ## Files section", () => {
    const body =
      "# T\n\n![](../Photos/a.jpg)\n\nbody\n\n## Files\n[spec.pdf](../Files/spec.pdf)\n";
    expect(stripPairedBinaryLinks(body, { keepImages: true })).toBe(
      "# T\n\n![](../Photos/a.jpg)\n\nbody\n",
    );
  });

  it("keepImages: preserves an image's caption title in the embed", () => {
    const body = '# T\n\n![alt](../Photos/a.jpg "a caption")\n\nbody\n';
    expect(stripPairedBinaryLinks(body, { keepImages: true })).toBe(body);
  });
});

// ── readPairedBinaryFromNote (retro-enrich helper) ───────────────────────────

describe("readPairedBinaryFromNote", () => {
  beforeEach(clearFiles);

  it("finds and returns the paired image bytes for a photo note", async () => {
    await writeBinary("Photos", "shot.jpg", "QkFTRTY0", "image/jpeg");
    const md = "---\nkind: photo\n---\n# T\n\n![](../Photos/shot.jpg)\n";
    const result = await readPairedBinaryFromNote(md);
    expect(result.base64).toBe("QkFTRTY0");
    expect(result.mime).toBe("image/jpeg");
  });

  it("works for shared-image notes the same way (subdir is Photos)", async () => {
    await writeBinary("Photos", "shared.png", "UE5HQllURVM=", "image/png");
    const md =
      "---\nkind: shared-image\n---\n# Shared\n\n![](../Photos/shared.png)\n";
    const result = await readPairedBinaryFromNote(md);
    expect(result.base64).toBe("UE5HQllURVM=");
    expect(result.mime).toBe("image/png");
  });

  it("reads a same-named audio binary from the pinned vault, not another active vault", async () => {
    const rootA = resolveProfileRoot({ rootUri: "file:///vault-a" });
    const rootB = resolveProfileRoot({ rootUri: "file:///vault-b" });
    await writeBinary("Audio", "clip.m4a", "QV9CWVRFUw==", "audio/mp4", rootA);
    await writeBinary("Audio", "clip.m4a", "Ql9CWVRFUw==", "audio/mp4", rootB);
    const md = "# Audio\n\n[clip.m4a](../Audio/clip.m4a)\n";

    await expect(readPairedBinaryFromNote(md, rootA)).resolves.toMatchObject({
      base64: "QV9CWVRFUw==",
    });
  });

  it("throws when the body contains no recognized paired-binary link", async () => {
    const md = "---\nkind: idea\n---\n# Title\n\nplain body text\n";
    await expect(readPairedBinaryFromNote(md)).rejects.toThrow(
      "No paired binary link found",
    );
  });

  it("throws when the link target doesn't exist on disk", async () => {
    const md = "---\nkind: photo\n---\n# T\n\n![](../Photos/ghost.jpg)\n";
    await expect(readPairedBinaryFromNote(md)).rejects.toThrow(
      "Paired binary not found",
    );
  });
});

// ── resolvePairedUri ──────────────────────────────────────────────────────────

describe("resolvePairedUri", () => {
  beforeEach(clearFiles);

  it("returns the URI + inferred mime for a binary that exists on disk", async () => {
    await writeBinary("Files", "spec.pdf", "UERG", "application/pdf");
    const resolved = await resolvePairedUri("Files", "spec.pdf");
    expect(resolved).not.toBeNull();
    expect(resolved!.uri).toMatch(/Files\/spec\.pdf$/);
    expect(resolved!.mime).toBe("application/pdf");
  });

  it("returns null for a link whose target is not on disk", async () => {
    expect(await resolvePairedUri("Photos", "ghost.jpg")).toBeNull();
  });

  it("does not create the subdirectory when resolving a broken link", async () => {
    // A read-only resolve of a link into a non-existent subdir must NOT make
    // the directory (a pure lookup shouldn't litter the vault with empty dirs).
    const mkdir = vi.mocked(FileSystem.makeDirectoryAsync);
    mkdir.mockClear();

    expect(await resolvePairedUri("Photos", "ghost.jpg")).toBeNull();

    expect(mkdir).not.toHaveBeenCalled();
  });
});
