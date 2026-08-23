// Copyright (C) 2025 Ventoux Advisory, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from "vitest";

// Real (pure) frontmatter + @carnet/shared deriveTitle so the field-derivation
// assertions exercise real parsing. Only the network client, asset push, inline
// rewrite, and the disk write are mocked so every branch is drivable.
vi.mock("./writer", () => ({ updateNote: vi.fn(async () => {}) }));
vi.mock("./karakeep", () => ({
  createTextBookmark: vi.fn(),
  updateTextBookmark: vi.fn(),
  attachTags: vi.fn(async () => {}),
  KarakeepError: class KarakeepError extends Error {
    status: number;
    constructor(message: string, status: number) {
      super(message);
      this.name = "KarakeepError";
      this.status = status;
    }
  },
}));
vi.mock("./karakeepExport", () => ({
  pushNoteAttachments: vi.fn(async () => ({
    unsupportedFilenames: [],
    error: null,
    imageUrlByRel: new Map<string, string>(),
  })),
}));
vi.mock("./karakeepInlineImages", () => ({
  rewriteImageEmbedsToAssetUrls: vi.fn((md: string) => md),
}));
vi.mock("./karakeepAssetSync", () => ({ clearPushedAssets: vi.fn() }));

import {
  deriveKarakeepExportFields,
  exportNoteToKarakeep,
} from "./karakeepNoteExport";
import { updateNote } from "./writer";
import {
  attachTags,
  createTextBookmark,
  updateTextBookmark,
  KarakeepError,
} from "./karakeep";
import { pushNoteAttachments } from "./karakeepExport";
import { rewriteImageEmbedsToAssetUrls } from "./karakeepInlineImages";
import { clearPushedAssets } from "./karakeepAssetSync";

const mockUpdateNote = vi.mocked(updateNote);
const mockCreate = vi.mocked(createTextBookmark);
const mockUpdate = vi.mocked(updateTextBookmark);
const mockAttachTags = vi.mocked(attachTags);
const mockPush = vi.mocked(pushNoteAttachments);
const mockRewrite = vi.mocked(rewriteImageEmbedsToAssetUrls);
const mockClear = vi.mocked(clearPushedAssets);

const FILEPATH = "file:///v/Ideas/my-thought.md";

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  mockPush.mockResolvedValue({ error: null, imageUrlByRel: new Map(), unsupportedFilenames: [] });
  mockRewrite.mockImplementation((md: string) => md);
});

describe("deriveKarakeepExportFields", () => {
  it("derives title from the H1 and tags = frontmatter tags + kind, deduped", () => {
    const body =
      "---\ncreated: 2026-01-01T00:00:00.000Z\nkind: idea\ntags: [work, idea]\n---\n# Real Title\n\nBody here.\n";
    const f = deriveKarakeepExportFields(body, FILEPATH, "Entry Title");
    expect(f.title).toBe("Real Title");
    // `idea` appears in both tags and kind → deduped to one.
    expect(f.tags).toEqual(["work", "idea"]);
    expect(f.createdAt).toBe("2026-01-01T00:00:00.000Z");
    expect(f.existingId).toBeNull();
    expect(f.noteBody).toBe("# Real Title\n\nBody here.\n");
  });

  it("falls back to the filename stem when the note has no usable H1", () => {
    const body = "---\nkind: photo\n---\n\n\n";
    const f = deriveKarakeepExportFields(body, FILEPATH, "Entry Title");
    expect(f.title).toBe("my-thought");
    expect(f.tags).toEqual(["photo"]);
    expect(f.createdAt).toBeUndefined();
  });

  it("surfaces a previously-stamped karakeepId", () => {
    const body = "---\nkarakeepId: bm_123\n---\n# T\n";
    expect(deriveKarakeepExportFields(body, FILEPATH, "x").existingId).toBe(
      "bm_123",
    );
  });
});

