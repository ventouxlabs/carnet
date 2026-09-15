import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("expo-crypto", () => ({
  getRandomBytesAsync: async () => new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]),
}));

const writeBinary = vi.fn();
const writeTextFile = vi.fn();
const updateNote = vi.fn();
const root = { uri: "file:///vault", fs: {} };
vi.mock("./writer", () => ({
  extFromMime: (mime: string) => mime === "image/jpeg" ? "jpg" : "bin",
  writeBinary: (...args: unknown[]) => writeBinary(...args),
  writeTextFile: (...args: unknown[]) => writeTextFile(...args),
  updateNote: (...args: unknown[]) => updateNote(...args),
}));
vi.mock("./vaultRoot", () => ({
  resolveRoot: async () => root,
}));

import {
  createMdcrmId,
  renderBusinessCardCapture,
  saveBusinessCardCapture,
  saveRawOcrResult,
  sha256Base64Bytes,
} from "./mdcrmCapturePackage";

beforeEach(() => {
  writeBinary.mockReset().mockResolvedValue({ filepath: "file:///vault/attachments/originals/card.jpg", finalName: "card.jpg" });
  writeTextFile.mockReset()
    .mockResolvedValueOnce({ filepath: "file:///vault/processing/results/card.ocr.txt", finalName: "card.ocr.txt" })
    .mockResolvedValueOnce({ filepath: "file:///vault/captures/card.md", finalName: "card.md" });
  updateNote.mockReset().mockResolvedValue(undefined);
});

describe("mdcrm capture package", () => {
  it("creates prefixed, sortable ULIDs from a CSPRNG", async () => {
    await expect(createMdcrmId("capture", 0)).resolves.toBe("cap_0000000000000G40R40M30E209");
    await expect(createMdcrmId("attachment", 1_754_222_400_000)).resolves.toMatch(/^att_[0-9A-HJKMNPQRSTVWXYZ]{26}$/);
  });

  it("hashes decoded bytes rather than the base64 representation", () => {
    expect(sha256Base64Bytes("YWJj")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  it("writes original, verbatim OCR sidecar, then a valid capture record", async () => {
    const capture = await saveBusinessCardCapture({
      imageBase64: "YWJj", mimeType: "image/jpeg", rawOcrText: "JANE SMlTH\n", capturedAt: new Date("2026-08-03T11:22:00.000Z"),
    });
    expect(writeBinary).toHaveBeenCalledWith("attachments/originals", expect.stringMatching(/^att_.*\.jpg$/), "YWJj", "image/jpeg", root);
    expect(writeTextFile).toHaveBeenNthCalledWith(1, "processing/results", expect.stringMatching(/^cap_.*\.ocr\.txt$/), "JANE SMlTH\n", root);
    expect(writeTextFile).toHaveBeenNthCalledWith(2, "captures", expect.stringMatching(/^cap_.*\.md$/), expect.any(String), root);
    const markdown = writeTextFile.mock.calls[1]?.[2] as string;
    expect(markdown).toContain("type: capture");
    expect(markdown).toContain("path: ../attachments/originals/card.jpg");
    expect(markdown).toContain("sha256: ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(capture.captureId).toMatch(/^cap_/);
    await saveRawOcrResult(capture, "raw response");
    expect(updateNote).toHaveBeenCalledWith("file:///vault/processing/results/card.ocr.txt", "raw response");
  });

  it("renders portable relative references", () => {
    const markdown = renderBusinessCardCapture({
      captureId: "cap_01K1V8FQ73P2N6TQ84D7KZ19BC", attachmentId: "att_01K1V8FQ73P2N6TQ84D7KZ19BC",
      attachmentName: "card.jpg", mimeType: "image/jpeg", sha256: "a".repeat(64), rawOcrName: "card.ocr.txt",
      capturedAt: new Date("2026-08-03T11:22:00.000Z"), capturedBy: "device-a",
    });
    expect(markdown).toContain("raw_text_path: ../processing/results/card.ocr.txt");
    expect(markdown).toContain("sync:\n  state: local_only");
  });
});
