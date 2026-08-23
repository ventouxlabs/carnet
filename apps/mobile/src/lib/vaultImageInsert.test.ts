// Copyright (C) 2025 Ventoux Advisory, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./attachments", () => ({ pickAttachment: vi.fn() }));
vi.mock("./writer", () => ({
  extFromMime: vi.fn(() => "jpg"),
  slugify: vi.fn((s: string) => s.toLowerCase().replace(/\s+/g, "-")),
  writeBinary: vi.fn(),
}));
vi.mock("./editorImages", () => ({
  MAX_EDITOR_IMAGE_BASE64: 100,
  toDataUri: vi.fn((mime: string, b64: string) => `data:${mime};base64,${b64}`),
}));
import { pickAndWriteVaultImage, writeCapturedVaultImage } from "./vaultImageInsert";
import { pickAttachment } from "./attachments";
import { writeBinary } from "./writer";

const mockPick = vi.mocked(pickAttachment);
const mockWrite = vi.mocked(writeBinary);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("pickAndWriteVaultImage", () => {
  it("returns null when the user cancels the picker (nothing written)", async () => {
    mockPick.mockResolvedValue(null);
    expect(await pickAndWriteVaultImage()).toBeNull();
    expect(mockWrite).not.toHaveBeenCalled();
  });

  it("writes the image to Photos/ and returns the rel + a preview data URI under the cap", async () => {
    mockPick.mockResolvedValue({
      base64: "AB",
      mime: "image/jpeg",
      filename: "My Photo.jpeg",
      kind: "image",
    });
    mockWrite.mockResolvedValue({ filepath: "x", finalName: "my-photo.jpg" });
    const out = await pickAndWriteVaultImage();
    expect(mockWrite).toHaveBeenCalledWith("Photos", "my-photo.jpg", "AB", "image/jpeg");
    expect(out).toEqual({
      rel: "../Photos/my-photo.jpg",
      dataUri: "data:image/jpeg;base64,AB",
    });
  });

  it("returns a null data URI when the image is over the inline cap", async () => {
    mockPick.mockResolvedValue({
      base64: "X".repeat(200), // over MAX_EDITOR_IMAGE_BASE64 (100)
      mime: "image/png",
      filename: "big.png",
      kind: "image",
    });
    mockWrite.mockResolvedValue({ filepath: "x", finalName: "big.png" });
    const out = await pickAndWriteVaultImage();
    expect(out?.rel).toBe("../Photos/big.png");
    expect(out?.dataUri).toBeNull();
  });

  it("falls back to 'image' as the slug base when the name slugifies to nothing", async () => {
    mockPick.mockResolvedValue({
      base64: "AB",
      mime: "image/jpeg",
      filename: ".jpeg",
      kind: "image",
    });
    mockWrite.mockResolvedValue({ filepath: "x", finalName: "image.jpg" });
    await pickAndWriteVaultImage();
    expect(mockWrite).toHaveBeenCalledWith("Photos", "image.jpg", "AB", "image/jpeg");
  });
});

describe("writeCapturedVaultImage", () => {
  it("writes captured bytes to Photos/ under a timestamped default basename", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1700000000000);
    mockWrite.mockResolvedValue({ filepath: "x", finalName: "photo-1700000000000.jpg" });
    const out = await writeCapturedVaultImage("AB", "image/jpeg");
    expect(mockWrite).toHaveBeenCalledWith(
      "Photos",
      "photo-1700000000000.jpg",
      "AB",
      "image/jpeg",
    );
    expect(out).toEqual({
      rel: "../Photos/photo-1700000000000.jpg",
      dataUri: "data:image/jpeg;base64,AB",
    });
    // The camera never opens the picker on this path.
    expect(mockPick).not.toHaveBeenCalled();
  });

  it("gives two basename-less captures distinct filenames", async () => {
    // The only caller passes no basename, so a fixed stem would funnel every
    // camera shot in a vault through writeBinary's finite suffix range.
    const now = vi.spyOn(Date, "now");
    mockWrite.mockResolvedValue({ filepath: "x", finalName: "whatever.jpg" });

    now.mockReturnValue(1700000000000);
    await writeCapturedVaultImage("AB", "image/jpeg");
    now.mockReturnValue(1700000009999);
    await writeCapturedVaultImage("AB", "image/jpeg");

    const [first, second] = mockWrite.mock.calls.map((c) => c[1]);
    expect(first).not.toBe(second);
  });

  it("returns writeBinary's collision-bumped name, not the requested one", async () => {
    // A second capture in the same millisecond must link the file SAF actually
    // created — otherwise the embed points at the first shot.
    vi.spyOn(Date, "now").mockReturnValue(1700000000000);
    mockWrite.mockResolvedValue({ filepath: "x", finalName: "photo-2.jpg" });
    const out = await writeCapturedVaultImage("AB", "image/jpeg");
    expect(out.rel).toBe("../Photos/photo-2.jpg");
  });

  it("slugifies a supplied basename and strips its extension", async () => {
    mockWrite.mockResolvedValue({ filepath: "x", finalName: "my-shot.jpg" });
    await writeCapturedVaultImage("AB", "image/jpeg", "My Shot.jpeg");
    expect(mockWrite).toHaveBeenCalledWith("Photos", "my-shot.jpg", "AB", "image/jpeg");
  });

  it("falls back to 'photo' when the basename slugifies to nothing", async () => {
    mockWrite.mockResolvedValue({ filepath: "x", finalName: "photo.jpg" });
    await writeCapturedVaultImage("AB", "image/jpeg", ".jpeg");
    expect(mockWrite).toHaveBeenCalledWith("Photos", "photo.jpg", "AB", "image/jpeg");
  });

  it("omits the preview data URI when the capture is over the inline cap", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1700000000000);
    mockWrite.mockResolvedValue({ filepath: "x", finalName: "photo.jpg" });
    const out = await writeCapturedVaultImage("X".repeat(200), "image/jpeg");
    expect(out.rel).toBe("../Photos/photo.jpg");
    expect(out.dataUri).toBeNull();
  });
});
