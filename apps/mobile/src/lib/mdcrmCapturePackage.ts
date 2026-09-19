/**
 * Schema-v1 Markdown capture packages written by the mobile app.
 *
 * This is deliberately an adapter beside the existing People-note writer:
 * server-side mdcrm consumes the package, while Carnet keeps its current
 * human-oriented note unchanged. The original image and unmodified OCR are
 * durable source material; extracted contacts remain server-side decisions.
 */
import * as Crypto from "expo-crypto";
import SHA256 from "crypto-js/sha256";
import Base64 from "crypto-js/enc-base64";
import Hex from "crypto-js/enc-hex";

import { extFromMime, updateNote, writeBinary, writeTextFile } from "./writer";
import { resolveRoot, type Root } from "./vaultRoot";

const CROCKFORD32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export interface BusinessCardCapture {
  captureId: string;
  attachmentId: string;
  rawOcrPath: string;
}

export interface SaveBusinessCardCaptureInput {
  imageBase64: string;
  mimeType: string;
  rawOcrText?: string;
  capturedBy?: string;
  capturedAt?: Date;
  /** Immutable root captured when the photo was taken, when supplied. */
  rootOverride?: Root;
}

/** Generate a sortable ULID with 80 bits of platform CSPRNG entropy. */
export async function createMdcrmId(
  prefix: "capture" | "attachment",
  now = Date.now(),
): Promise<string> {
  const random = await Crypto.getRandomBytesAsync(10);
  return `${prefix === "capture" ? "cap" : "att"}_${encodeTime(now)}${encodeRandom(random)}`;
}

/** SHA-256 over the original decoded image bytes, not over its base64 text. */
export function sha256Base64Bytes(base64: string): string {
  return SHA256(Base64.parse(base64)).toString(Hex);
}

/**
 * Persist a standalone mdcrm capture package. The original and raw OCR are
 * written before the capture record, so a valid record never points to files
 * that this method has not finished writing.
 */
export async function saveBusinessCardCapture(
  input: SaveBusinessCardCaptureInput,
): Promise<BusinessCardCapture> {
  // Resolve exactly once: a profile switch while the original, OCR sidecar,
  // and capture record are being written must not split one package across
  // roots. Higher-level capture contexts will supply the same contract for
  // all capture modes; this package is already self-contained.
  const root = input.rootOverride ?? await resolveRoot();
  const capturedAt = input.capturedAt ?? new Date();
  const captureId = await createMdcrmId("capture", capturedAt.getTime());
  const attachmentId = await createMdcrmId("attachment", capturedAt.getTime());
  const extension = extFromMime(input.mimeType);
  const image = await writeBinary(
    "attachments/originals",
    `${attachmentId}.${extension}`,
    input.imageBase64,
    input.mimeType,
    root,
  );
  const rawOcr = await writeTextFile(
    "processing/results",
    `${captureId}.ocr.txt`,
    input.rawOcrText ?? "",
    root,
  );
  const markdown = renderBusinessCardCapture({
    captureId,
    attachmentId,
    attachmentName: image.finalName,
    mimeType: input.mimeType,
    sha256: sha256Base64Bytes(input.imageBase64),
    rawOcrName: rawOcr.finalName,
    capturedAt,
    capturedBy: input.capturedBy ?? "carnet-mobile",
  });
  await writeTextFile("captures", `${captureId}.md`, markdown, root);
  return { captureId, attachmentId, rawOcrPath: rawOcr.filepath };
}

/** Write the exact OCR response to the already-created raw OCR sidecar. */
export async function saveRawOcrResult(capture: BusinessCardCapture, rawText: string): Promise<void> {
  await updateNote(capture.rawOcrPath, rawText);
}

interface RenderInput {
  captureId: string;
  attachmentId: string;
  attachmentName: string;
  mimeType: string;
  sha256: string;
  rawOcrName: string;
  capturedAt: Date;
  capturedBy: string;
}

export function renderBusinessCardCapture(input: RenderInput): string {
  const timestamp = input.capturedAt.toISOString();
  return `---
schema_version: 1
type: capture
id: ${input.captureId}
created_at: ${timestamp}
updated_at: ${timestamp}
captured_by: ${yamlString(input.capturedBy)}
capture_method: camera
capture_kind: business_card
processing_status: captured
review_status: unreviewed
attachments:
  - id: ${input.attachmentId}
    role: original
    path: ../attachments/originals/${input.attachmentName}
    media_type: ${yamlString(input.mimeType)}
    sha256: ${input.sha256}
ocr:
  engine: configured-vision-provider
  engine_version: unknown
  raw_text_path: ../processing/results/${input.rawOcrName}
sync:
  state: local_only
  attempts: 0
  last_attempt_at:
  remote_revision:
---

# Capture

## Raw OCR

Preserved verbatim in the referenced sidecar file.
`;
}

function encodeTime(time: number): string {
  let value = Math.max(0, Math.floor(time));
  let output = "";
  for (let index = 0; index < 10; index += 1) {
    output = CROCKFORD32[value % 32] + output;
    value = Math.floor(value / 32);
  }
  return output;
}

function encodeRandom(bytes: Uint8Array): string {
  let output = "";
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = buffer * 256 + byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      output += CROCKFORD32[Math.floor(buffer / 2 ** bits) % 32];
      buffer %= 2 ** bits;
    }
  }
  return output;
}

function yamlString(value: string): string {
  return JSON.stringify(value);
}