describe("exportNoteToKarakeep", () => {
  it("creates a fresh bookmark, attaches tags, and stamps the id (first export)", async () => {
    mockCreate.mockResolvedValue({ id: "bm_new" });
    const body = "---\nkind: idea\ntags: [a]\n---\n# Hi\n\nText.\n";
    const out = await exportNoteToKarakeep({
      body,
      filepath: FILEPATH,
      entryTitle: "Hi",
    });
    expect(out.kind).toBe("exported");
    if (out.kind !== "exported") throw new Error("unreachable");
    expect(out.didUpdate).toBe(false);
    expect(mockCreate).toHaveBeenCalledWith({
      text: "# Hi\n\nText.\n",
      title: "Hi",
      createdAt: undefined,
    });
    expect(mockAttachTags).toHaveBeenCalledWith("bm_new", ["a", "idea"]);
    expect(out.nextBody).toContain("karakeepId: bm_new");
    expect(mockUpdateNote).toHaveBeenCalledWith(FILEPATH, out.nextBody);
  });

  it("updates the existing bookmark in place when a karakeepId is present", async () => {
    mockUpdate.mockResolvedValue({ id: "bm_old" });
    const body = "---\nkarakeepId: bm_old\nkind: idea\n---\n# Hi\n";
    const out = await exportNoteToKarakeep({
      body,
      filepath: FILEPATH,
      entryTitle: "Hi",
    });
    expect(out.kind).toBe("exported");
    if (out.kind !== "exported") throw new Error("unreachable");
    expect(out.didUpdate).toBe(true);
    expect(mockUpdate).toHaveBeenCalledWith("bm_old", {
      text: "# Hi\n",
      title: "Hi",
      createdAt: undefined,
    });
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("recovers from a 404 on update by creating a fresh bookmark + clearing the stale sync record", async () => {
    mockUpdate.mockRejectedValueOnce(new KarakeepError("gone", 404));
    mockCreate.mockResolvedValue({ id: "bm_fresh" });
    const body = "---\nkarakeepId: bm_dead\nkind: idea\n---\n# Hi\n";
    const out = await exportNoteToKarakeep({
      body,
      filepath: FILEPATH,
      entryTitle: "Hi",
    });
    expect(out.kind).toBe("exported");
    if (out.kind !== "exported") throw new Error("unreachable");
    // A recovered create reads as a create, not an update.
    expect(out.didUpdate).toBe(false);
    expect(mockCreate).toHaveBeenCalledWith({
      text: "# Hi\n",
      title: "Hi",
      createdAt: undefined,
    });
    expect(mockClear).toHaveBeenCalledWith("bm_dead");
    expect(out.nextBody).toContain("karakeepId: bm_fresh");
  });

  it("rethrows a non-404 update error as a failed outcome (no fallback create)", async () => {
    mockUpdate.mockRejectedValueOnce(new KarakeepError("server boom", 500));
    const body = "---\nkarakeepId: bm_old\n---\n# Hi\n";
    const out = await exportNoteToKarakeep({
      body,
      filepath: FILEPATH,
      entryTitle: "Hi",
    });
    expect(out).toEqual({
      kind: "failed",
      reason: "server boom",
      unreachable: false,
    });
    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockUpdateNote).not.toHaveBeenCalled();
  });

  it("flags a status-0 network failure as unreachable (queue for connectivity retry)", async () => {
    mockCreate.mockRejectedValueOnce(
      new KarakeepError("Karakeep request timed out after 20s", 0),
    );
    const out = await exportNoteToKarakeep({
      body: "---\nkind: idea\n---\n# Hi\n",
      filepath: FILEPATH,
      entryTitle: "Hi",
    });
    expect(out).toEqual({
      kind: "failed",
      reason: "Karakeep request timed out after 20s",
      unreachable: true,
    });
  });

  it("does NOT flag a not-configured status-0 error as unreachable", async () => {
    const err = new KarakeepError("Karakeep URL is not set", 0);
    (err as unknown as { notConfigured: boolean }).notConfigured = true;
    mockCreate.mockRejectedValueOnce(err);
    const out = await exportNoteToKarakeep({
      body: "---\nkind: idea\n---\n# Hi\n",
      filepath: FILEPATH,
      entryTitle: "Hi",
    });
    expect(out.kind).toBe("failed");
    if (out.kind !== "failed") throw new Error("unreachable");
    expect(out.unreachable).toBe(false);
  });

  it("returns a partial outcome (still stamped) when an attachment push fails", async () => {
    mockCreate.mockResolvedValue({ id: "bm_new" });
    mockPush.mockResolvedValue({
      error: "upload failed",
      imageUrlByRel: new Map(),
      unsupportedFilenames: [],
    });
    const body = "---\nkind: idea\n---\n# Hi\n";
    const out = await exportNoteToKarakeep({
      body,
      filepath: FILEPATH,
      entryTitle: "Hi",
    });
    expect(out.kind).toBe("partial");
    if (out.kind !== "partial") throw new Error("unreachable");
    expect(out.assetError).toBe("upload failed");
    // The note is still stamped so a re-export updates rather than duplicates.
    expect(out.nextBody).toContain("karakeepId: bm_new");
    expect(mockUpdateNote).toHaveBeenCalledWith(FILEPATH, out.nextBody);
  });

  it("stays a full 'exported' success when files were only skipped as unsupported types", async () => {
    mockCreate.mockResolvedValue({ id: "bm_new" });
    mockPush.mockResolvedValue({
      error: null,
      imageUrlByRel: new Map(),
      unsupportedFilenames: ["report.docx", "notes.txt"],
    });
    const out = await exportNoteToKarakeep({
      body: "---\nkind: idea\n---\n# Hi\n",
      filepath: FILEPATH,
      entryTitle: "Hi",
    });
    // Unsupported types are an informational skip, NOT a partial failure.
    expect(out.kind).toBe("exported");
    if (out.kind !== "exported") throw new Error("unreachable");
    expect(out.skippedUnsupported).toEqual(["report.docx", "notes.txt"]);
    expect(out.nextBody).toContain("karakeepId: bm_new");
  });

  it("carries unsupported skips alongside a real partial failure", async () => {
    mockCreate.mockResolvedValue({ id: "bm_new" });
    mockPush.mockResolvedValue({
      error: "upload failed",
      imageUrlByRel: new Map(),
      unsupportedFilenames: ["report.docx"],
    });
    const out = await exportNoteToKarakeep({
      body: "---\nkind: idea\n---\n# Hi\n",
      filepath: FILEPATH,
      entryTitle: "Hi",
    });
    expect(out.kind).toBe("partial");
    if (out.kind !== "partial") throw new Error("unreachable");
    expect(out.assetError).toBe("upload failed");
    expect(out.skippedUnsupported).toEqual(["report.docx"]);
  });

  it("PATCHes the inlined body only when rewriting changed the text, and never fails the export on an inline PATCH error", async () => {
    mockCreate.mockResolvedValue({ id: "bm_new" });
    mockPush.mockResolvedValue({
      error: null,
      imageUrlByRel: new Map([["../Photos/x.jpg", "/api/assets/a1"]]),
      unsupportedFilenames: [],
    });
    mockRewrite.mockReturnValue("# Hi\n\n![](/api/assets/a1)\n");
    mockUpdate.mockRejectedValueOnce(new Error("inline patch boom"));
    const body = "---\nkind: idea\n---\n# Hi\n\n![](../Photos/x.jpg)\n";
    const out = await exportNoteToKarakeep({
      body,
      filepath: FILEPATH,
      entryTitle: "Hi",
    });
    // Inline PATCH failed but the export still succeeds + stamps.
    expect(out.kind).toBe("exported");
    expect(mockUpdate).toHaveBeenCalledWith("bm_new", {
      text: "# Hi\n\n![](/api/assets/a1)\n",
      title: "Hi",
      createdAt: undefined,
    });
  });
});
