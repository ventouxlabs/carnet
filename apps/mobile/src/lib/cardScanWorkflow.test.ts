import { describe, expect, it, vi } from "vitest";

import {
  createCardCaptureConfirmation,
  inspectBusinessCardPhoto,
  type CardPhoto,
} from "./cardScanWorkflow";

const photo: CardPhoto = { base64: "photo-bytes", mimeType: "image/jpeg" };
const saved = { captureId: "cap_1", attachmentId: "att_1", rawOcrPath: "file:///raw.txt" };

describe("inspectBusinessCardPhoto", () => {
  it("only suggests a card after a positive classification, without persisting or OCRing", async () => {
    const classify = vi.fn(async () => ({ classification: "card" as const }));

    await expect(inspectBusinessCardPhoto(photo, classify)).resolves.toEqual({
      kind: "suggest-card",
      photo,
    });
    expect(classify).toHaveBeenCalledWith(photo);
  });

  it.each(["not-card", "uncertain"] as const)("keeps %s images on the manual path", async (classification) => {
    await expect(
      inspectBusinessCardPhoto(photo, async () => ({ classification })),
    ).resolves.toEqual({ kind: "manual", reason: classification });
  });

  it("keeps classifier failures on the manual path", async () => {
    await expect(
      inspectBusinessCardPhoto(photo, async () => {
        throw new Error("timeout");
      }),
    ).resolves.toEqual({ kind: "manual", reason: "unavailable" });
  });
});

describe("createCardCaptureConfirmation", () => {
  it("does not write or OCR until the user confirms the suggestion", async () => {
    const saveCapture = vi.fn(async () => saved);
    const ocr = vi.fn(async () => ({ text: "Jane Doe" }));
    const saveRawOcr = vi.fn(async () => {});
    const confirmation = createCardCaptureConfirmation(photo, { saveCapture, ocr, saveRawOcr });

    expect(saveCapture).not.toHaveBeenCalled();
    expect(ocr).not.toHaveBeenCalled();
    expect(saveRawOcr).not.toHaveBeenCalled();

    await expect(confirmation.confirm()).resolves.toEqual({
      kind: "saved",
      capture: saved,
      text: "Jane Doe",
      ocr: { kind: "ok" },
    });
    expect(saveCapture).toHaveBeenCalledWith(photo);
    expect(ocr).toHaveBeenCalledWith(photo);
    expect(saveRawOcr).toHaveBeenCalledWith(saved, "Jane Doe");
  });

  it("returns the saved original if OCR fails and does not overwrite the raw sidecar", async () => {
    const saveRawOcr = vi.fn(async () => {});
    const confirmation = createCardCaptureConfirmation(photo, {
      saveCapture: async () => saved,
      ocr: async () => {
        throw new Error("network down");
      },
      saveRawOcr,
    });

    await expect(confirmation.confirm()).resolves.toMatchObject({
      kind: "saved",
      capture: saved,
      text: "",
      ocr: { kind: "transient", message: "network down" },
    });
    expect(saveRawOcr).not.toHaveBeenCalled();
  });

  it("makes a double confirmation one idempotent capture", async () => {
    const saveCapture = vi.fn(async () => saved);
    const confirmation = createCardCaptureConfirmation(photo, {
      saveCapture,
      ocr: async () => ({ text: "Jane Doe" }),
      saveRawOcr: async () => {},
    });

    await Promise.all([confirmation.confirm(), confirmation.confirm()]);
    expect(saveCapture).toHaveBeenCalledTimes(1);
  });
});
