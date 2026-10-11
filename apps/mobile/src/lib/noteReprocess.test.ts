// Copyright (C) 2025 Ventoux Advisory, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from "vitest";

const disk = vi.hoisted(() => new Map<string, { content: string; mtime: number }>());
vi.mock("./settings", () => ({
  getSettings: vi.fn(async () => ({ captureFolderPath: "file:///vault-a" })),
}));
vi.mock("expo-file-system/legacy", () => ({
  documentDirectory: "file:///data/",
  EncodingType: { UTF8: "utf8", Base64: "base64" },
  StorageAccessFramework: {
    readAsStringAsync: vi.fn(async (uri: string) => {
      const file = disk.get(uri);
      if (!file) throw new Error("Note unavailable");
      return file.content;
    }),
    writeAsStringAsync: vi.fn(async (uri: string, content: string) => {
      disk.set(uri, { content, mtime: (disk.get(uri)?.mtime ?? 0) + 1 });
    }),
  },
  getInfoAsync: vi.fn(async (uri: string) => {
    const file = disk.get(uri);
    return file ? { exists: true, modificationTime: file.mtime } : { exists: false };
  }),
  readAsStringAsync: vi.fn(async (uri: string) => {
    const file = disk.get(uri);
    if (!file) throw new Error("Note unavailable");
    return file.content;
  }),
  writeAsStringAsync: vi.fn(async (uri: string, content: string) => {
    disk.set(uri, { content, mtime: (disk.get(uri)?.mtime ?? 0) + 1 });
  }),
}));
vi.mock("./writer", async () => {
  const actual = await vi.importActual<typeof import("./writer")>("./writer");
  return {
    ...actual,
    readPairedBinaryFromNote: vi.fn(),
    updateNote: vi.fn(actual.updateNote),
    updateNoteIfUnchanged: vi.fn(actual.updateNoteIfUnchanged),
  };
});
vi.mock("./dispatcher", () => ({
  enrichSharedImage: vi.fn(),
  transcribeAudio: vi.fn(),
}));

import { findPairedLink, reEnrichNote, transcribeNote } from "./noteReprocess";
import { readPairedBinaryFromNote, updateNote, updateNoteIfUnchanged } from "./writer";
import { enrichSharedImage, transcribeAudio } from "./dispatcher";
import { extractFrontmatterField, getFrontmatterTags, splitFrontmatter } from "./frontmatter";

const mockRead = vi.mocked(readPairedBinaryFromNote);
const mockGuardedUpdate = vi.mocked(updateNoteIfUnchanged);
const mockUpdateNote = vi.mocked(updateNote);
const mockEnrich = vi.mocked(enrichSharedImage);
const mockTranscribe = vi.mocked(transcribeAudio);

