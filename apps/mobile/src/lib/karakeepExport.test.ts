// Copyright (C) 2025 Ventoux Labs
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock the writer (vault resolution) and the karakeep network client so the
// orchestration logic — which links get uploaded, in what order, and how a
// failure short-circuits — is tested in isolation.
vi.mock("./writer", () => ({
  listPairedBinaries: vi.fn(),
  resolvePairedUri: vi.fn(),
}));
vi.mock("./karakeep", () => ({
  uploadAsset: vi.fn(),
  attachAssetToBookmark: vi.fn(),
  BANNER_ASSET_TYPE: "bannerImage",
  // Real (pure) URL builder so the inline-URL map assertions are meaningful.
  assetContentPath: (id: string) => `/api/assets/${encodeURIComponent(id)}`,
}));
// Mock the sync-record store so the orchestration logic — which links get
// uploaded, in what order, what gets recorded, how failures short-circuit — is
// tested in isolation. assetKey stays the real (pure) join.
vi.mock("./karakeepAssetSync", () => ({
  assetKey: (subdir: string, filename: string) => `${subdir}/${filename}`,
  loadPushedAssets: vi.fn(),
  savePushedAssets: vi.fn(),
}));

import {
  isUnsupportedAssetTypeError,
  pushNoteAttachments,
} from "./karakeepExport";
import { listPairedBinaries, resolvePairedUri } from "./writer";
import { uploadAsset, attachAssetToBookmark } from "./karakeep";
import { loadPushedAssets, savePushedAssets } from "./karakeepAssetSync";

const mockList = vi.mocked(listPairedBinaries);
const mockResolve = vi.mocked(resolvePairedUri);
const mockUpload = vi.mocked(uploadAsset);
const mockAttach = vi.mocked(attachAssetToBookmark);
const mockLoadPushed = vi.mocked(loadPushedAssets);
const mockSavePushed = vi.mocked(savePushedAssets);

function link(subdir: "Photos" | "Files" | "Audio", filename: string) {
  return { subdir, filename, rel: `../${subdir}/${filename}` };
}

beforeEach(() => {
  vi.clearAllMocks();
  // Default happy resolutions/uploads; per-test overrides where needed.
  mockResolve.mockImplementation(async (subdir: string, filename: string) => ({
    uri: `file:///vault/${subdir}/${filename}`,
    mime: filename.endsWith(".pdf") ? "application/pdf" : "image/jpeg",
  }));
  let n = 0;
  mockUpload.mockImplementation(async () => ({ assetId: `as_${++n}` }));
  mockAttach.mockResolvedValue(undefined);
  // Default: nothing synced yet for this bookmark.
  mockLoadPushed.mockResolvedValue(new Map());
  mockSavePushed.mockResolvedValue(undefined);
});

