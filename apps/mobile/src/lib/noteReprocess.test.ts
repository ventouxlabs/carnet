// Copyright (C) 2025 Ventoux Advisory, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./writer", async () => {
  // The real pure splicers, so the assertions on the written body are
  // meaningful — a stand-in that puts the embed on top would hide exactly the
  // frontmatter ordering these tests pin.
  const md = await vi.importActual<typeof import("./writerMarkdown")>("./writerMarkdown");
  return {
    readPairedBinaryFromNote: vi.fn(),
    updateNote: vi.fn(async () => {}),
    injectImageEmbed: md.injectImageEmbed,
    upsertSection: md.upsertSection,
  };
});
vi.mock("./dispatcher", () => ({
  enrichSharedImage: vi.fn(),
  transcribeAudio: vi.fn(),
}));

import { findPairedLink, reEnrichNote, transcribeNote } from "./noteReprocess";
import { readPairedBinaryFromNote, updateNote } from "./writer";
import { enrichSharedImage, transcribeAudio } from "./dispatcher";
import { extractFrontmatterField, getFrontmatterTags, splitFrontmatter } from "./frontmatter";

const mockRead = vi.mocked(readPairedBinaryFromNote);
const mockUpdateNote = vi.mocked(updateNote);
const mockEnrich = vi.mocked(enrichSharedImage);
const mockTranscribe = vi.mocked(transcribeAudio);

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("findPairedLink", () => {
  it("extracts the filename for the requested subdir", () => {
    const body = "# T\n\n![](../Photos/pic-01.jpg)\n";
    expect(findPairedLink(body, "Photos")).toBe("pic-01.jpg");
    expect(findPairedLink(body, "Audio")).toBeNull();
  });

  it("captures only up to the next slash (the filename class rejects '/')", () => {
    // Faithful to writer's link regex: the capture stops at the slash, so a
    // crafted `../Photos/../secret` yields just `..`, never the traversal tail.
    expect(findPairedLink("[x](../Photos/../secret)", "Photos")).toBe("..");
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
    expect(mockUpdateNote).toHaveBeenCalledWith("f.md", out.kind === "updated" && out.nextBody);
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
    const out = await reEnrichNote({ body: PHOTO_NOTE, filepath: "f.md" });
    if (out.kind !== "updated") throw new Error(`expected updated, got ${JSON.stringify(out)}`);
    expect(mockUpdateNote).toHaveBeenCalledWith("f.md", out.nextBody);
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
    const out = await reEnrichNote({
      body: "# T\n\n![](../Photos/p.jpg)\n",
      filepath: "f.md",
    });
    expect(out).toEqual({ kind: "failed", reason: "LLM down" });
    expect(mockUpdateNote).not.toHaveBeenCalled();
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