beforeEach(() => {
  vi.clearAllMocks();
  disk.clear();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("findPairedLink", () => {
  it.each(["![](<../Photos/a photo (1).jpg>)", "![](../Photos/a photo (1).jpg)"])("reads full names from %s", (body) => {
    expect(findPairedLink(body, "Photos")).toBe("a photo (1).jpg");
  });

  it("extracts the filename for the requested subdir", () => {
    const body = "# T\n\n![](../Photos/pic-01.jpg)\n";
    expect(findPairedLink(body, "Photos")).toBe("pic-01.jpg");
    expect(findPairedLink(body, "Audio")).toBeNull();
  });

  it("rejects traversal rather than returning a partial filename", () => {
    expect(findPairedLink("[x](../Photos/../secret)", "Photos")).toBeNull();
  });

  it("returns null when the subdir link is absent", () => {
    expect(findPairedLink("# no binaries here\n", "Photos")).toBeNull();
  });
});

describe("reEnrichNote", () => {
  it("re-enriches, re-injects the image embed, writes, and returns the new body", async () => {
    mockRead.mockResolvedValue({ base64: "AAA", mime: "image/jpeg" });
    mockEnrich.mockResolvedValue({ markdown: "# Fresh\n\nNew text.\n" } as never);
    const body = "# Old\n\n![](../Photos/pic.jpg)\n";
    const root = { uri: "file:///vault-a", fs: {} } as never;
    const vaultContext = { profileId: "a", rootUri: "file:///vault-a" };
    disk.set("f.md", { content: body, mtime: 1000 });
    const out = await reEnrichNote({ body, filepath: "f.md", rootOverride: root, vaultContext });
    expect(mockRead).toHaveBeenCalledWith(body, root);
    expect(mockEnrich).toHaveBeenCalledWith(
      { base64: "AAA", mimeType: "image/jpeg", context: "" },
      { vaultContext },
    );
    expect(out).toEqual({
      kind: "updated",
      nextBody: "# Fresh\n\n![](../Photos/pic.jpg)\n\nNew text.\n",
    });
    expect(mockGuardedUpdate).toHaveBeenCalledWith("f.md", out.kind === "updated" && out.nextBody, 1000, body);
  });

  it.each([
    ["file:// mtime", "file:///vault-a/Ideas/photo.md", 1001],
    ["file:// same mtime", "file:///vault-a/Ideas/photo.md", 1000],
    ["SAF content", "content://vault/photo.md", 1001],
  ])("keeps an intervening edit during enrichment (%s)", async (_label, filepath, editMtime) => {
    const body = "# Old\n\n![](../Photos/pic.jpg)\n";
    disk.set(filepath, { content: body, mtime: 1000 });
    mockRead.mockResolvedValue({ base64: "AAA", mime: "image/jpeg" });
    let reply!: (value: { markdown: string }) => void;
    let started!: () => void;
    const dispatched = new Promise<void>((resolve) => { started = resolve; });
    mockEnrich.mockImplementation(() => {
      started();
      return new Promise((resolve) => { reply = resolve as typeof reply; });
    });
    const pending = reEnrichNote({ body, filepath });
    await dispatched;
    disk.set(filepath, { content: "# Workstation edit\n", mtime: editMtime });
    reply({ markdown: "# Fresh\n" });
    const out = await pending;
    expect(out).toEqual({ kind: "failed", reason: expect.stringMatching(/changed.*kept/i) });
    expect(disk.get(filepath)?.content).toBe("# Workstation edit\n");
    expect(mockUpdateNote).not.toHaveBeenCalled();
  });

  it.each(["file:///vault-a/photo.md", "content://vault/photo.md"])(
    "does not recreate a note deleted during enrichment (%s)", async (filepath) => {
      const body = "# Old\n\n![](../Photos/pic.jpg)\n";
      disk.set(filepath, { content: body, mtime: 1000 });
      mockRead.mockResolvedValue({ base64: "AAA", mime: "image/jpeg" });
      mockEnrich.mockImplementation(async () => {
        disk.delete(filepath);
        return { markdown: "# Fresh\n" } as never;
      });
      const out = await reEnrichNote({ body, filepath });
      expect(out.kind).toBe("failed");
      expect(disk.has(filepath)).toBe(false);
    },
  );

  it("uses current disk fields, tags and image instead of a stale screen snapshot", async () => {
    const filepath = "content://vault/photo.md";
    const body = "---\ncreated: 2026-10-11\ntags: [current]\nproject: disk\n---\n# Current\n\n![](../Photos/current.jpg)\n";
    disk.set(filepath, { content: body, mtime: 1000 });
    mockRead.mockResolvedValue({ base64: "AAA", mime: "image/jpeg" });
    mockEnrich.mockResolvedValue({ markdown: "# Fresh\n" } as never);
    const out = await reEnrichNote({ body: "# Stale\n![](../Photos/stale.jpg)\n", filepath });
    expect(mockRead).toHaveBeenCalledWith(body, expect.objectContaining({ uri: "file:///vault-a" }));
    expect(out.kind).toBe("updated");
    if (out.kind !== "updated") throw new Error("expected updated");
    expect(out.nextBody).toContain("../Photos/current.jpg");
    expect(extractFrontmatterField(out.nextBody, "project")).toBe("disk");
    expect(getFrontmatterTags(out.nextBody)).toContain("current");
    expect(disk.get(filepath)?.content).toBe(out.nextBody);
  });

  it("keeps raw disk bytes as the SAF baseline while repairing legacy embeds", async () => {
    const filepath = "content://vault/photo.md";
    const raw = "![](../Photos/pic.jpg)\n\n---\ncreated: 2026-10-11\ntags: [garden]\nlocation: 1,2\n---\nOld caption\n";
    disk.set(filepath, { content: raw, mtime: 1000 });
    mockRead.mockResolvedValue({ base64: "AAA", mime: "image/jpeg" });
    mockEnrich.mockResolvedValue({ markdown: "# Fresh\n" } as never);
    const out = await reEnrichNote({ body: raw, filepath });
    expect(out.kind).toBe("updated");
    if (out.kind !== "updated") throw new Error("expected updated");
    expect(mockGuardedUpdate).toHaveBeenCalledWith(filepath, out.nextBody, null, raw);
    expect(getFrontmatterTags(out.nextBody)).toContain("garden");
    expect(extractFrontmatterField(out.nextBody, "location")).toBe("1,2");
  });

  it("fails before dispatch when the note cannot be read", async () => {
    const out = await reEnrichNote({ body: "![](../Photos/pic.jpg)", filepath: "missing.md" });
    expect(out.kind).toBe("failed");
    expect(mockEnrich).not.toHaveBeenCalled();
    expect(disk.has("missing.md")).toBe(false);
  });

  it("pins binary reads to the operation's vault context", async () => {
    const body = "# Current\n\n![](../Photos/pic.jpg)\n";
    const filepath = "file:///vault-b/photo.md";
    const vaultContext = { profileId: "b", rootUri: "file:///vault-b" };
    disk.set(filepath, { content: body, mtime: 1000 });
    mockRead.mockResolvedValue({ base64: "BBB", mime: "image/jpeg" });
    mockEnrich.mockResolvedValue({ markdown: "# Fresh\n" } as never);
    const out = await reEnrichNote({ body, filepath, vaultContext });
    expect(out.kind).toBe("updated");
    expect(mockRead).toHaveBeenCalledWith(body, expect.objectContaining({ uri: "file:///vault-b" }));
    expect(mockEnrich).toHaveBeenCalledWith(expect.anything(), { vaultContext });
  });

  it("refuses when the current disk note has no image despite the screen snapshot", async () => {
    disk.set("f.md", { content: "# Image removed\n", mtime: 1000 });
    const out = await reEnrichNote({ body: "![](../Photos/stale.jpg)", filepath: "f.md" });
    expect(out).toEqual({ kind: "failed", reason: expect.stringMatching(/No paired image/) });
    expect(mockRead).not.toHaveBeenCalled();
    expect(mockEnrich).not.toHaveBeenCalled();
    expect(mockGuardedUpdate).not.toHaveBeenCalled();
  });

  it("preserves original creation while retaining fresh reply markers", async () => {
    const body = "---\ncreated: \"2026-09-01T08:30:00Z\"\nfallback: old-provider\nenhanced: old-enhancement\n---\n# Old\n\n![](../Photos/pic.jpg)\n";
    disk.set("f.md", { content: body, mtime: 1000 });
    mockRead.mockResolvedValue({ base64: "AAA", mime: "image/jpeg" });
    mockEnrich.mockResolvedValue({ markdown: "---\ncreated: 2026-10-11\nfallback: fresh-provider\n---\n# Fresh\n" } as never);
    const out = await reEnrichNote({ body, filepath: "f.md" });
    expect(out.kind).toBe("updated");
    if (out.kind !== "updated") throw new Error("expected updated");
    expect(out.nextBody).toContain('created: "2026-09-01T08:30:00Z"');
    expect(extractFrontmatterField(out.nextBody, "fallback")).toBe("fresh-provider");
    expect(extractFrontmatterField(out.nextBody, "enhanced")).toBeNull();
  });

  // A photo note's frontmatter holds things the vision prompt never sees: where
  // it was taken, the Karakeep bookmark it was exported to, hand-added fields,
  // and the user's own tags. Losing karakeepId means the next "Send to
  // Karakeep" creates a duplicate bookmark instead of updating the first.
  const PHOTO_NOTE =
    "---\ncreated: 2026-09-01\nkind: screenshot\ntags: [garden, ferns]\n" +
    "location: 48.85660, 2.35220\nkarakeepId: kk_123\nproject: allotment\n---\n" +
    "# Old\n\n![](../Photos/pic.jpg)\n\nOld text.\n";

  async function reEnrichPhotoNoteWith(reply: string): Promise<string> {
    mockRead.mockResolvedValue({ base64: "AAA", mime: "image/jpeg" });
    mockEnrich.mockResolvedValue({ markdown: reply } as never);
    disk.set("f.md", { content: PHOTO_NOTE, mtime: 1000 });
    const out = await reEnrichNote({ body: PHOTO_NOTE, filepath: "f.md" });
    if (out.kind !== "updated") throw new Error(`expected updated, got ${JSON.stringify(out)}`);
    expect(mockGuardedUpdate).toHaveBeenCalledWith("f.md", out.nextBody, 1000, PHOTO_NOTE);
    return out.nextBody;
  }

  it("keeps the note's own frontmatter fields the model's reply lacks", async () => {
    const next = await reEnrichPhotoNoteWith(
      "---\ncreated: 2026-10-02\nkind: photo\ntags: [plants]\n---\n# Fresh\n\nNew text.\n",
    );
    expect(extractFrontmatterField(next, "location")).toBe("48.85660, 2.35220");
    expect(extractFrontmatterField(next, "karakeepId")).toBe("kk_123");
    expect(extractFrontmatterField(next, "project")).toBe("allotment");
    // The model's own fresh tags are merged with the user's, not replaced.
    expect([...getFrontmatterTags(next)].sort()).toEqual(["ferns", "garden", "plants"]);
    // A value the model did provide beats the carried one.
    expect(extractFrontmatterField(next, "kind")).toBe("photo");
    expect(splitFrontmatter(next).body).toBe("# Fresh\n\n![](../Photos/pic.jpg)\n\nNew text.\n");
  });

  it("keeps the frontmatter and puts the embed below it when the reply has no H1", async () => {
    const next = await reEnrichPhotoNoteWith(
      "---\ncreated: 2026-10-02\nkind: photo\ntags: []\n---\nJust a caption.\n",
    );
    expect(next.startsWith("---\n")).toBe(true);
    expect(extractFrontmatterField(next, "karakeepId")).toBe("kk_123");
    expect(extractFrontmatterField(next, "location")).toBe("48.85660, 2.35220");
    expect([...getFrontmatterTags(next)].sort()).toEqual(["ferns", "garden"]);
    expect(splitFrontmatter(next).body).toBe("![](../Photos/pic.jpg)\n\nJust a caption.\n");
  });

  it("clears the markers that described the OLD reply", async () => {
    // `fallback` names the provider that wrote the previous reply (re-enrich is
    // how the "via relais" chip goes away) and `enhanced` vouches for a body
    // this reply replaced. Neither may ride along onto the fresh one.
    mockRead.mockResolvedValue({ base64: "AAA", mime: "image/jpeg" });
    mockEnrich.mockResolvedValue({
      markdown: "---\ncreated: 2026-10-02\nkind: photo\ntags: []\n---\n# Fresh\n",
    } as never);
    const body = PHOTO_NOTE.replace("project:", "fallback: relais\nenhanced: 2026-09-20\nproject:");
    disk.set("f.md", { content: body, mtime: 1000 });
    const out = await reEnrichNote({ body, filepath: "f.md" });
    if (out.kind !== "updated") throw new Error("expected updated");
    expect(extractFrontmatterField(out.nextBody, "fallback")).toBeNull();
    expect(extractFrontmatterField(out.nextBody, "enhanced")).toBeNull();
    expect(extractFrontmatterField(out.nextBody, "project")).toBe("allotment");
  });

  it("does not double the embed when the model echoes it", async () => {
    const next = await reEnrichPhotoNoteWith(
      "---\ncreated: 2026-10-02\nkind: photo\ntags: []\n---\n# Fresh\n\n![](../Photos/pic.jpg)\n\nNew text.\n",
    );
    expect(next.split("![](../Photos/pic.jpg)")).toHaveLength(2);
    expect(extractFrontmatterField(next, "karakeepId")).toBe("kk_123");
  });

  it("fails cleanly when there is no paired image (no read, no write)", async () => {
    disk.set("f.md", { content: "# No image\n", mtime: 1000 });
    const out = await reEnrichNote({ body: "# No image\n", filepath: "f.md" });
    expect(out.kind).toBe("failed");
    if (out.kind !== "failed") throw new Error("unreachable");
    expect(out.reason).toMatch(/No paired image/);
    expect(mockRead).not.toHaveBeenCalled();
    expect(mockUpdateNote).not.toHaveBeenCalled();
  });

  it("surfaces an enrichment error as failed", async () => {
    mockRead.mockResolvedValue({ base64: "AAA", mime: "image/jpeg" });
    mockEnrich.mockRejectedValue(new Error("LLM down"));
    disk.set("f.md", { content: "# T\n\n![](../Photos/p.jpg)\n", mtime: 1000 });
    const out = await reEnrichNote({
      body: "# T\n\n![](../Photos/p.jpg)\n",
      filepath: "f.md",
    });
    expect(out).toEqual({ kind: "failed", reason: "LLM down" });
    expect(mockUpdateNote).not.toHaveBeenCalled();
    expect(mockGuardedUpdate).not.toHaveBeenCalled();
    expect(disk.get("f.md")?.content).toBe("# T\n\n![](../Photos/p.jpg)\n");
  });
});

describe("transcribeNote", () => {
  it("transcribes, upserts a Transcript section, writes, and returns the new body", async () => {
    mockRead.mockResolvedValue({ base64: "BBB", mime: "audio/m4a" });
    mockTranscribe.mockResolvedValue({ text: "hello world", model: "on-device" });
    const body = "# Voice\n\n[audio](../Audio/rec.m4a)\n";
    const root = { uri: "file:///vault-a", fs: {} } as never;
    const out = await transcribeNote({ body, filepath: "f.md", rootOverride: root });
    expect(mockRead).toHaveBeenCalledWith(body, root);
    expect(mockTranscribe).toHaveBeenCalledWith({
      base64: "BBB",
      mimeType: "audio/m4a",
      filename: "rec.m4a",
    });
    expect(out.kind).toBe("updated");
    if (out.kind !== "updated") throw new Error("unreachable");
    expect(out.nextBody).toContain("## Transcript");
    expect(out.nextBody).toContain("hello world");
    expect(mockUpdateNote).toHaveBeenCalledWith("f.md", out.nextBody);
  });

  it("fails cleanly when there is no paired audio", async () => {
    const out = await transcribeNote({ body: "# No audio\n", filepath: "f.md" });
    expect(out.kind).toBe("failed");
    if (out.kind !== "failed") throw new Error("unreachable");
    expect(out.reason).toMatch(/No paired audio/);
    expect(mockUpdateNote).not.toHaveBeenCalled();
  });
});