describe("pushNoteAttachments", () => {
  it("uploads + attaches each non-Audio attachment; returns no error and the image URL map", async () => {
    mockList.mockReturnValue([link("Photos", "a.jpg"), link("Files", "b.pdf")]);

    const result = await pushNoteAttachments("bk_1", "body");

    expect(result.error).toBeNull();
    // Only the IMAGE is in the inline map (Files are attached, not inlined).
    expect(result.imageUrlByRel).toEqual(
      new Map([["../Photos/a.jpg", "/api/assets/as_1"]]),
    );
    expect(mockUpload).toHaveBeenCalledTimes(2);
    expect(mockUpload).toHaveBeenNthCalledWith(1, {
      uri: "file:///vault/Photos/a.jpg",
      mime: "image/jpeg",
      filename: "a.jpg",
    });
    // First image → bannerImage (the Karakeep cover); the Files attachment →
    // default userUploaded (2-arg call).
    expect(mockAttach).toHaveBeenNthCalledWith(1, "bk_1", "as_1", "bannerImage");
    expect(mockAttach).toHaveBeenNthCalledWith(2, "bk_1", "as_2");
  });

  it("attaches only the FIRST image as bannerImage; later images stay userUploaded", async () => {
    mockList.mockReturnValue([
      link("Files", "doc.pdf"),
      link("Photos", "a.jpg"),
      link("Photos", "b.jpg"),
    ]);

    const result = await pushNoteAttachments("bk_1", "body");

    // doc.pdf (not an image) → default; a.jpg (first image) → bannerImage;
    // b.jpg (second image) → default.
    expect(mockAttach).toHaveBeenNthCalledWith(1, "bk_1", "as_1");
    expect(mockAttach).toHaveBeenNthCalledWith(2, "bk_1", "as_2", "bannerImage");
    expect(mockAttach).toHaveBeenNthCalledWith(3, "bk_1", "as_3");
    // Both images inlined (doc.pdf is not).
    expect(result.imageUrlByRel).toEqual(
      new Map([
        ["../Photos/a.jpg", "/api/assets/as_2"],
        ["../Photos/b.jpg", "/api/assets/as_3"],
      ]),
    );
  });

  it("skips Audio links entirely (never resolves or uploads them)", async () => {
    mockList.mockReturnValue([link("Audio", "voice.m4a"), link("Photos", "a.jpg")]);

    await pushNoteAttachments("bk_1", "body");

    expect(mockResolve).toHaveBeenCalledOnce();
    expect(mockResolve).toHaveBeenCalledWith("Photos", "a.jpg");
    expect(mockUpload).toHaveBeenCalledOnce();
  });

  it("skips broken links (resolve returns null) without uploading", async () => {
    mockList.mockReturnValue([link("Photos", "gone.jpg"), link("Files", "ok.pdf")]);
    mockResolve.mockImplementation(async (subdir: string, filename: string) =>
      filename === "gone.jpg"
        ? null
        : { uri: `file:///vault/${subdir}/${filename}`, mime: "application/pdf" },
    );

    const result = await pushNoteAttachments("bk_1", "body");

    expect(result.error).toBeNull();
    // The broken image isn't inlined (no asset).
    expect(result.imageUrlByRel).toEqual(new Map());
    expect(mockUpload).toHaveBeenCalledOnce();
    expect(mockUpload).toHaveBeenCalledWith({
      uri: "file:///vault/Files/ok.pdf",
      mime: "application/pdf",
      filename: "ok.pdf",
    });
  });

  it("returns the error message and stops at the first failed upload", async () => {
    mockList.mockReturnValue([link("Photos", "a.jpg"), link("Photos", "b.jpg")]);
    mockUpload.mockRejectedValueOnce(new Error("Karakeep error — HTTP 413"));

    const result = await pushNoteAttachments("bk_1", "body");

    expect(result.error).toBe("Karakeep error — HTTP 413");
    expect(result.imageUrlByRel).toEqual(new Map()); // nothing synced before the failure
    expect(mockUpload).toHaveBeenCalledOnce(); // did not attempt the second
    expect(mockAttach).not.toHaveBeenCalled();
  });

  it("skips an unsupported-type 400 and keeps pushing the remaining attachments", async () => {
    mockList.mockReturnValue([link("Files", "report.docx"), link("Photos", "a.jpg")]);
    mockUpload.mockImplementation(async (input) => {
      if (input.filename === "report.docx") {
        throw Object.assign(
          new Error("Karakeep error — HTTP 400: Unsupported asset type"),
          { status: 400 },
        );
      }
      return { assetId: "as_img" };
    });

    const result = await pushNoteAttachments("bk_1", "body");

    // Not an error: the export succeeded, the docx just stays vault-only.
    expect(result.error).toBeNull();
    expect(result.unsupportedFilenames).toEqual(["report.docx"]);
    // The image AFTER the unsupported file still synced.
    expect(mockAttach).toHaveBeenCalledOnce();
    expect(result.imageUrlByRel).toEqual(
      new Map([["../Photos/a.jpg", "/api/assets/as_img"]]),
    );
    // The skipped file is NOT recorded — a server that later accepts the type
    // gets it on a subsequent export.
    expect(mockSavePushed).toHaveBeenCalledOnce();
    expect(mockSavePushed).toHaveBeenCalledWith(
      "bk_1",
      new Map([["Photos/a.jpg", "as_img"]]),
    );
  });

  it("a real failure still stops the loop, reporting the skips collected so far", async () => {
    mockList.mockReturnValue([
      link("Files", "report.docx"),
      link("Photos", "a.jpg"),
      link("Photos", "b.jpg"),
    ]);
    mockUpload.mockImplementation(async (input) => {
      if (input.filename === "report.docx") {
        throw Object.assign(
          new Error("Karakeep error — HTTP 400: Unsupported asset type"),
          { status: 400 },
        );
      }
      throw new Error("Karakeep unreachable — timed out after 45s");
    });

    const result = await pushNoteAttachments("bk_1", "body");

    expect(result.error).toBe("Karakeep unreachable — timed out after 45s");
    expect(result.unsupportedFilenames).toEqual(["report.docx"]);
    expect(mockUpload).toHaveBeenCalledTimes(2); // b.jpg never attempted
  });

  it("returns the error when an attach fails (after a successful upload)", async () => {
    mockList.mockReturnValue([link("Photos", "a.jpg"), link("Photos", "b.jpg")]);
    mockAttach.mockRejectedValueOnce(new Error("attach failed"));

    const result = await pushNoteAttachments("bk_1", "body");

    expect(result.error).toBe("attach failed");
    expect(mockUpload).toHaveBeenCalledOnce();
  });

  it("returns no error and makes no network calls when there are no attachments", async () => {
    mockList.mockReturnValue([]);

    const result = await pushNoteAttachments("bk_1", "body");

    expect(result.error).toBeNull();
    expect(result.imageUrlByRel).toEqual(new Map());
    expect(mockResolve).not.toHaveBeenCalled();
    expect(mockUpload).not.toHaveBeenCalled();
    expect(mockAttach).not.toHaveBeenCalled();
  });

  // ── Incremental sync ────────────────────────────────────────────────────────

  it("loads the pushed-asset record for the bookmark being exported", async () => {
    mockList.mockReturnValue([]);

    await pushNoteAttachments("bk_42", "body");

    expect(mockLoadPushed).toHaveBeenCalledWith("bk_42");
  });

  it("skips an already-synced attachment but still inlines it from its recorded assetId", async () => {
    mockList.mockReturnValue([link("Photos", "a.jpg"), link("Files", "b.pdf")]);
    mockLoadPushed.mockResolvedValue(new Map([["Photos/a.jpg", "as_existing"]]));

    const result = await pushNoteAttachments("bk_1", "body");

    expect(result.error).toBeNull();
    // a.jpg not re-uploaded, but its recorded assetId drives the inline URL so a
    // re-export keeps the image embedded.
    expect(result.imageUrlByRel).toEqual(
      new Map([["../Photos/a.jpg", "/api/assets/as_existing"]]),
    );
    expect(mockUpload).toHaveBeenCalledOnce();
    expect(mockUpload).toHaveBeenCalledWith({
      uri: "file:///vault/Files/b.pdf",
      mime: "application/pdf",
      filename: "b.pdf",
    });
    expect(mockAttach).toHaveBeenCalledOnce();
    expect(mockAttach).toHaveBeenCalledWith("bk_1", "as_1");
  });

  it("re-uploads a legacy entry whose recorded assetId is empty", async () => {
    mockList.mockReturnValue([link("Photos", "a.jpg")]);
    // Legacy v1 record: key present, assetId unknown ("").
    mockLoadPushed.mockResolvedValue(new Map([["Photos/a.jpg", ""]]));

    const result = await pushNoteAttachments("bk_1", "body");

    expect(mockUpload).toHaveBeenCalledOnce();
    expect(result.imageUrlByRel).toEqual(
      new Map([["../Photos/a.jpg", "/api/assets/as_1"]]),
    );
    expect(mockSavePushed).toHaveBeenCalledWith(
      "bk_1",
      new Map([["Photos/a.jpg", "as_1"]]),
    );
  });

  it("uploads nothing but still inlines recorded images when everything is already synced", async () => {
    mockList.mockReturnValue([link("Photos", "a.jpg"), link("Files", "b.pdf")]);
    mockLoadPushed.mockResolvedValue(
      new Map([
        ["Photos/a.jpg", "as_old1"],
        ["Files/b.pdf", "as_old2"],
      ]),
    );

    const result = await pushNoteAttachments("bk_1", "body");

    expect(result.error).toBeNull();
    expect(result.imageUrlByRel).toEqual(
      new Map([["../Photos/a.jpg", "/api/assets/as_old1"]]),
    );
    expect(mockResolve).not.toHaveBeenCalled();
    expect(mockUpload).not.toHaveBeenCalled();
    expect(mockSavePushed).not.toHaveBeenCalled();
  });

  it("records each attachment key→assetId after its successful attach (cumulative)", async () => {
    mockList.mockReturnValue([link("Photos", "a.jpg"), link("Files", "b.pdf")]);

    await pushNoteAttachments("bk_1", "body");

    expect(mockSavePushed).toHaveBeenCalledTimes(2);
    expect(mockSavePushed).toHaveBeenNthCalledWith(
      1,
      "bk_1",
      new Map([["Photos/a.jpg", "as_1"]]),
    );
    expect(mockSavePushed).toHaveBeenNthCalledWith(
      2,
      "bk_1",
      new Map([
        ["Photos/a.jpg", "as_1"],
        ["Files/b.pdf", "as_2"],
      ]),
    );
  });

  it("persists the success before a later failure and leaves the failed key unrecorded", async () => {
    mockList.mockReturnValue([link("Photos", "a.jpg"), link("Photos", "b.jpg")]);
    mockUpload
      .mockImplementationOnce(async () => ({ assetId: "as_1" }))
      .mockRejectedValueOnce(new Error("Karakeep error — HTTP 500"));

    const result = await pushNoteAttachments("bk_1", "body");

    expect(result.error).toBe("Karakeep error — HTTP 500");
    // a.jpg attached → persisted once + inlined; b.jpg failed at upload → neither.
    expect(result.imageUrlByRel).toEqual(
      new Map([["../Photos/a.jpg", "/api/assets/as_1"]]),
    );
    expect(mockSavePushed).toHaveBeenCalledOnce();
    expect(mockSavePushed).toHaveBeenCalledWith(
      "bk_1",
      new Map([["Photos/a.jpg", "as_1"]]),
    );
  });

  it("does not record a broken link, so it retries on a later export", async () => {
    mockList.mockReturnValue([link("Photos", "gone.jpg")]);
    mockResolve.mockResolvedValue(null);

    const result = await pushNoteAttachments("bk_1", "body");

    expect(result.error).toBeNull();
    expect(mockUpload).not.toHaveBeenCalled();
    expect(mockSavePushed).not.toHaveBeenCalled();
  });
});

describe("isUnsupportedAssetTypeError", () => {
  const err = (message: string, status?: number) =>
    Object.assign(new Error(message), status !== undefined ? { status } : {});

  it("matches Karakeep's unsupported-asset-type 400 (case-insensitive)", () => {
    expect(
      isUnsupportedAssetTypeError(
        err("Karakeep error — HTTP 400: Unsupported asset type", 400),
      ),
    ).toBe(true);
    expect(
      isUnsupportedAssetTypeError(err("HTTP 400: UNSUPPORTED ASSET TYPE", 400)),
    ).toBe(true);
  });

  it("rejects the same message on a different status (a 500 is not a type rejection)", () => {
    expect(
      isUnsupportedAssetTypeError(err("Unsupported asset type", 500)),
    ).toBe(false);
    expect(isUnsupportedAssetTypeError(err("Unsupported asset type"))).toBe(false);
  });

  it("rejects other 400s and non-Error values", () => {
    expect(isUnsupportedAssetTypeError(err("HTTP 400: Bad request", 400))).toBe(false);
    expect(isUnsupportedAssetTypeError("Unsupported asset type")).toBe(false);
    expect(isUnsupportedAssetTypeError(null)).toBe(false);
  });
});
