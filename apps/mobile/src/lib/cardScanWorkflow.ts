import type { CardScanOcrOutcome } from "./cardScanOutcome";
import type { CardClassification } from "./cardClassification";
import type { BusinessCardCapture } from "./mdcrmCapturePackage";

/** A captured image is transient until the user confirms its card suggestion. */
export interface CardPhoto {
  base64: string;
  mimeType: string;
}

export type CardInspection =
  | { kind: "suggest-card"; photo: CardPhoto }
  | { kind: "manual"; reason: Exclude<CardClassification, "card"> | "unavailable" };

export async function inspectBusinessCardPhoto(
  photo: CardPhoto,
  classify: (photo: CardPhoto) => Promise<{ classification: CardClassification }>,
): Promise<CardInspection> {
  try {
    const { classification } = await classify(photo);
    return classification === "card"
      ? { kind: "suggest-card", photo }
      : { kind: "manual", reason: classification };
  } catch {
    // A network/configuration error cannot authorize a card write. The camera
    // stays useful because the caller can offer manual entry or retake.
    return { kind: "manual", reason: "unavailable" };
  }
}

export interface ConfirmedCardCapture {
  kind: "saved";
  capture: BusinessCardCapture;
  text: string;
  ocr: CardScanOcrOutcome;
}

interface CardCaptureDependencies {
  saveCapture: (photo: CardPhoto) => Promise<BusinessCardCapture>;
  ocr: (photo: CardPhoto) => Promise<{ text: string }>;
  saveRawOcr: (capture: BusinessCardCapture, text: string) => Promise<void>;
  classifyOcrError: (error: unknown) => Exclude<CardScanOcrOutcome, { kind: "ok" }>;
}

/**
 * Builds the one permitted transition from a suggestion to a durable package.
 * The promise is memoized so a double tap cannot create duplicate captures.
 */
export function createCardCaptureConfirmation(
  photo: CardPhoto,
  dependencies: CardCaptureDependencies,
): { confirm: () => Promise<ConfirmedCardCapture> } {
  let operation: Promise<ConfirmedCardCapture> | null = null;

  return {
    confirm: () => {
      operation ??= confirmCardCapture(photo, dependencies);
      return operation;
    },
  };
}

async function confirmCardCapture(
  photo: CardPhoto,
  { saveCapture, ocr, saveRawOcr, classifyOcrError }: CardCaptureDependencies,
): Promise<ConfirmedCardCapture> {
  const capture = await saveCapture(photo);
  try {
    const { text } = await ocr(photo);
    await saveRawOcr(capture, text);
    return { kind: "saved", capture, text, ocr: { kind: "ok" } };
  } catch (error: unknown) {
    // saveCapture creates the empty raw sidecar before the package record, so
    // returning this capture preserves the original image for manual recovery.
    return { kind: "saved", capture, text: "", ocr: classifyOcrError(error) };
  }
}
